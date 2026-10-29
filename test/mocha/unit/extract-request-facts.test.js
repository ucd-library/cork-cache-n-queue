import assert from 'assert';
import { extractRequestFacts } from '../../../src/lib/rules/extract-request-facts.js';

describe('extractRequestFacts', () => {

  it('pulls path and headers through unchanged', () => {
    let req = { path: '/foo/bar', headers: { 'x-custom': 'hi' } };
    let facts = extractRequestFacts(req);
    assert.strictEqual(facts.path, '/foo/bar');
    assert.strictEqual(facts.headers['x-custom'], 'hi');
  });

  it('parses cookies from the Cookie header', () => {
    let req = { path: '/', headers: { cookie: 'a=1; b=2' } };
    let facts = extractRequestFacts(req);
    assert.deepStrictEqual(facts.cookies, { a: '1', b: '2' });
  });

  it('returns an empty cookies object when there is no Cookie header', () => {
    let req = { path: '/', headers: {} };
    let facts = extractRequestFacts(req);
    assert.deepStrictEqual(facts.cookies, {});
  });
});
