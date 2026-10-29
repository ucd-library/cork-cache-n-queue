import assert from 'assert';
import { parseCookies } from '../../../src/lib/cookies.js';

describe('cookies', () => {

  it('parses multiple cookies', () => {
    assert.deepStrictEqual(parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
  });

  it('returns an empty object for an empty header', () => {
    assert.deepStrictEqual(parseCookies(''), {});
    assert.deepStrictEqual(parseCookies(), {});
  });

  it('strips one layer of double-quote wrapping', () => {
    assert.deepStrictEqual(parseCookies('a="quoted value"'), { a: 'quoted value' });
  });

  it('skips a malformed pair with no "="', () => {
    assert.deepStrictEqual(parseCookies('a=1; malformed; b=2'), { a: '1', b: '2' });
  });

  it('percent-decodes values', () => {
    assert.deepStrictEqual(parseCookies('a=hello%20world'), { a: 'hello world' });
  });

  it('falls back to the raw value when percent-decoding fails', () => {
    assert.deepStrictEqual(parseCookies('a=%E0%A4%A'), { a: '%E0%A4%A' });
  });

  it('keeps the last occurrence of a duplicate name', () => {
    assert.deepStrictEqual(parseCookies('a=1; a=2'), { a: '2' });
  });

  it('trims surrounding whitespace around names and values', () => {
    assert.deepStrictEqual(parseCookies('  a = 1  ;  b = 2  '), { a: '1', b: '2' });
  });
});
