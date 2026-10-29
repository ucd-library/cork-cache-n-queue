/**
 * @function resolveTarget
 * @description resolve the string value a condition's target refers to on a
 * given set of request facts.
 *
 * @param {Object} condition a single rule condition, see matchCondition
 * @param {Object} facts {path, headers, cookies} as produced by extractRequestFacts
 * @returns {String|undefined} the resolved value, or undefined if the target
 * (a header or cookie) is not present on the request at all
 */
function resolveTarget(condition, facts) {
  if (condition.target === 'path') return facts.path;

  if (condition.target === 'header') {
    let value = facts.headers[condition.name.toLowerCase()];
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (condition.target === 'cookie') {
    return facts.cookies[condition.name];
  }

  return undefined;
}

/**
 * @function applyMatchType
 * @description apply a condition's match type against a resolved target value.
 *
 * @param {String} matchType one of 'regex'|'includes'|'startsWith'|'endsWith'
 * @param {String} actual the resolved target value
 * @param {String} value the condition's configured comparison value
 * @param {RegExp} [compiledRegex] precompiled regex, required when matchType is 'regex'
 * @returns {Boolean}
 */
function applyMatchType(matchType, actual, value, compiledRegex) {
  if (matchType === 'regex') return compiledRegex.test(actual);
  if (matchType === 'includes') return actual.includes(value);
  if (matchType === 'startsWith') return actual.startsWith(value);
  if (matchType === 'endsWith') return actual.endsWith(value);
  return false;
}

/**
 * @function matchCondition
 * @description evaluate a single rule condition against a request's facts.
 * A condition with no matchType is a presence-only check (the target header
 * or cookie exists at all, regardless of value). An absent header/cookie
 * target always resolves to a base result of false, before negate is applied
 * - this is what lets {target:'cookie', name:'x', negate:true} express
 * "cookie x is NOT present".
 *
 * @param {Object} condition {target, name, matchType, value, negate, _compiledRegex}
 * @param {Object} facts {path, headers, cookies}
 * @returns {Boolean}
 */
function matchCondition(condition, facts) {
  let actual = resolveTarget(condition, facts);
  let result;

  if (actual === undefined) {
    result = false;
  } else if (!condition.matchType) {
    result = true;
  } else {
    result = applyMatchType(condition.matchType, actual, condition.value, condition._compiledRegex);
  }

  return condition.negate ? !result : result;
}

/**
 * @function matchGroup
 * @description evaluate a group of conditions, all of which must match (AND).
 * An empty group never matches - a malformed/empty group should never
 * accidentally mean "match everything".
 *
 * @param {Array<Object>} group array of conditions
 * @param {Object} facts {path, headers, cookies}
 * @returns {Boolean}
 */
function matchGroup(group, facts) {
  if (!Array.isArray(group) || group.length === 0) return false;
  return group.every(condition => matchCondition(condition, facts));
}

/**
 * @function matchRuleset
 * @description evaluate a ruleset (array of groups), matching if any group
 * matches (OR of ANDs - disjunctive normal form).
 *
 * @param {Array<Array<Object>>} ruleset array of condition groups
 * @param {Object} facts {path, headers, cookies}
 * @returns {Boolean}
 */
function matchRuleset(ruleset, facts) {
  if (!Array.isArray(ruleset) || ruleset.length === 0) return false;
  return ruleset.some(group => matchGroup(group, facts));
}

export { matchRuleset, matchGroup, matchCondition, resolveTarget };
