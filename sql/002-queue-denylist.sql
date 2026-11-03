set search_path={{SCHEMA}},public;

-- one row per ip per UTC calendar day, counting how many times that ip was
-- denied (429'd) by the queue's concurrency-admission gate that day
CREATE TABLE IF NOT EXISTS ip_denial_count (
  ip    TEXT NOT NULL,
  day   DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
-- denormalized CIDR-masked group key (computed in JS via ip-group.js's
-- toGroupKey, same grouping the queue uses for concurrency), carried on
-- every row so a range's distinct-denied-ip count for a day is just
-- `COUNT(*) WHERE ip_group = $1 AND day = $2` against this same table -
-- no separate per-range tracking table needed
ALTER TABLE ip_denial_count ADD COLUMN IF NOT EXISTS ip_group TEXT NOT NULL DEFAULT '';
-- supports prune_ip_denials' "delete everything older than X" sweep, which
-- scans across all ips by day rather than by a specific ip (the PK's
-- (ip, day) column order doesn't help that access pattern - it's built for
-- "WHERE ip = $1 AND day >= $2", not "WHERE day < $1" across all ips)
CREATE INDEX IF NOT EXISTS ip_denial_count_day_idx ON ip_denial_count (day);
-- supports record_ip_denial's per-range distinct-ip count for today
CREATE INDEX IF NOT EXISTS ip_denial_count_group_day_idx ON ip_denial_count (ip_group, day);

-- one row per currently-or-previously-blocked ip
CREATE TABLE IF NOT EXISTS ip_block (
  ip            TEXT PRIMARY KEY,
  blocked_until TIMESTAMPTZ NOT NULL
);

-- one row per currently-or-previously-blocked ip range (CIDR group key, e.g.
-- "v4:198.51.100.0/24"). Blocked when more than range_threshold_in distinct
-- ips out of the same range were denied on the same UTC day - unlike
-- ip_block, this never escalates; every trip of the threshold just
-- (re-)sets blocked_until range_block_ms_in out from now (GREATEST, same
-- extend-only semantics as ip_block).
CREATE TABLE IF NOT EXISTS ip_group_block (
  ip_group      TEXT PRIMARY KEY,
  blocked_until TIMESTAMPTZ NOT NULL
);

-- called once per queue-issued 429 for ip_in (a member of ip_group_in).
-- Atomically increments today's (UTC) denial counter, counts how many of
-- the trailing window_days_in days (inclusive of today) reached
-- daily_threshold_in, and - if that count has reached exceed_threshold_in -
-- upserts an ip-level block expiring block_ms_in from now, only ever
-- extending (never shortening) any existing block. Independently, also
-- counts how many distinct ips out of ip_group_in were denied today, and -
-- if that count exceeds range_threshold_in - upserts a range-level block
-- expiring range_block_ms_in from now (same extend-only semantics; this one
-- never escalates beyond that flat duration, unlike the ip-level block).
-- Returns both outcomes so the caller can log/report them independently.
--
-- No FOR UPDATE / mutex-row locking is used here (contrast with
-- try_admit/enqueue_if_room in 001-queue.sql): those functions check-then-
-- conditionally-insert *across two tables* (group_state's counter vs
-- active_request/pending_request's rows), which a bare atomic statement
-- can't express. Here, the single `INSERT ... ON CONFLICT (ip, day) DO
-- UPDATE SET count = count + 1` below *is* the entire state change for
-- step 1 - Postgres itself serializes concurrent upserts targeting the
-- same (ip, day) row via the unique index (the second writer blocks on the
-- first writer's row lock, then re-reads and increments from the
-- now-committed value), so concurrent denials for the same ip on the same
-- day can never be lost or double-counted without an app-level lock. The
-- window-count/group-count SELECTs and the ip_block/ip_group_block upserts
-- that follow only read/write data already committed by (or local to) this
-- same transaction, so there's no cross-statement race to guard against
-- either.
CREATE OR REPLACE FUNCTION record_ip_denial(
  ip_in TEXT, ip_group_in TEXT, daily_threshold_in INT, window_days_in INT, exceed_threshold_in INT, block_ms_in BIGINT,
  range_threshold_in INT, range_block_ms_in BIGINT
) RETURNS TABLE(ip_blocked BOOLEAN, range_blocked BOOLEAN) AS $$
DECLARE
  today DATE := (NOW() AT TIME ZONE 'UTC')::date;
  exceed_days INT;
  group_ip_count INT;
  did_ip_block BOOLEAN := FALSE;
  did_range_block BOOLEAN := FALSE;
BEGIN
  INSERT INTO ip_denial_count (ip, ip_group, day, count)
    VALUES (ip_in, ip_group_in, today, 1)
    ON CONFLICT (ip, day) DO UPDATE SET count = ip_denial_count.count + 1, ip_group = EXCLUDED.ip_group;

  SELECT COUNT(*) INTO exceed_days
    FROM ip_denial_count
    WHERE ip = ip_in
      AND day >= today - (window_days_in - 1)
      AND count >= daily_threshold_in;

  IF exceed_days >= exceed_threshold_in THEN
    INSERT INTO ip_block (ip, blocked_until)
      VALUES (ip_in, NOW() + (block_ms_in || ' milliseconds')::interval)
      ON CONFLICT (ip) DO UPDATE
        SET blocked_until = GREATEST(ip_block.blocked_until, EXCLUDED.blocked_until);
    did_ip_block := TRUE;
  END IF;

  SELECT COUNT(*) INTO group_ip_count
    FROM ip_denial_count
    WHERE ip_group = ip_group_in
      AND day = today;

  IF group_ip_count > range_threshold_in THEN
    INSERT INTO ip_group_block (ip_group, blocked_until)
      VALUES (ip_group_in, NOW() + (range_block_ms_in || ' milliseconds')::interval)
      ON CONFLICT (ip_group) DO UPDATE
        SET blocked_until = GREATEST(ip_group_block.blocked_until, EXCLUDED.blocked_until);
    did_range_block := TRUE;
  END IF;

  RETURN QUERY SELECT did_ip_block, did_range_block;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;

-- sweep-time cleanup: delete ip_denial_count rows older than
-- retention_ms_in (bounds the table - rows past the trailing window are
-- never read again) and ip_block/ip_group_block rows whose block expired
-- more than retention_ms_in ago (keeps a bounded grace period of
-- recently-expired blocks around for debugging without growing either
-- table forever). retention_ms_in does NOT affect how long an *active*
-- block lasts - that is governed entirely by blocked_until, set/extended
-- by record_ip_denial.
CREATE OR REPLACE FUNCTION prune_ip_denials(retention_ms_in BIGINT) RETURNS INT AS $$
DECLARE
  removed_counts INT;
  removed_blocks INT;
  removed_group_blocks INT;
BEGIN
  DELETE FROM ip_denial_count
    WHERE day < (NOW() AT TIME ZONE 'UTC')::date - (retention_ms_in / 86400000)::int;
  GET DIAGNOSTICS removed_counts = ROW_COUNT;

  DELETE FROM ip_block
    WHERE blocked_until < NOW() - (retention_ms_in || ' milliseconds')::interval;
  GET DIAGNOSTICS removed_blocks = ROW_COUNT;

  DELETE FROM ip_group_block
    WHERE blocked_until < NOW() - (retention_ms_in || ' milliseconds')::interval;
  GET DIAGNOSTICS removed_group_blocks = ROW_COUNT;

  RETURN removed_counts + removed_blocks + removed_group_blocks;
END;
$$ LANGUAGE plpgsql
SET search_path = {{SCHEMA}}, public;
