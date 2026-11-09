import { loadRawSources } from '../lib/sources.js';
import { toVaultPath } from '../lib/paths.js';
import { finding } from '../lib/report.js';

export const id = 'supersede-reference';

/**
 * The `supersedes` and `superseded_by` fields in raw-source sidecars form
 * consistent chains: every id they hold names an existing raw source, no source
 * points at itself, the chain never loops back, and each link is recorded on
 * both sides (A `superseded_by` B needs B `supersedes` A, and the reverse).
 * Sidecars that are missing or invalid are left to `raw-source-integrity`.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const all = await loadRawSources(vault);
  const sources = all.filter((s) => s.sidecar !== null);
  const known = new Set(all.map((s) => s.id));
  const byId = new Map(sources.map((s) => [s.id, s]));
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  const error = (/** @type {import('../lib/sources.js').RawSourceEntry} */ source, /** @type {string} */ rule, /** @type {string} */ message) =>
    findings.push(finding(toVaultPath(vault, source.sidecarPath), rule, 'error', message));

  /** @type {Array<['supersedes' | 'superseded_by', 'superseded_by' | 'supersedes']>} */
  const directions = [
    ['supersedes', 'superseded_by'],
    ['superseded_by', 'supersedes'],
  ];

  for (const source of sources) {
    const sidecar = /** @type {import('../lib/sidecar.js').Sidecar} */ (source.sidecar);
    for (const [field, reverse] of directions) {
      const target = sidecar[field];
      if (target === undefined) continue;
      if (target === source.id) {
        error(source, 'supersede-cycle', `${field} points at the source itself (${target})`);
        continue;
      }
      const other = byId.get(target);
      if (!other) {
        // A target whose own sidecar is broken exists; raw-source-integrity reports that.
        if (!known.has(target)) error(source, 'supersede-dangling', `${field} names ${target}, which is not a raw source in 10-sources/`);
        continue;
      }
      if (/** @type {import('../lib/sidecar.js').Sidecar} */ (other.sidecar)[reverse] !== source.id) {
        error(source, 'supersede-mismatch', `${field} names ${target}, but that source does not record ${reverse} ${source.id}`);
      }
    }
  }

  // A chain loops when following one direction from a source leads back to it.
  for (const source of sources) {
    for (const [field] of directions) {
      const seen = new Set([source.id]);
      let next = /** @type {import('../lib/sidecar.js').Sidecar} */ (source.sidecar)[field];
      while (next !== undefined && next !== source.id && !seen.has(next)) {
        seen.add(next);
        const entry = byId.get(next);
        next = entry ? /** @type {import('../lib/sidecar.js').Sidecar} */ (entry.sidecar)[field] : undefined;
      }
      if (next === source.id && /** @type {import('../lib/sidecar.js').Sidecar} */ (source.sidecar)[field] !== source.id) {
        error(source, 'supersede-cycle', `the ${field} chain from ${source.id} loops back to it`);
        break;
      }
    }
  }
  return findings;
}
