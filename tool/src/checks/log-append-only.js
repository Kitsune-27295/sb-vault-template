import { LOG_DIR, readLog, verifyLog } from '../lib/log.js';
import { finding } from '../lib/report.js';

export const id = 'log-append-only';

/**
 * `50-ops/log/` only grows: every entry carries a hash chained to the entry
 * before it, so an edited, removed or reordered entry, or a chain broken
 * between monthly files, is reported. Needs no git.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const problems = verifyLog(await readLog(vault));
  return problems.map((p) => finding(`${LOG_DIR}/${p.file}`, p.rule, p.severity, p.message));
}
