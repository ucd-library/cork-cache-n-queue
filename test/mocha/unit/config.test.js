import assert from 'assert';

// config.js reads process.env once, at module-evaluation time, so each
// scenario here loads a genuinely fresh module instance via a cache-busting
// query string rather than relying on the one shared, already-evaluated
// instance every other test file imports statically.
async function loadConfig(env) {
  let snapshot = { ...process.env };
  Object.keys(process.env).forEach(key => { if (key.startsWith('CCNQ_')) delete process.env[key]; });
  Object.assign(process.env, env);

  try {
    let mod = await import(`../../../src/lib/config.js?t=${Date.now()}-${Math.random()}`);
    return mod.default;
  } finally {
    Object.keys(process.env).forEach(key => { if (key.startsWith('CCNQ_')) delete process.env[key]; });
    Object.assign(process.env, snapshot);
  }
}

describe('config', () => {

  it('applies documented defaults when no env vars are set', async () => {
    let config = await loadConfig({});
    assert.strictEqual(config.port, 3000);
    assert.strictEqual(config.logLevel, 'info');
    assert.strictEqual(config.upstreamUrl, '');
    assert.strictEqual(config.clientIpHeader, '');
    assert.strictEqual(config.postgres.host, 'localhost');
    assert.strictEqual(config.postgres.schema, 'queue');
    assert.strictEqual(config.postgres.poolMax, 10);
    assert.strictEqual(config.queue.enabled, false);
    assert.deepStrictEqual(config.queue.methods, []);
    assert.strictEqual(config.queue.maxServedPerGroup, 1);
    assert.strictEqual(config.queue.maxPendingPerGroup, 5);
    assert.strictEqual(config.cache.enabled, false);
    assert.strictEqual(config.cache.dir, './data/cache');
    assert.deepStrictEqual(config.cache.methods, ['GET', 'HEAD']);
    assert.strictEqual(config.cache.keyIncludeQuery, true);
    assert.strictEqual(config.cache.respectCacheControl, true);
    assert.strictEqual(config.cache.maxSizeBytes, 1024 * 1024 * 1024);
  });

  it('overrides defaults from env vars, parsing integers/booleans/csv correctly', async () => {
    let config = await loadConfig({
      CCNQ_PORT: '8080',
      CCNQ_QUEUE_ENABLED: 'true',
      CCNQ_QUEUE_MAX_SERVED_PER_GROUP: '7',
      CCNQ_QUEUE_METHODS: 'get, post',
      CCNQ_CACHE_KEY_INCLUDE_QUERY: 'false',
      CCNQ_CACHE_RESPECT_CACHE_CONTROL: 'false',
      CCNQ_CACHE_VARY_HEADERS: 'Accept-Encoding, X-Foo'
    });
    assert.strictEqual(config.port, 8080);
    assert.strictEqual(config.queue.enabled, true);
    assert.strictEqual(config.queue.maxServedPerGroup, 7);
    assert.deepStrictEqual(config.queue.methods, ['GET', 'POST']);
    assert.strictEqual(config.cache.keyIncludeQuery, false);
    assert.strictEqual(config.cache.respectCacheControl, false);
    assert.deepStrictEqual(config.cache.varyHeaders, ['accept-encoding', 'x-foo']);
  });

  it('falls back to the default on an unparseable integer env var', async () => {
    let config = await loadConfig({ CCNQ_PORT: 'not-a-number' });
    assert.strictEqual(config.port, 3000);
  });

  it('throws at load time for an invalid CCNQ_PG_SCHEMA', async () => {
    await assert.rejects(loadConfig({ CCNQ_PG_SCHEMA: 'bad-schema!' }), /not a safe schema identifier/);
  });

  it('accepts a valid custom CCNQ_PG_SCHEMA', async () => {
    let config = await loadConfig({ CCNQ_PG_SCHEMA: 'my_schema_2' });
    assert.strictEqual(config.postgres.schema, 'my_schema_2');
  });
});
