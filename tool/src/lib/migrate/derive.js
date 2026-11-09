/**
 * What the target must hold for each plan entry, derived from the SOURCE and the plan with pure
 * transform functions (frontmatter, links, log chain, sidecar). Execution writes these bytes and
 * verification recomputes them with the very same code, so a target that differs from what the plan
 * implies fails, whoever edited it (ADR 0011).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENESIS } from '../log.js';
import { readSafeText } from '../safe-read.js';
import { chainLogWithPreamble } from './carry-log.js';
import { mapFrontmatter } from './frontmatter-map.js';
import { chainOldLog } from './log-chain.js';
import { linkContext } from './plan.js';
import { rewriteLinks } from './rewrite-links.js';
import { asObject, mapSidecar } from './sidecar-map.js';

/**
 * @typedef {object} Derived
 * @property {string | null} text the text to write, or null when the destination is a byte copy of the source
 * @property {string | null} sidecar the sidecar to write beside a raw source whose framework kept none, or null
 */

/**
 * The sidecar text of one raw source.
 * @param {Record<string, unknown>} old the old sidecar, or the seed the adapter planned
 * @param {import('./plan.js').PlanEntry} raw the raw source entry
 * @param {string} adapter
 * @returns {string}
 */
function sidecarText(old, raw, adapter) {
  const { sidecar } = mapSidecar(old, { sha256: /** @type {string} */ (raw.sha256), mtime: /** @type {string} */ (raw.mtime), source: raw.source }, adapter);
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/**
 * @param {object} input
 * @param {string} input.root absolute source path
 * @param {import('./plan.js').Plan} input.plan
 * @param {string[]} input.reserved paths the Instance held before the import
 * @param {import('../schema.js').Schema} input.schema
 * @returns {(entry: import('./plan.js').PlanEntry) => Promise<Derived>} call it for every entry, in plan order:
 *   the old logs are chained one after the other
 */
export function makeDeriver({ root, plan, reserved, schema }) {
  const context = linkContext(plan.entries, reserved);
  const byPath = new Map(plan.entries.filter((e) => e.reason !== 'original-log-archive').map((e) => [e.source, e]));
  let logChain = GENESIS;

  return async (entry) => {
    const from = join(root, ...entry.source.split('/'));
    /** @type {string | null} */
    let text = null;
    if (entry.kind === 'sidecar') {
      const raw = /** @type {import('./plan.js').PlanEntry} */ (byPath.get(/** @type {string} */ (entry.sidecar_for)));
      const old = /** @type {Record<string, unknown>} */ (asObject(JSON.parse(await readFile(from, 'utf8'))));
      text = sidecarText(old, raw, plan.adapter);
    } else if (entry.transforms.length > 0) {
      const read = await readSafeText(from);
      if (read.status !== 'ok') throw new Error('a source file cannot be rewritten: it ' + (read.status === 'missing' ? 'is missing' : read.reason));
      text = read.text;
      for (const transform of entry.transforms) {
        if (transform === 'links') {
          text = rewriteLinks(text, { from: entry.source, destination: /** @type {string} */ (entry.destination), ...context }).text;
        } else if (transform === 'frontmatter') {
          text = mapFrontmatter(text, { schema, type: /** @type {string} */ (entry.type), modified: /** @type {string} */ (entry.mtime).slice(0, 10), source: entry.source }).text;
        } else if (transform === 'log-chain' || transform === 'log-chain-preamble') {
          const chained = transform === 'log-chain' ? chainOldLog(text, logChain) : chainLogWithPreamble(text, { label: plan.adapter, previous: logChain });
          text = chained.text;
          logChain = chained.chain;
        } else {
          throw new Error(`unknown transform "${transform}"`);
        }
      }
    }
    const seeded = entry.kind === 'raw-source' && entry.sidecar_seed !== undefined ? sidecarText(entry.sidecar_seed, entry, plan.adapter) : null;
    return { text, sidecar: seeded };
  };
}
