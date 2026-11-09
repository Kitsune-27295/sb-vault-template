import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModules } from './discover.js';
import { checkResult } from './report.js';

const CHECKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'checks');

/**
 * A check is one file in `src/checks/` exporting `id` and `run(ctx)`.
 * @typedef {object} Check
 * @property {string} id stable check identifier
 * @property {(ctx: { vault: string, today: string }) => Promise<import('./report.js').Finding[]>} run
 */

/**
 * Run every doctor check on a vault. The one implementation behind `doctor` and the verification of `import`.
 * @param {string} vault absolute path of an Instance
 * @param {string} today current date, `YYYY-MM-DD`
 * @returns {Promise<import('./report.js').CheckResult[]>}
 */
export async function runChecks(vault, today) {
  const checks = /** @type {Check[]} */ (await loadModules(CHECKS_DIR));
  const results = [];
  for (const check of checks) {
    results.push(checkResult(check.id, await check.run({ vault, today })));
  }
  return results;
}
