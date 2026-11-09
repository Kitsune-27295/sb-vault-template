import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { LOCK_PATH } from './zones.js';

/**
 * The framework lock record, `90-system/framework.lock`.
 * @typedef {object} Lock
 * @property {string} framework_version framework version that last installed the System zone
 * @property {string} created_at ISO 8601 time the Instance was created
 * @property {Record<string, string>} [files] sha256 of each System file as installed, keyed by
 *   vault-relative path; lets `upgrade` tell whether the curator modified it
 */

/**
 * @param {string} vault absolute vault path
 * @returns {Promise<Lock>}
 */
export async function readLock(vault) {
  let text;
  try {
    text = await readFile(join(vault, LOCK_PATH), 'utf8');
  } catch {
    throw new UsageError(`not an instance, ${LOCK_PATH} is missing: ${vault}`);
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw new UsageError(`${LOCK_PATH} is not valid JSON: ${vault}`);
  }
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new UsageError(`${LOCK_PATH} must be a JSON object: ${vault}`);
  }
  return lock;
}

/**
 * @param {string} vault absolute vault path
 * @param {Lock} lock
 * @returns {Promise<void>}
 */
export async function writeLock(vault, lock) {
  await writeFile(join(vault, LOCK_PATH), JSON.stringify(lock, null, 2) + '\n');
}
