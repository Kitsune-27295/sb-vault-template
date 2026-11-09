/**
 * Printing for `attach` and `detach`: `--print` outputs the paste-ready block and writes nothing
 * (for tools with no global file, such as Cursor User Rules); `emit` is the one place a result
 * is printed as the shared JSON report or as human text, and turned into an exit code.
 */
import { buildReport, exitCodeFor, formatHuman, formatJson } from './report.js';

/**
 * Print a result and return its exit code.
 * @param {import('../cli.js').CommandContext} ctx
 * @param {import('./report.js').Report} report
 * @param {{ extra?: Record<string, unknown>, human?: string }} [options] `extra` fields are added to the JSON report;
 *   `human` is the text printed without `--json` (the formatted report when absent)
 * @returns {number} exit code
 */
export function emit(ctx, report, { extra = {}, human } = {}) {
  ctx.print(ctx.json ? formatJson({ ...report, ...extra }) : (human ?? formatHuman(report)));
  return exitCodeFor(report);
}

/**
 * @param {boolean} existed the file existed before the write
 * @param {string | null} backup the backup made now
 * @returns {string} what happened about the backup
 */
export function backupNote(existed, backup) {
  if (backup !== null) return `backup: ${backup}`;
  return existed ? 'no new backup: the first backup of this file already exists' : 'no backup: the file did not exist before';
}

/**
 * @param {import('../cli.js').CommandContext} ctx
 * @param {object} input
 * @param {string} input.vault path shown as the report's `vault`
 * @param {string[]} input.targets target names the block is printed for
 * @param {string[]} input.block the block, one string per line
 * @returns {number} exit code
 */
export function runPrint(ctx, { vault, targets, block }) {
  const report = buildReport({ frameworkVersion: ctx.version, vault, checks: [] });
  return emit(ctx, report, { extra: { print: { targets, block: block.join('\n') } }, human: `${block.join('\n')}\n` });
}
