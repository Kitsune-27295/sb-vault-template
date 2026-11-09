import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../errors.js';
import { loadModules } from '../discover.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'adapters');

/**
 * Two entries whose confidence differs by less than this (0.05, so a gap of exactly 0.05 is decided) are too close to
 * choose between: `--from auto` refuses and lists them. Detect-only entries count too, so a vault
 * that looks like an adapter's framework and like a detect-only one is refused, never guessed.
 */
export const TIE_MARGIN = 0.05;

/**
 * An adapter is one file in `src/lib/migrate/adapters/` exporting these members. A DETECT-ONLY entry
 * is the same kind of file with `detectOnly = true`, an `applyRefusal` and no `plan`: it takes part
 * in detection but can never plan an import.
 * @typedef {object} Adapter
 * @property {string} id stable identifier, used by `--from` and in the imported-area path
 * @property {string} summary one line: what it detects
 * @property {boolean} [detectOnly] true for a framework that is recognized but has no adapter yet
 * @property {string} [applyRefusal] detect-only: why `--apply` is refused (completes "refused because ...")
 * @property {(root: string, context: { files: string[] }) => Promise<{ confidence: number, evidence: string[] }>} detect
 *   confidence from 0 to 1 that the vault was built with this framework, and what showed it
 * @property {(root: string, context: { files: string[] }) => Promise<import('./plan.js').PlanEntry[]>} [plan]
 *   one entry per source file; `context.files` lists every file of the source (absent when detect-only)
 *
 * @typedef {object} Detection
 * @property {string} adapter id of the chosen adapter
 * @property {number} confidence
 * @property {string[]} evidence
 * @property {{ id: string, confidence: number }[]} candidates every adapter, best first
 */

/** @returns {Promise<Adapter[]>} every adapter, in file-name order */
export async function loadAdapters() {
  const adapters = /** @type {Adapter[]} */ (await loadModules(ADAPTERS_DIR));
  for (const adapter of adapters) {
    const planless = adapter.detectOnly === true && adapter.plan === undefined;
    if (typeof adapter.id !== 'string' || typeof adapter.detect !== 'function' || (!planless && typeof adapter.plan !== 'function')) {
      throw new Error('an adapter file must export id, detect and plan (a detect-only file: id, detect, detectOnly and no plan)');
    }
  }
  return adapters;
}

/**
 * @param {Adapter[]} adapters
 * @returns {{ id: string, detects: string, status: 'adapter' | 'detect-only' }[]} what `--list-adapters` prints
 */
export function describeAdapters(adapters) {
  return adapters.map((a) => ({ id: a.id, detects: a.summary, status: a.detectOnly === true ? 'detect-only' : 'adapter' }));
}

/**
 * Choose the adapter. `from` names one, or is `auto`: the highest confidence wins, a tie is refused,
 * and a vault no adapter recognizes is refused with the way out.
 * @param {string} root absolute source path
 * @param {string[]} files every source file
 * @param {string} from adapter id or `auto`
 * @param {Adapter[]} adapters
 * @returns {Promise<{ adapter: Adapter, detection: Detection }>}
 * @throws {UsageError}
 */
export async function chooseAdapter(root, files, from, adapters) {
  /** @type {Map<string, { confidence: number, evidence: string[] }>} */
  const found = new Map();
  for (const adapter of adapters) found.set(adapter.id, await adapter.detect(root, { files }));
  const candidates = adapters
    .map((a) => ({ id: a.id, confidence: /** @type {{ confidence: number }} */ (found.get(a.id)).confidence }))
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));
  const known = adapters.map((a) => a.id).join(', ');

  let chosen;
  if (from === 'auto') {
    const [best, next] = candidates;
    if (best === undefined || best.confidence <= 0) {
      throw new UsageError(`no adapter recognizes this folder; to import it anyway use --from generic (adapters: ${known})`);
    }
    // Differences are rounded to two decimals so that float noise (0.2 - 0.15 is 0.05000000000000002) cannot move a gap across the margin.
    const gap = (/** @type {number} */ c) => Math.round((best.confidence - c) * 100) / 100;
    if (next !== undefined && next.confidence > 0 && gap(next.confidence) < TIE_MARGIN) {
      const list = candidates.filter((c) => gap(c.confidence) < TIE_MARGIN).map((c) => `${c.id} (${c.confidence})`);
      throw new UsageError(`the adapters cannot be told apart: ${list.join(', ')}; choose one with --from <adapter>`);
    }
    chosen = best.id;
  } else {
    if (!adapters.some((a) => a.id === from)) throw new UsageError(`unknown adapter "${from}"; adapters: ${known}`);
    chosen = from;
  }
  const adapter = /** @type {Adapter} */ (adapters.find((a) => a.id === chosen));
  const detection = /** @type {{ confidence: number, evidence: string[] }} */ (found.get(chosen));
  return { adapter, detection: { adapter: chosen, ...detection, candidates } };
}
