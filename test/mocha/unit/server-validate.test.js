import assert from 'assert';
import { validateStartupConfig } from '../../../src/server.js';

function baseConfig(overrides = {}) {
  return {
    upstreamUrl: 'http://localhost:4000',
    queue: { enabled: false, rulesFile: '' },
    cache: { enabled: false, rulesFile: '' },
    ...overrides
  };
}

describe('validateStartupConfig', () => {

  it('accepts a minimal valid config with both gates disabled', () => {
    assert.strictEqual(validateStartupConfig(baseConfig()), null);
  });

  it('rejects a missing upstream url', () => {
    let error = validateStartupConfig(baseConfig({ upstreamUrl: '' }));
    assert.match(error, /CCNQ_UPSTREAM_URL is required/);
  });

  it('rejects an unparseable upstream url', () => {
    let error = validateStartupConfig(baseConfig({ upstreamUrl: 'not a url' }));
    assert.match(error, /not a valid URL/);
  });

  it('rejects the queue being enabled without a rules file', () => {
    let error = validateStartupConfig(baseConfig({ queue: { enabled: true, rulesFile: '' } }));
    assert.match(error, /CCNQ_QUEUE_RULES_FILE is required/);
  });

  it('accepts the queue being enabled with a rules file', () => {
    let result = validateStartupConfig(baseConfig({ queue: { enabled: true, rulesFile: '/some/path.json' } }));
    assert.strictEqual(result, null);
  });

  it('rejects the cache being enabled without a rules file', () => {
    let error = validateStartupConfig(baseConfig({ cache: { enabled: true, rulesFile: '' } }));
    assert.match(error, /CCNQ_CACHE_RULES_FILE is required/);
  });

  it('accepts the cache being enabled with a rules file', () => {
    let result = validateStartupConfig(baseConfig({ cache: { enabled: true, rulesFile: '/some/path.json' } }));
    assert.strictEqual(result, null);
  });

  it('accepts both gates enabled with rules files', () => {
    let result = validateStartupConfig(baseConfig({
      queue: { enabled: true, rulesFile: '/a.json' },
      cache: { enabled: true, rulesFile: '/b.json' }
    }));
    assert.strictEqual(result, null);
  });

  it('reports the upstream url problem before checking gate rules files', () => {
    let error = validateStartupConfig(baseConfig({ upstreamUrl: '', queue: { enabled: true, rulesFile: '' } }));
    assert.match(error, /CCNQ_UPSTREAM_URL is required/);
  });
});
