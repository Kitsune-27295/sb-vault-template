import { join } from 'node:path';
import { listFiles } from '../lib/files.js';
import { hashFile } from '../lib/hashing.js';
import { finding } from '../lib/report.js';
import { isSidecarPath, rawSourcePathFor, readSidecar, sidecarPathFor } from '../lib/sidecar.js';
import { ZONE_INDEX_NAME, ZONES } from '../lib/zones.js';

export const id = 'raw-source-integrity';

/**
 * Every raw source matches the sha256 in its sidecar, and every sidecar has a
 * raw source and vice versa.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const zone = join(vault, ZONES.sources);
  // The generated Zone index (`sbk index`) is derived state, not a raw source.
  const files = (await listFiles(zone)).filter((f) => f !== ZONE_INDEX_NAME);
  const present = new Set(files);
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  const error = (/** @type {string} */ file, /** @type {string} */ rule, /** @type {string} */ message) =>
    findings.push(finding(`${ZONES.sources}/${file}`, rule, 'error', message));

  for (const file of files) {
    if (isSidecarPath(file)) {
      if (!present.has(rawSourcePathFor(file))) {
        error(file, 'sidecar-orphan', 'sidecar has no raw source next to it');
      }
      continue;
    }
    const sidecar = sidecarPathFor(file);
    if (!present.has(sidecar)) {
      error(file, 'sidecar-missing', 'raw source has no sidecar (<file>.meta.json)');
      continue;
    }
    const read = await readSidecar(join(zone, ...sidecar.split('/')));
    if ('problems' in read) {
      error(sidecar, 'sidecar-invalid', read.problems.join('; '));
      continue;
    }
    const actual = await hashFile(join(zone, ...file.split('/')));
    if (actual !== read.sidecar.sha256) {
      error(file, 'hash-mismatch', `sha256 is ${actual} but the sidecar records ${read.sidecar.sha256}`);
    }
  }
  return findings;
}
