import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { resolveUserPath } from './paths.js';
import { LOCK_PATH } from './zones.js';

/**
 * Validate a folder argument and return its absolute path.
 * @param {string} path path as given on the command line
 * @param {string} what what the folder is called in the message, such as `vault`
 * @returns {Promise<string>} absolute path
 * @throws {UsageError} when the folder is missing or is not a folder
 */
export async function requireDirectory(path, what) {
  const absolute = resolveUserPath(path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new UsageError(`${what} not found: ${absolute}`);
  }
  if (!info.isDirectory()) throw new UsageError(`${what} is not a directory: ${absolute}`);
  return absolute;
}

/**
 * Validate the vault argument of a command that works on an Instance and
 * return its absolute path. A folder is an Instance only when it holds the
 * framework lock record (`90-system/framework.lock`, written by `init`), so a
 * command never writes into an arbitrary folder. The lock's content is not read
 * here: an unreadable lock is a finding for `doctor`, not a reason to refuse.
 * @param {string} vaultPath vault path as given on the command line
 * @returns {Promise<string>} absolute vault path
 * @throws {UsageError} when the folder is missing, is not a folder or is not an Instance
 */
export async function requireInstance(vaultPath) {
  const vault = await requireDirectory(vaultPath, 'vault');
  let lock;
  try {
    lock = await stat(join(vault, ...LOCK_PATH.split('/')));
  } catch {
    lock = null;
  }
  if (lock === null || !lock.isFile()) {
    throw new UsageError(
      `not an Instance, ${LOCK_PATH} is missing: ${vault}; only \`sbk init\` creates an Instance; nothing was written`,
    );
  }
  return vault;
}
