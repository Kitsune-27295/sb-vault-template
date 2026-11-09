/**
 * Execution: write the Instance from the plan and nothing else. Every write uses the exclusive flag,
 * so nothing is overwritten, and the source is only ever read. What each file holds comes from
 * `derive.js`, the same code verification recomputes it with.
 */
import { constants } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashBytes } from '../hashing.js';
import { displayPath } from '../secret-names.js';
import { sidecarPathFor } from '../sidecar.js';
import { makeDeriver } from './derive.js';

/**
 * @param {object} input
 * @param {string} input.root absolute source path
 * @param {string} input.target absolute path of the new Instance, already created
 * @param {import('./plan.js').Plan} input.plan
 * @param {string[]} input.reserved paths the Instance held before the import
 * @param {import('../schema.js').Schema} input.schema the Instance schema
 * @returns {Promise<void>} sets `target_sha256` on each entry whose bytes the engine wrote
 */
export async function executePlan({ root, target, plan, reserved, schema }) {
  const derive = makeDeriver({ root, plan, reserved, schema });
  for (const entry of plan.entries) {
    if (entry.destination === null) continue;
    const to = join(target, ...entry.destination.split('/'));
    await mkdir(dirname(to), { recursive: true });
    let derived;
    try {
      derived = await derive(entry);
    } catch (error) {
      throw new Error(`${displayPath(entry.source)}: ${/** @type {Error} */ (error).message}`);
    }
    if (derived.text === null) {
      await copyFile(join(root, ...entry.source.split('/')), to, constants.COPYFILE_EXCL);
    } else {
      await writeFile(to, derived.text, { encoding: 'utf8', flag: 'wx' });
      entry.target_sha256 = hashBytes(Buffer.from(derived.text, 'utf8'));
    }
    // A raw source whose framework kept no sidecar gets one from the seed the adapter planned.
    if (derived.sidecar !== null) await writeFile(sidecarPathFor(to), derived.sidecar, { encoding: 'utf8', flag: 'wx' });
  }
}
