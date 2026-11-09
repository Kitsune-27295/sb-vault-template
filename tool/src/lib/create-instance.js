import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { UsageError } from './errors.js';
import { writeLock } from './lock.js';
import { hashSystemFiles, listSystemFiles } from './system-files.js';

/**
 * Throws UsageError unless `target` is absent or an empty directory.
 * @param {string} target absolute path
 * @returns {Promise<void>}
 */
export async function assertEmptyOrMissing(target) {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory()) throw new UsageError(`target exists and is not a folder: ${target}`);
  if ((await readdir(target)).length > 0) {
    throw new UsageError(`target folder is not empty, nothing was written: ${target}`);
  }
}

/**
 * Create an Instance: copy the template into the folder and write the framework lock record. The one
 * implementation behind `init` and `import`; the caller has checked the target with `assertEmptyOrMissing`.
 * @param {object} input
 * @param {string} input.target absolute path of an empty or missing folder
 * @param {string} input.template absolute path of the template folder
 * @param {string} input.version framework version to record
 * @param {string} [input.createdAt] ISO time to record; default now
 * @returns {Promise<void>}
 */
export async function createInstance({ target, template, version, createdAt = new Date().toISOString() }) {
  await mkdir(target, { recursive: true });
  await cp(template, target, { recursive: true });
  const files = await hashSystemFiles(target, await listSystemFiles(target));
  await writeLock(target, { framework_version: version, created_at: createdAt, files });
}
