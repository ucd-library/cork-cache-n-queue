create schema if not exists {{SCHEMA}};

set search_path={{SCHEMA}},public;

-- one row per ip group, doubling as a per-group mutex (every function below
-- locks this row with FOR UPDATE before touching active_request/pending_request)
CREATE TABLE IF NOT EXISTS group_state (
  ip_group      TEXT PRIMARY KEY,
  active_count  INT NOT NULL DEFAULT 0,
  pending_count INT NOT NULL DEFAULT 0,
  last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE group_state ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- one row per in-flight (admitted) request
CREATE TABLE IF NOT EXISTS active_request (
  request_id TEXT PRIMARY KEY,
  ip_group   TEXT NOT NULL,
  created    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS active_request_ip_group_idx ON active_request (ip_group);

-- one row per queued (waiting) request
CREATE TABLE IF NOT EXISTS pending_request (
  request_id TEXT PRIMARY KEY,
  ip_group   TEXT NOT NULL,
  created    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_request_group_created_idx ON pending_request (ip_group, created);

-- attempt to claim an in-flight slot for ip_group_in, atomically capped at max_served_in
CREATE OR REPLACE FUNCTION try_admit(
  request_id_in TEXT, ip_group_in TEXT, max_served_in INT
) RETURNS BOOLEAN AS $$
DECLARE admitted BOOLEAN := FALSE;
BEGIN
  -- retry loop: a concurrent prune_idle_groups can delete the row between the
  -- INSERT and the FOR UPDATE lock below, so keep re-inserting until the lock
  -- actually lands on a row that exists
  LOOP
    INSERT INTO group_state (ip_group) VALUES (ip_group_in) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM group_state WHERE ip_group = ip_group_in FOR UPDATE;
    EXIT WHEN FOUND;
  END LOOP;

  IF (SELECT active_count FROM group_state WHERE ip_group = ip_group_in) < max_served_in THEN
    UPDATE group_state SET active_count = active_count + 1, last_active = NOW() WHERE ip_group = ip_group_in;
    INSERT INTO active_request (request_id, ip_group) VALUES (request_id_in, ip_group_in);
    admitted := TRUE;
  END IF;

  RETURN admitted;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- insert a pending row for ip_group_in if room is available, capped at max_pending_in
CREATE OR REPLACE FUNCTION enqueue_if_room(
  request_id_in TEXT, ip_group_in TEXT, max_pending_in INT
) RETURNS BOOLEAN AS $$
DECLARE enqueued BOOLEAN := FALSE;
BEGIN
  -- retry loop: a concurrent prune_idle_groups can delete the row between the
  -- INSERT and the FOR UPDATE lock below, so keep re-inserting until the lock
  -- actually lands on a row that exists
  LOOP
    INSERT INTO group_state (ip_group) VALUES (ip_group_in) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM group_state WHERE ip_group = ip_group_in FOR UPDATE;
    EXIT WHEN FOUND;
  END LOOP;

  IF (SELECT pending_count FROM group_state WHERE ip_group = ip_group_in) < max_pending_in THEN
    UPDATE group_state SET pending_count = pending_count + 1, last_active = NOW() WHERE ip_group = ip_group_in;
    INSERT INTO pending_request (request_id, ip_group) VALUES (request_id_in, ip_group_in);
    enqueued := TRUE;
  END IF;

  RETURN enqueued;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- release request_id_in's active slot and promote the oldest pending request
-- for ip_group_in (if any) into the freed slot
CREATE OR REPLACE FUNCTION release_and_promote(
  request_id_in TEXT, ip_group_in TEXT
) RETURNS TEXT AS $$
DECLARE promoted_id TEXT;
BEGIN
  PERFORM 1 FROM group_state WHERE ip_group = ip_group_in FOR UPDATE;

  DELETE FROM active_request WHERE request_id = request_id_in;
  IF FOUND THEN
    -- only decrement if this call actually removed the row: if it was
    -- already removed by a concurrent reconcile_stale (or a duplicate call),
    -- active_count has already been corrected and must not be decremented
    -- again, or it would under-count and let an extra request slip in
    UPDATE group_state SET active_count = GREATEST(active_count - 1, 0), last_active = NOW() WHERE ip_group = ip_group_in;
  END IF;

  SELECT request_id INTO promoted_id FROM pending_request
    WHERE ip_group = ip_group_in ORDER BY created ASC LIMIT 1;

  IF promoted_id IS NOT NULL THEN
    DELETE FROM pending_request WHERE request_id = promoted_id;
    UPDATE group_state
      SET pending_count = GREATEST(pending_count - 1, 0), active_count = active_count + 1, last_active = NOW()
      WHERE ip_group = ip_group_in;
    INSERT INTO active_request (request_id, ip_group) VALUES (promoted_id, ip_group_in);
  END IF;

  RETURN promoted_id;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- remove a pending row, used both for timeout expiry and disconnect cleanup.
-- returns false if the row was already promoted (or already removed) by
-- someone else
CREATE OR REPLACE FUNCTION expire_pending(
  request_id_in TEXT, ip_group_in TEXT
) RETURNS BOOLEAN AS $$
DECLARE removed BOOLEAN := FALSE;
BEGIN
  PERFORM 1 FROM group_state WHERE ip_group = ip_group_in FOR UPDATE;

  DELETE FROM pending_request WHERE request_id = request_id_in;
  IF FOUND THEN
    UPDATE group_state SET pending_count = GREATEST(pending_count - 1, 0), last_active = NOW() WHERE ip_group = ip_group_in;
    removed := TRUE;
  END IF;

  RETURN removed;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- crash-recovery safety net: drop active rows abandoned by a process that died
-- mid-request, and recompute active_count from what actually remains
CREATE OR REPLACE FUNCTION reconcile_stale(stale_ms_in BIGINT) RETURNS INT AS $$
DECLARE removed INT;
BEGIN
  DELETE FROM active_request WHERE created < NOW() - (stale_ms_in || ' milliseconds')::interval;
  GET DIAGNOSTICS removed = ROW_COUNT;

  UPDATE group_state gs SET active_count = COALESCE(sub.cnt, 0), last_active = NOW()
    FROM (SELECT ip_group, COUNT(*) AS cnt FROM active_request GROUP BY ip_group) sub
    WHERE gs.ip_group = sub.ip_group;

  -- only bump last_active for groups actually transitioning to 0; otherwise
  -- this would refresh every already-idle group's timestamp on every sweep
  -- tick and permanently defeat prune_idle_groups below
  UPDATE group_state SET active_count = 0, last_active = NOW()
    WHERE ip_group NOT IN (SELECT ip_group FROM active_request)
      AND active_count <> 0;

  RETURN removed;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- delete group_state rows that have had zero active and zero pending
-- requests for at least idle_ms_in, keeping the table from growing
-- unbounded as new ip groups are seen over time. Safe against a concurrent
-- try_admit/enqueue_if_room re-creating the row immediately after: their
-- retry-loop + ON CONFLICT DO NOTHING means a reappearing group simply gets
-- a fresh row with DEFAULT last_active = NOW() and counts of 0.
CREATE OR REPLACE FUNCTION prune_idle_groups(idle_ms_in BIGINT) RETURNS INT AS $$
DECLARE removed INT;
BEGIN
  DELETE FROM group_state
    WHERE active_count = 0
      AND pending_count = 0
      AND last_active < NOW() - (idle_ms_in || ' milliseconds')::interval;
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN removed;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;
