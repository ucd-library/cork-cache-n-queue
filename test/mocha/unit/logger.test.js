import assert from 'assert';
import { getLogger } from '../../../src/lib/logger.js';

describe('logger', () => {

  it('memoizes loggers by name, returning the same instance on repeat calls', () => {
    let a = getLogger('some-name');
    let b = getLogger('some-name');
    assert.strictEqual(a, b);
  });

  it('returns distinct instances for distinct names', () => {
    let a = getLogger('name-one');
    let b = getLogger('name-two');
    assert.notStrictEqual(a, b);
  });

  it('exposes the expected logging methods', () => {
    let logger = getLogger('method-check');
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(method => {
      assert.strictEqual(typeof logger[method], 'function', `expected logger.${method} to be a function`);
    });
  });

  it('defaults to a stable logger name when called with no arguments', () => {
    let a = getLogger();
    let b = getLogger();
    assert.strictEqual(a, b);
  });
});
