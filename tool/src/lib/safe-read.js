/**
 * Reading a user's own file before editing it: never through a link, only a regular file, only
 * strict UTF-8 (a byte order mark is kept in the text, so writing it back keeps it).
 */
import { lstat, readFile } from 'node:fs/promises';

/**
 * @typedef {{ status: 'missing' }
 *   | { status: 'refused', rule: 'target-symlink' | 'target-not-file' | 'target-not-utf8', reason: string }
 *   | { status: 'ok', text: string }} SafeRead
 * `reason` completes the sentence "<file> ..." in a message.
 */

/**
 * @param {string} file
 * @returns {Promise<SafeRead>}
 */
export async function readSafeText(file) {
  const info = await lstat(file).catch(() => null);
  if (info === null) return { status: 'missing' };
  if (info.isSymbolicLink()) return { status: 'refused', rule: 'target-symlink', reason: 'is a symbolic link; it is never written through' };
  if (!info.isFile()) return { status: 'refused', rule: 'target-not-file', reason: 'is not a regular file' };
  try {
    return { status: 'ok', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file)) };
  } catch {
    return { status: 'refused', rule: 'target-not-utf8', reason: 'is not valid UTF-8' };
  }
}
