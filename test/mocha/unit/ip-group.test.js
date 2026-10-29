import assert from 'assert';
import { getClientIp, toGroupKey, expandIpv6 } from '../../../src/lib/queue/ip-group.js';

function fakeReq({ headers = {}, remoteAddress = '203.0.113.5' } = {}) {
  return { headers, socket: { remoteAddress } };
}

describe('ip-group', () => {

  describe('expandIpv6', () => {
    it('expands "::" shorthand to 8 hextets', () => {
      assert.deepStrictEqual(expandIpv6('2001:db8::1'), ['2001', 'db8', '0', '0', '0', '0', '0', '1']);
    });

    it('passes through an already-full address', () => {
      assert.deepStrictEqual(expandIpv6('2001:db8:0:0:0:0:0:1'), ['2001', 'db8', '0', '0', '0', '0', '0', '1']);
    });

    it('handles "::" at the start', () => {
      assert.deepStrictEqual(expandIpv6('::1'), ['0', '0', '0', '0', '0', '0', '0', '1']);
    });
  });

  describe('toGroupKey', () => {
    it('masks ipv4 to the default /24', () => {
      assert.strictEqual(toGroupKey('168.100.3.42'), 'v4:168.100.3.0/24');
      assert.strictEqual(toGroupKey('168.100.3.99'), 'v4:168.100.3.0/24');
    });

    it('masks ipv4 to a custom byte-aligned prefix', () => {
      assert.strictEqual(toGroupKey('168.100.3.42', { v4PrefixLength: 16 }), 'v4:168.100.0.0/16');
    });

    it('masks ipv6 to the default /64', () => {
      assert.strictEqual(toGroupKey('2001:db8:1234:5678::1'), 'v6:2001:db8:1234:5678:0:0:0:0/64');
    });

    it('masks ipv6 to a custom hextet-aligned prefix', () => {
      assert.strictEqual(toGroupKey('2001:db8:1234:5678::1', { v6PrefixLength: 32 }), 'v6:2001:db8:0:0:0:0:0:0/32');
    });

    it('groups unparseable addresses together under "unknown:"', () => {
      assert.strictEqual(toGroupKey('not-an-ip'), 'unknown:not-an-ip');
    });
  });

  describe('getClientIp', () => {
    it('uses the socket address when no trusted header is configured', () => {
      let req = fakeReq({ headers: { 'cf-connecting-ip': '198.51.100.1' }, remoteAddress: '203.0.113.5' });
      assert.strictEqual(getClientIp(req, {}), '203.0.113.5');
    });

    it('ignores a header present on the request when it is not the configured trusted header', () => {
      let req = fakeReq({ headers: { 'cf-connecting-ip': '198.51.100.1' } });
      assert.strictEqual(getClientIp(req, { trustedHeader: 'x-other-header' }), '203.0.113.5');
    });

    it('uses the configured trusted header when present', () => {
      let req = fakeReq({ headers: { 'cf-connecting-ip': '198.51.100.1' } });
      assert.strictEqual(getClientIp(req, { trustedHeader: 'cf-connecting-ip' }), '198.51.100.1');
    });

    it('falls back to the socket address when the configured trusted header is absent', () => {
      let req = fakeReq({ headers: {} });
      assert.strictEqual(getClientIp(req, { trustedHeader: 'cf-connecting-ip' }), '203.0.113.5');
    });
  });
});
