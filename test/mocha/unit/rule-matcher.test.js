import assert from 'assert';
import { matchRuleset, matchGroup, matchCondition } from '../../../src/lib/rules/matcher.js';

function facts(overrides = {}) {
  return {
    path: '/foo/bar.pdf',
    headers: { 'x-custom': 'hello-world', authorization: 'Bearer abc' },
    cookies: { session: 'xyz' },
    ...overrides
  };
}

describe('rule matcher', () => {

  describe('matchCondition', () => {
    it('matches path via regex', () => {
      let cond = { target: 'path', matchType: 'regex', value: '\\.pdf$', _compiledRegex: /\.pdf$/ };
      assert.strictEqual(matchCondition(cond, facts()), true);
    });

    it('matches header via includes', () => {
      let cond = { target: 'header', name: 'x-custom', matchType: 'includes', value: 'world' };
      assert.strictEqual(matchCondition(cond, facts()), true);
    });

    it('matches header via startsWith', () => {
      let cond = { target: 'header', name: 'authorization', matchType: 'startsWith', value: 'Bearer' };
      assert.strictEqual(matchCondition(cond, facts()), true);
    });

    it('matches cookie via endsWith', () => {
      let cond = { target: 'cookie', name: 'session', matchType: 'endsWith', value: 'yz' };
      assert.strictEqual(matchCondition(cond, facts()), true);
    });

    it('treats a missing matchType on header/cookie as presence-only', () => {
      let present = matchCondition({ target: 'cookie', name: 'session' }, facts());
      let absent = matchCondition({ target: 'cookie', name: 'nope' }, facts());
      assert.strictEqual(present, true);
      assert.strictEqual(absent, false);
    });

    it('negate flips a positive match to false', () => {
      let cond = { target: 'path', matchType: 'endsWith', value: '.pdf', negate: true };
      assert.strictEqual(matchCondition(cond, facts()), false);
    });

    it('negate flips an absent header/cookie to true (expresses "not present")', () => {
      let cond = { target: 'cookie', name: 'no-cache', negate: true };
      assert.strictEqual(matchCondition(cond, facts()), true);
    });

    it('an absent header never matches a value-based condition, negated or not', () => {
      let cond = { target: 'header', name: 'x-missing', matchType: 'includes', value: 'anything' };
      assert.strictEqual(matchCondition(cond, facts()), false);
    });
  });

  describe('matchGroup', () => {
    it('matches only when every condition in the group matches (AND)', () => {
      let group = [
        { target: 'path', matchType: 'endsWith', value: '.pdf' },
        { target: 'cookie', name: 'session', matchType: 'includes', value: 'xyz' }
      ];
      assert.strictEqual(matchGroup(group, facts()), true);

      let groupWithMiss = [
        { target: 'path', matchType: 'endsWith', value: '.pdf' },
        { target: 'cookie', name: 'session', matchType: 'includes', value: 'nope' }
      ];
      assert.strictEqual(matchGroup(groupWithMiss, facts()), false);
    });

    it('an empty group never matches', () => {
      assert.strictEqual(matchGroup([], facts()), false);
    });

    it('a non-array group never matches', () => {
      assert.strictEqual(matchGroup(null, facts()), false);
    });
  });

  describe('matchRuleset', () => {
    it('matches if any group matches (OR of ANDs)', () => {
      let ruleset = [
        [{ target: 'path', matchType: 'startsWith', value: '/nope' }],
        [{ target: 'path', matchType: 'endsWith', value: '.pdf' }]
      ];
      assert.strictEqual(matchRuleset(ruleset, facts()), true);
    });

    it('matches nothing when no group matches', () => {
      let ruleset = [
        [{ target: 'path', matchType: 'startsWith', value: '/nope' }]
      ];
      assert.strictEqual(matchRuleset(ruleset, facts()), false);
    });

    it('an empty ruleset never matches', () => {
      assert.strictEqual(matchRuleset([], facts()), false);
    });
  });
});
