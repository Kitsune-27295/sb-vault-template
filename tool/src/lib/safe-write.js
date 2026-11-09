/**
 * Writing to a user's own files safely (ADR 0005): one backup of the pristine original, then an
 * atomic replace through a uniquely named temporary file that never outlives a failure.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { slash } from './paths.js';

/** @returns {string} the UTC time as 20261109T123456Z */
function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * Copy `file` to `<file>.sbk-backup-<UTC time>`, unless a backup of it already exists: the first
 * backup is the pristine original, and repeated attach and detach cycles never pile up copies.
 * @param {string} file an existing file
 * @returns {Promise<string | null>} the new backup path with forward slashes, or null when one already existed
 */
export async function backupOnce(file) {
  const prefix = `${basename(file)}.sbk-backup-`;
  if ((await readdir(dirname(file))).some((name) => name.startsWith(prefix))) return null;
  const base = `${file}.sbk-backup-${stamp()}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    try {
      await copyFile(file, candidate, 1); // COPYFILE_EXCL: never overwrite a backup
      return slash(candidate);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Write `text` to `file` through a temporary file in the same folder, renamed over it, so a reader
 * never sees a half-written file. The temporary name is random, and the file is removed on failure.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeAtomic(file, text) {
  const temp = `${file}.sbk-tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Move a finished folder into place with one rename. `to` is absent or an empty folder; an empty
 * one is removed just before, because Windows will not rename onto it, and made again when the
 * rename fails, so a failure leaves `to` as it was.
 * @param {string} from the folder to move, on the same volume as `to`
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function moveFolderInto(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error;
  }
  await rmdir(to); // refuses a folder that is not empty
  try {
    await rename(from, to);
  } catch (error) {
    await mkdir(to).catch(() => {});
    throw error;
  }
}

/**
 * Move one file or folder with one rename; `to` must not exist. The one place `migrate-vault`
 * renames root entries, so the atomic-rename rule keeps a single home.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function moveEntry(from, to) {
  await rename(from, to);
}

/**
 * Write a user file: the one backup first when the file exists, then the atomic replace.
 * @param {string} file
 * @param {boolean} existed whether the file exists now
 * @param {string} text the new content
 * @returns {Promise<string | null>} the backup made, or null when none was needed or one already existed
 */
export async function writeTarget(file, existed, text) {
  const backup = existed ? await backupOnce(file) : null;
  await writeAtomic(file, text);
  return backup;
}
