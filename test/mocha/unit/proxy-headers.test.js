import assert from 'assert';
import { buildForwardHeaders, copyResponseHeaders, buildHeadersObject } from '../../../src/lib/proxy/headers.js';

function fakeRes() {
  let headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; }
  };
}

describe('proxy/headers', () => {

  describe('buildForwardHeaders', () => {
    it('strips every hop-by-hop header', () => {
      let incoming = {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'proxy-authenticate': 'Basic',
        'proxy-authorization': 'Basic abc',
        te: 'trailers',
        trailer: 'X-Foo',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'x-keep-me': 'yes'
      };
      let forwarded = buildForwardHeaders(incoming);
      assert.deepStrictEqual(forwarded, { 'x-keep-me': 'yes' });
    });

    it('strips host and content-length', () => {
      let forwarded = buildForwardHeaders({ host: 'example.com', 'content-length': '123', accept: '*/*' });
      assert.deepStrictEqual(forwarded, { accept: '*/*' });
    });

    it('joins an array-valued header with ", "', () => {
      let forwarded = buildForwardHeaders({ accept: ['text/html', 'application/json'] });
      assert.strictEqual(forwarded.accept, 'text/html, application/json');
    });

    it('skips a header with an undefined value', () => {
      let forwarded = buildForwardHeaders({ 'x-maybe': undefined, 'x-real': 'yes' });
      assert.deepStrictEqual(forwarded, { 'x-real': 'yes' });
    });
  });

  describe('copyResponseHeaders', () => {
    it('strips hop-by-hop headers and copies everything else', () => {
      let fetchResponse = { headers: new Headers([['connection', 'keep-alive'], ['x-keep-me', 'yes']]) };
      let res = fakeRes();
      copyResponseHeaders(fetchResponse, res);
      assert.strictEqual(res.headers['x-keep-me'], 'yes');
      assert.strictEqual(res.headers['connection'], undefined);
    });

    it('preserves multiple Set-Cookie values as an array, not comma-joined', () => {
      let headers = new Headers();
      headers.append('set-cookie', 'a=1');
      headers.append('set-cookie', 'b=2');
      let res = fakeRes();

      copyResponseHeaders({ headers }, res);
      assert.deepStrictEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
    });

    it('does not set a set-cookie header at all when there is none', () => {
      let fetchResponse = { headers: new Headers([['x-keep-me', 'yes']]) };
      let res = fakeRes();
      copyResponseHeaders(fetchResponse, res);
      assert.strictEqual('set-cookie' in res.headers, false);
    });
  });

  describe('buildHeadersObject', () => {
    it('builds a plain, lowercase-keyed object from the response headers', () => {
      let fetchResponse = { headers: new Headers([['Cache-Control', 'max-age=60'], ['X-Foo', 'bar']]) };
      let obj = buildHeadersObject(fetchResponse);
      assert.strictEqual(obj['cache-control'], 'max-age=60');
      assert.strictEqual(obj['x-foo'], 'bar');
    });
  });
});
