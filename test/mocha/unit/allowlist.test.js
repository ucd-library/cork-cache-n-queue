import assert from 'assert';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';

describe('allowlist', () => {

  it('matches a bare ip exactly', () => {
    let allowlist = createAllowlist('203.0.113.5');
    assert.strictEqual(allowlist.isAllowed('203.0.113.5'), true);
    assert.strictEqual(allowlist.isAllowed('203.0.113.6'), false);
  });

  it('matches an ipv4 CIDR range', () => {
    let allowlist = createAllowlist('198.51.100.0/24');
    assert.strictEqual(allowlist.isAllowed('198.51.100.200'), true);
    assert.strictEqual(allowlist.isAllowed('198.51.101.1'), false);
  });

  it('matches an explicit ip range', () => {
    let allowlist = createAllowlist('192.0.2.10-192.0.2.20');
    assert.strictEqual(allowlist.isAllowed('192.0.2.15'), true);
    assert.strictEqual(allowlist.isAllowed('192.0.2.25'), false);
  });

  it('matches an ipv6 CIDR range', () => {
    let allowlist = createAllowlist('2001:db8::/32');
    assert.strictEqual(allowlist.isAllowed('2001:db8:1234::1'), true);
    assert.strictEqual(allowlist.isAllowed('2001:db9::1'), false);
  });

  it('never cross-matches between address families', () => {
    let allowlist = createAllowlist('198.51.100.0/24');
    assert.strictEqual(allowlist.isAllowed('2001:db8::1'), false);
  });

  it('skips an invalid entry without throwing, and still matches the valid ones', () => {
    let allowlist = createAllowlist('not-an-ip, 203.0.113.5');
    assert.strictEqual(allowlist.isAllowed('203.0.113.5'), true);
  });

  it('an empty config string allows nothing', () => {
    let allowlist = createAllowlist('');
    assert.strictEqual(allowlist.isAllowed('203.0.113.5'), false);
  });
});
