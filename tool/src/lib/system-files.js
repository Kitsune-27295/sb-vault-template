import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { UsageError } from './errors.js';
import { listFiles } from './files.js';
import { hashFile } from './hashing.js';
import { TEMPLATE_DIR } from './paths.js';
import { LOCK_PATH, ZONES } from './zones.js';

/** Suffix of the file `upgrade` writes beside a System file the curator modified. */
export const INCOMING_SUFFIX = '.incoming';

/**
 * The System files a framework template manages: every file under its System
 * zone except the lock record, placeholders and `.incoming` leftovers. Paths
 * are vault-relative with forward slashes, so they are the same on every
 * platform and are the keys of the lock record's `files` map.
 * @param {string} root absolute path of a vault or template folder
 * @returns {Promise<string[]>} sorted vault-relative paths
 */
export async function listSystemFiles(root) {
  const files = await listFiles(join(root, ZONES.system));
  return files
    .map((file) => `${ZONES.system}/${file}`)
    .filter((path) => path !== LOCK_PATH && !path.endsWith(INCOMING_SUFFIX));
}

/**
 * @param {string} root absolute folder
 * @param {string[]} paths vault-relative paths
 * @returns {Promise<Record<string, string>>} path to sha256 (CRLF-normalized for text)
 */
export async function hashSystemFiles(root, paths) {
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const path of paths) hashes[path] = await hashFile(join(root, path));
  return hashes;
}

/**
 * Resolve the `--template` option: the bundled template when absent, otherwise
 * a folder that must hold a System zone.
 * @param {string | undefined} value
 * @returns {Promise<string>} absolute template path
 */
export async function resolveTemplate(value) {
  if (value === undefined) return TEMPLATE_DIR;
  const template = resolve(value);
  let info;
  try {
    info = await stat(join(template, ZONES.system));
  } catch {
    throw new UsageError(`template has no ${ZONES.system} folder: ${template}`);
  }
  if (!info.isDirectory()) throw new UsageError(`template has no ${ZONES.system} folder: ${template}`);
  return template;
}
