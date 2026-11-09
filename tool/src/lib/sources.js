/**
 * Raw sources as the supersede feature sees them: id, file and sidecar.
 *
 * A raw source's id is its file name without the extension; `capture` builds it
 * as `<date>-<slug>-<hash8>` and it is what `supersedes` and `superseded_by`
 * hold. Both fields live in the sidecar, so the raw file itself is never
 * rewritten (ADR 0003).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { listFiles } from './files.js';
import { isSidecarPath, readSidecar, sidecarPathFor } from './sidecar.js';
import { ZONES } from './zones.js';

/**
 * @typedef {object} RawSourceEntry
 * @property {string} id file name without extension
 * @property {string} path absolute path of the raw file
 * @property {string} sidecarPath absolute path of its sidecar
 * @property {import('./sidecar.js').Sidecar | null} sidecar null when the sidecar is missing or invalid
 */

/**
 * @param {string} vault absolute vault path
 * @returns {Promise<RawSourceEntry[]>} every raw source in `10-sources/` with its sidecar, in path order
 */
export async function loadRawSources(vault) {
  const zone = join(vault, ZONES.sources);
  const files = (await listFiles(zone)).filter((f) => !isSidecarPath(f));
  return Promise.all(
    files.map(async (file) => {
      const path = join(zone, ...file.split('/'));
      const sidecarPath = sidecarPathFor(path);
      const read = await readSidecar(sidecarPath).catch(() => ({ problems: ['unreadable'] }));
      return {
        id: basename(path, extname(path)),
        path,
        sidecarPath,
        sidecar: 'sidecar' in read ? read.sidecar : null,
      };
    }),
  );
}

/**
 * Add `superseded_by` to a raw source's sidecar. Every other field is kept;
 * the raw file is not touched.
 * @param {string} sidecarPath absolute path of the sidecar
 * @param {string} newId id of the version that replaces it
 * @returns {Promise<void>}
 */
export async function markSuperseded(sidecarPath, newId) {
  const current = JSON.parse(await readFile(sidecarPath, 'utf8'));
  await writeFile(sidecarPath, JSON.stringify({ ...current, superseded_by: newId }, null, 2) + '\n');
}
