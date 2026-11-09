import { DerivedError, diffDerived } from '../lib/derived.js';
import { finding } from '../lib/report.js';

export const id = 'derived-state';

/**
 * The root index, the Zone indexes and the counts block in `50-ops/hot.md` are
 * computed, not written by hand: regenerate them in memory and report every file
 * whose content on disk differs, naming it. A vault that has none of these files
 * has never been indexed and is not checked; once one exists, all must.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  let result;
  try {
    result = await diffDerived(vault);
  } catch (error) {
    if (!(error instanceof DerivedError)) throw error;
    return [finding(error.path, 'derived-malformed', 'error', error.message)];
  }
  if (!result.indexed) return [];
  return result.stale.map((s) => finding(s.path, s.rule, 'error', s.message));
}
