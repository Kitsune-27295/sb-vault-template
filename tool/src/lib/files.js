import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The one existence test: a missing path (or one below a file) is false, any other failure is thrown.
 * @param {string} path absolute path
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Files an operating system or a file manager leaves behind: the one list `dist` and the import engine share. */
export const OS_DROPPINGS = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']);

/** Files no module treats as content: folder placeholders and operating system droppings. */
export const IGNORED_FILE_NAMES = new Set(['.gitkeep', 'Thumbs.db', 'desktop.ini']);

/**
 * @typedef {object} ListOptions
 * @property {boolean} [recursive] descend into sub-folders; default true
 * @property {(name: string, isDirectory: boolean) => boolean} [skip] true to leave out a file, or a
 *   whole folder, by its name
 * @property {boolean} [includeIgnored] list `IGNORED_FILE_NAMES` too, for a caller that must account
 *   for every file; default false
 * @property {(path: string) => void} [onLink] called with the relative path of each symbolic link
 *   or Windows junction met (to a file or a folder); links are never followed or listed either way
 */

/**
 * The one recursive file lister. Lists the regular files below `dir`, leaving
 * out `IGNORED_FILE_NAMES` and whatever `skip` rejects; symbolic links are not
 * followed. A missing folder holds no files.
 * @param {string} dir absolute folder
 * @param {ListOptions} [options]
 * @param {string} [prefix] relative folder being walked (internal)
 * @returns {Promise<string[]>} paths relative to `dir` with forward slashes, in code unit order
 */
export async function listFiles(dir, options = {}, prefix = '') {
  const { recursive = true, skip, includeIgnored = false } = options;
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // The directory scan does not follow links: a link (a junction too) is its own kind of entry.
    if (entry.isSymbolicLink()) {
      options.onLink?.(relative);
    } else if (entry.isDirectory()) {
      if (recursive && !skip?.(entry.name, true)) files.push(...(await listFiles(dir, options, relative)));
    } else if (entry.isFile() && (includeIgnored || !IGNORED_FILE_NAMES.has(entry.name)) && !skip?.(entry.name, false)) {
      files.push(relative);
    }
  }
  return files.sort(byCodeUnit);
}

/**
 * The one locale-independent ordering of path strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
