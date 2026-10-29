import fs from 'fs';

const VALID_TARGETS = ['path', 'header', 'cookie', 'query'];
const VALID_MATCH_TYPES = ['regex', 'includes', 'startsWith', 'endsWith'];

/**
 * @function validateCondition
 * @description validate a single rule condition's shape and precompile its
 * regex (if any), mutating the condition in place by attaching
 * _compiledRegex. Throws a descriptive error identifying the offending
 * group/condition position on any violation.
 *
 * @param {Object} condition raw condition object from the ruleset file
 * @param {String} where human-readable location, e.g. "[0][1]"
 * @returns {void}
 */
function validateCondition(condition, where) {
  if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
    throw new Error(`Rule condition ${where} must be an object`);
  }

  if (!VALID_TARGETS.includes(condition.target)) {
    throw new Error(`Rule condition ${where} has invalid target "${condition.target}" (must be one of ${VALID_TARGETS.join(', ')})`);
  }

  if (condition.target === 'path') {
    if (condition.name !== undefined) {
      throw new Error(`Rule condition ${where} has target "path" but also sets "name", which is not allowed`);
    }
    if (!condition.matchType) {
      throw new Error(`Rule condition ${where} has target "path" but no matchType; path conditions must always specify a matchType (path is always present, so a presence-only check is a no-op)`);
    }
  } else {
    if (typeof condition.name !== 'string' || condition.name.length === 0) {
      throw new Error(`Rule condition ${where} has target "${condition.target}" but no non-empty "name"`);
    }
  }

  if (condition.matchType !== undefined) {
    if (!VALID_MATCH_TYPES.includes(condition.matchType)) {
      throw new Error(`Rule condition ${where} has invalid matchType "${condition.matchType}" (must be one of ${VALID_MATCH_TYPES.join(', ')})`);
    }
    if (typeof condition.value !== 'string') {
      throw new Error(`Rule condition ${where} has matchType "${condition.matchType}" but no string "value"`);
    }
    if (condition.matchType === 'regex') {
      try {
        condition._compiledRegex = new RegExp(condition.value);
      } catch (e) {
        throw new Error(`Rule condition ${where} has an invalid regex "${condition.value}": ${e.message}`);
      }
    }
  }

  if (condition.negate !== undefined && typeof condition.negate !== 'boolean') {
    throw new Error(`Rule condition ${where} has non-boolean "negate"`);
  }
}

/**
 * @function validateRuleset
 * @description validate the full shape of a ruleset (array of non-empty
 * condition-groups), precompiling any regex conditions in place.
 *
 * @param {*} ruleset parsed ruleset JSON
 * @returns {Array<Array<Object>>} the same ruleset, validated and with
 * regex conditions precompiled
 */
function validateRuleset(ruleset) {
  if (!Array.isArray(ruleset)) {
    throw new Error('Ruleset must be a JSON array of groups');
  }

  ruleset.forEach((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error(`Ruleset group [${groupIndex}] must be a non-empty array of conditions`);
    }
    group.forEach((condition, conditionIndex) => {
      validateCondition(condition, `[${groupIndex}][${conditionIndex}]`);
    });
  });

  return ruleset;
}

/**
 * @function loadRuleset
 * @description load, validate, and precompile a ruleset JSON file from disk.
 * Intended to be called once at process startup - regexes are compiled once
 * here so the hot request path never calls `new RegExp()`.
 *
 * @param {String} filePath path to a ruleset JSON file
 * @returns {Array<Array<Object>>} validated, precompiled ruleset
 */
function loadRuleset(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Could not read rules file "${filePath}": ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse rules file "${filePath}" as JSON: ${e.message}`);
  }

  return validateRuleset(parsed);
}

export { loadRuleset, validateRuleset };
