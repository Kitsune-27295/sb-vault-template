/**
 * @typedef {'error' | 'warning' | 'info'} Severity
 *
 * @typedef {object} Finding
 * @property {string} path vault-relative path with forward slashes
 * @property {string} rule stable identifier of the violated rule
 * @property {Severity} severity
 * @property {string} message
 * @property {number} [line] 1-based line number, for findings that point into a file
 *
 * @typedef {object} CheckResult
 * @property {string} id stable check identifier
 * @property {'pass' | 'fail'} status `fail` when any finding is an error
 * @property {Finding[]} findings
 *
 * @typedef {object} Report
 * @property {string} framework_version
 * @property {string} vault absolute vault path
 * @property {CheckResult[]} checks
 * @property {{ checks: number, passed: number, failed: number, errors: number, warnings: number, infos: number }} summary
 */

/**
 * The one constructor of a finding.
 * @param {string} path vault-relative path with forward slashes
 * @param {string} rule stable identifier of the violated rule
 * @param {Severity} severity
 * @param {string} message
 * @param {number} [line] 1-based line number, for findings that point into a file
 * @returns {Finding}
 */
export function finding(path, rule, severity, message, line) {
  return { path, rule, severity, message, ...(line === undefined ? {} : { line }) };
}

/**
 * One finding for many imported notes that break the same rule: the count and the first few paths.
 * @param {string[]} paths vault-relative paths, at least one
 * @param {string} rule
 * @param {Severity} severity
 * @param {string} what what is true of each note, e.g. "has no coverage declaration"
 * @returns {Finding}
 */
export function importedSummary(paths, rule, severity, what) {
  const shown = paths.slice(0, 5).join(', ');
  const more = paths.length > 5 ? `, and ${paths.length - 5} more` : '';
  return finding(paths[0], rule, severity, `${paths.length} imported notes ${what} (first: ${shown}${more}); notes without the imported_from marker are still checked one by one`);
}

/**
 * @param {string} id
 * @param {Finding[]} findings
 * @returns {CheckResult}
 */
export function checkResult(id, findings) {
  const failed = findings.some((f) => f.severity === 'error');
  return { id, status: failed ? 'fail' : 'pass', findings };
}

/**
 * @param {{ frameworkVersion: string, vault: string, checks: CheckResult[] }} input
 * @returns {Report}
 */
export function buildReport({ frameworkVersion, vault, checks }) {
  const count = (/** @type {Severity} */ severity) =>
    checks.reduce((n, c) => n + c.findings.filter((f) => f.severity === severity).length, 0);
  const failed = checks.filter((c) => c.status === 'fail').length;
  return {
    framework_version: frameworkVersion,
    vault,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.length - failed,
      failed,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
    },
  };
}

/**
 * Exit code contract: 0 no errors, 1 violations found. (2 is reserved for usage/internal errors.)
 * @param {Report} report
 * @returns {0 | 1}
 */
export function exitCodeFor(report) {
  return report.summary.errors > 0 ? 1 : 0;
}

/**
 * @param {Report} report
 * @returns {string} machine-readable report
 */
export function formatJson(report) {
  return JSON.stringify(report, null, 2) + '\n';
}

/**
 * @param {Report} report
 * @returns {string} human-readable summary
 */
export function formatHuman(report) {
  const lines = [`sbk ${report.framework_version} - ${report.vault}`, ''];
  for (const check of report.checks) {
    lines.push(`${check.status === 'pass' ? 'PASS' : 'FAIL'}  ${check.id}`);
    for (const f of check.findings) {
      lines.push(`  ${f.severity}: ${f.path} [${f.rule}] ${f.message}`);
    }
  }
  const s = report.summary;
  lines.push(
    '',
    `${s.checks} checks, ${s.passed} passed, ${s.failed} failed; ` +
      `${s.errors} errors, ${s.warnings} warnings, ${s.infos} infos`,
  );
  return lines.join('\n') + '\n';
}
