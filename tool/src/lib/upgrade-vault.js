/**
 * The framework upgrade of an Instance's System zone: the one implementation behind `upgrade` and
 * `migrate-vault` (for an Instance that is already on this framework).
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashFile } from './hashing.js';
import { readLock, writeLock } from './lock.js';
import { checkResult, finding } from './report.js';
import { INCOMING_SUFFIX, hashSystemFiles, listSystemFiles } from './system-files.js';

/**
 * @typedef {'added' | 'updated' | 'unchanged' | 'conflict'} Action
 * @typedef {{ path: string, action: Action }} Change
 * @typedef {object} UpgradeResult
 * @property {boolean} applied
 * @property {string} from_version
 * @property {string} to_version
 * @property {Change[]} changes
 */

/**
 * Decide what to do with one System file of the new template.
 *
 * `installed` is the hash the lock recorded when the framework last wrote the
 * file; comparing it with the Instance's current hash tells whether the
 * curator modified it.
 * @param {{ current: string | undefined, incoming: string, installed: string | undefined }} hashes
 * @returns {Action}
 */
function decide({ current, incoming, installed }) {
  if (current === undefined) return 'added';
  if (current === incoming) return 'unchanged';
  // The template did not change this file since it was installed: keep the curator's version.
  if (installed === incoming) return 'unchanged';
  // The curator did not modify it: take the new template version.
  if (installed !== undefined && current === installed) return 'updated';
  // Both sides changed (or the lock has no record to prove the curator did not): never overwrite.
  return 'conflict';
}

/**
 * @param {string} path absolute path
 * @returns {Promise<string | undefined>} hash, or undefined when the file does not exist
 */
async function hashIfPresent(path) {
  try {
    return await hashFile(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Plan, and with `apply` perform, the upgrade of the System zone.
 * @param {object} input
 * @param {string} input.vault absolute Instance path
 * @param {string} input.template absolute template path
 * @param {boolean} input.apply
 * @param {string} input.version framework version
 * @returns {Promise<UpgradeResult>}
 */
export async function upgradeInstance({ vault, template, apply, version }) {
  const lock = await readLock(vault);
  const recorded = lock.files ?? {};

  // Plan: compare each System file of the template with the Instance's copy. Nothing else is read.
  const paths = await listSystemFiles(template);
  const incoming = await hashSystemFiles(template, paths);
  /** @type {Change[]} */
  const changes = [];
  /** @type {Record<string, string | undefined>} */
  const currents = {};
  for (const path of paths) {
    const current = await hashIfPresent(join(vault, path));
    currents[path] = current;
    changes.push({ path, action: decide({ current, incoming: incoming[path], installed: recorded[path] }) });
  }
  const conflicts = changes.filter((c) => c.action === 'conflict');

  if (apply) {
    for (const { path, action } of changes) {
      if (action === 'unchanged') continue;
      const destination = action === 'conflict' ? join(vault, path + INCOMING_SUFFIX) : join(vault, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(template, path), destination);
    }
    // The lock is written last. A conflicted file keeps its old record (so the conflict stays
    // visible on the next run) and the version moves only when nothing is left to resolve.
    /** @type {Record<string, string>} */
    const files = { ...recorded };
    for (const { path, action } of changes) {
      const identical = currents[path] === incoming[path];
      if (action === 'added' || action === 'updated' || (action === 'unchanged' && identical)) {
        files[path] = incoming[path];
      }
    }
    await writeLock(vault, {
      ...lock,
      framework_version: conflicts.length === 0 ? version : lock.framework_version,
      files,
    });
  }
  return { applied: apply, from_version: lock.framework_version, to_version: version, changes };
}

/**
 * @param {UpgradeResult} result
 * @returns {import('./report.js').CheckResult} the `upgrade` check: one finding per changed file
 */
export function upgradeCheck(result) {
  const { applied: apply } = result;
  /** @type {import('./report.js').Finding[]} */
  const findings = result.changes
    .filter((c) => c.action !== 'unchanged')
    .map(({ path, action }) =>
      action === 'conflict'
        ? finding(
            path,
            'system-file-conflict',
            'error',
            `modified since installed; ${apply ? 'incoming version written to' : 'incoming version would be written to'} ${path}${INCOMING_SUFFIX}, file not overwritten`,
          )
        : finding(path, `system-file-${action}`, 'info', `${apply ? '' : 'would be '}${action}`),
    );
  return checkResult('upgrade', findings);
}
