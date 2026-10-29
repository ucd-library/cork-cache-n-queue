import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRuleset, validateRuleset } from '../../../src/lib/rules/load-rules.js';

function writeTmpJson(content) {
  let file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-rules-')), 'rules.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('load-rules', () => {

  it('loads a valid ruleset and precompiles its regexes', () => {
    let file = writeTmpJson([
      [{ target: 'path', matchType: 'regex', value: '\\.pdf$' }]
    ]);
    let ruleset = loadRuleset(file);
    assert.strictEqual(ruleset[0][0]._compiledRegex instanceof RegExp, true);
    assert.strictEqual(ruleset[0][0]._compiledRegex.test('/a.pdf'), true);
  });

  it('throws a descriptive error for a missing file', () => {
    assert.throws(() => loadRuleset('/no/such/file.json'), /Could not read rules file/);
  });

  it('throws a descriptive error for invalid JSON', () => {
    let file = writeTmpJson('{not json');
    assert.throws(() => loadRuleset(file), /Could not parse rules file/);
  });

  it('rejects a non-array ruleset', () => {
    assert.throws(() => validateRuleset({ not: 'an array' }), /must be a JSON array of groups/);
  });

  it('rejects an empty group', () => {
    assert.throws(() => validateRuleset([[]]), /\[0\].*non-empty array/);
  });

  it('rejects a non-array group', () => {
    assert.throws(() => validateRuleset(['not-an-array']), /\[0\].*non-empty array/);
  });

  it('rejects an invalid target', () => {
    assert.throws(() => validateRuleset([[{ target: 'bogus' }]]), /\[0\]\[0\].*invalid target/);
  });

  it('rejects a header condition missing name', () => {
    assert.throws(() => validateRuleset([[{ target: 'header', matchType: 'includes', value: 'x' }]]), /no non-empty "name"/);
  });

  it('rejects a cookie condition missing name', () => {
    assert.throws(() => validateRuleset([[{ target: 'cookie' }]]), /no non-empty "name"/);
  });

  it('rejects a query condition missing name', () => {
    assert.throws(() => validateRuleset([[{ target: 'query' }]]), /no non-empty "name"/);
  });

  it('rejects a path condition that sets name', () => {
    assert.throws(() => validateRuleset([[{ target: 'path', name: 'x', matchType: 'includes', value: 'y' }]]), /also sets "name"/);
  });

  it('rejects a path condition missing matchType', () => {
    assert.throws(() => validateRuleset([[{ target: 'path' }]]), /no matchType/);
  });

  it('rejects an invalid matchType', () => {
    assert.throws(() => validateRuleset([[{ target: 'path', matchType: 'contains', value: 'x' }]]), /invalid matchType/);
  });

  it('rejects a matchType with no value', () => {
    assert.throws(() => validateRuleset([[{ target: 'path', matchType: 'includes' }]]), /no string "value"/);
  });

  it('rejects an invalid regex value', () => {
    assert.throws(() => validateRuleset([[{ target: 'path', matchType: 'regex', value: '(unterminated' }]]), /invalid regex/);
  });

  it('rejects a non-boolean negate', () => {
    assert.throws(() => validateRuleset([[{ target: 'path', matchType: 'includes', value: 'x', negate: 'yes' }]]), /non-boolean "negate"/);
  });

  it('allows a presence-only header/cookie condition (no matchType)', () => {
    assert.doesNotThrow(() => validateRuleset([[{ target: 'header', name: 'authorization' }]]));
  });

  it('allows a presence-only query condition (no matchType)', () => {
    assert.doesNotThrow(() => validateRuleset([[{ target: 'query', name: 'debug' }]]));
  });
});
