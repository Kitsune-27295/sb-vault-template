import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { frameworkVersion } from '../lib/paths.js';
import { finding } from '../lib/report.js';
import { LOCK_PATH } from '../lib/zones.js';

export const id = 'framework-version';

/**
 * @param {string} version
 * @returns {[number, number, number] | null} major, minor, patch; a pre-release or build suffix is ignored
 */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * The framework version recorded in `90-system/framework.lock` is compatible
 * with the installed framework. Same version: fine. Same major but an older
 * lock: warning, run `sbk upgrade`. Same major but a newer lock: warning, the
 * installed framework may not know the Instance's rules. A different major
 * either way: error. A missing lock record is an error too, though `doctor`
 * normally refuses such a folder before any check runs (it is not an Instance).
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const lockFinding = (/** @type {import('../lib/report.js').Severity} */ severity, /** @type {string} */ rule, /** @type {string} */ message) => [
    finding(LOCK_PATH, rule, severity, message),
  ];
  let text;
  try {
    text = await readFile(join(vault, LOCK_PATH), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    return lockFinding('error', 'lock-missing', 'the framework lock record is missing; a folder without it is not an Instance');
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return lockFinding('error', 'lock-invalid', 'the lock record is not valid JSON');
  }
  const recorded = lock !== null && typeof lock === 'object' ? lock.framework_version : undefined;
  const locked = typeof recorded === 'string' ? parseVersion(recorded) : null;
  if (locked === null) {
    return lockFinding('error', 'lock-invalid', 'framework_version must be a version like 1.2.3');
  }
  const installedText = frameworkVersion();
  const installed = /** @type {[number, number, number]} */ (parseVersion(installedText));

  if (locked[0] !== installed[0]) {
    const direction = locked[0] < installed[0] ? 'older' : 'newer';
    return lockFinding(
      'error',
      'framework-incompatible',
      `the Instance is locked to framework ${recorded}, a ${direction} major version than the installed ${installedText}`,
    );
  }
  for (let part = 1; part < 3; part++) {
    if (locked[part] === installed[part]) continue;
    return locked[part] < installed[part]
      ? lockFinding(
          'warning',
          'framework-lock-outdated',
          `the Instance is locked to framework ${recorded}, older than the installed ${installedText}; run sbk upgrade`,
        )
      : lockFinding(
          'warning',
          'framework-lock-newer',
          `the Instance is locked to framework ${recorded}, newer than the installed ${installedText}; install a newer framework`,
        );
  }
  return [];
}
