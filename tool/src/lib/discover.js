import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Import every `.js` module in a folder, sorted by file name. Used so commands
 * and checks are added by dropping one file in a folder, with no central list
 * to edit.
 * @param {string} dir absolute folder path
 * @returns {Promise<any[]>} module namespaces in file-name order
 */
export async function loadModules(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.js')).sort();
  return Promise.all(names.map((n) => import(pathToFileURL(join(dir, n)).href)));
}
