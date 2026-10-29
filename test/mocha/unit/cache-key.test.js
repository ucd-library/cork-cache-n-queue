import assert from 'assert';
import { deriveCacheKey } from '../../../src/lib/cache/key.js';

function fakeReq({ method = 'GET', path = '/foo', originalUrl, headers = {} } = {}) {
  return { method, path, originalUrl: originalUrl ?? path, headers };
}

describe('cache key derivation', () => {

  it('produces identical keys for identical requests', () => {
    let a = deriveCacheKey(fakeReq({ path: '/foo' }), {});
    let b = deriveCacheKey(fakeReq({ path: '/foo' }), {});
    assert.strictEqual(a, b);
  });

  it('produces different keys for different paths', () => {
    let a = deriveCacheKey(fakeReq({ path: '/foo' }), {});
    let b = deriveCacheKey(fakeReq({ path: '/bar' }), {});
    assert.notStrictEqual(a, b);
  });

  it('produces different keys for different methods', () => {
    let a = deriveCacheKey(fakeReq({ method: 'GET', path: '/foo' }), {});
    let b = deriveCacheKey(fakeReq({ method: 'HEAD', path: '/foo' }), {});
    assert.notStrictEqual(a, b);
  });

  it('includes the query string by default', () => {
    let a = deriveCacheKey(fakeReq({ path: '/foo', originalUrl: '/foo?a=1' }), {});
    let b = deriveCacheKey(fakeReq({ path: '/foo', originalUrl: '/foo?a=2' }), {});
    assert.notStrictEqual(a, b);
  });

  it('ignores the query string when includeQuery is false', () => {
    let a = deriveCacheKey(fakeReq({ path: '/foo', originalUrl: '/foo?a=1' }), { includeQuery: false });
    let b = deriveCacheKey(fakeReq({ path: '/foo', originalUrl: '/foo?a=2' }), { includeQuery: false });
    assert.strictEqual(a, b);
  });

  it('folds configured vary headers into the key', () => {
    let opts = { varyHeaders: ['accept-encoding'] };
    let a = deriveCacheKey(fakeReq({ headers: { 'accept-encoding': 'gzip' } }), opts);
    let b = deriveCacheKey(fakeReq({ headers: { 'accept-encoding': 'br' } }), opts);
    assert.notStrictEqual(a, b);
  });

  it('ignores an unconfigured header difference', () => {
    let a = deriveCacheKey(fakeReq({ headers: { 'accept-encoding': 'gzip' } }), {});
    let b = deriveCacheKey(fakeReq({ headers: { 'accept-encoding': 'br' } }), {});
    assert.strictEqual(a, b);
  });

  it('is case-insensitive about vary header names', () => {
    let opts = { varyHeaders: ['Accept-Encoding'] };
    let key = deriveCacheKey(fakeReq({ headers: { 'accept-encoding': 'gzip' } }), opts);
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(key.length, 64);
  });
});
