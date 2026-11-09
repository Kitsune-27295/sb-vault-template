import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from '../lib/errors.js';
import { migrateReport, migrateVault, refusalReport, reportMarkdown } from '../lib/migrate-vault.js';
import { exitCodeFor, formatHuman, formatJson } from '../lib/report.js';
import { writeAtomic } from '../lib/safe-write.js';

export const name = 'migrate-vault';
export const summary = 'Migrate a Git working tree to an Instance in place (dry run unless --apply; never touches .git or .github)';
export const usage = '<repo> [--apply] [--report <dir>] [--template <dir>]';
export const options = { apply: { type: 'boolean' }, report: { type: 'string' }, template: { type: 'string' } };

/**
 * @param {ReturnType<typeof migrateReport>} report
 * @returns {string} the human summary
 */
function describe(report) {
  const m = /** @type {any} */ (report.migrate);
  const lines = [];
  if (m.kind === 'foreign') {
    const c = m.counts;
    lines.push(
      `Old vault, adapter ${m.adapter} (confidence ${m.detection.confidence}): ${c.total} entries: ${c.mapped} mapped, ${c.preserved} preserved verbatim, ${c.excluded} excluded, ${c.quarantined} quarantined`,
    );
    for (const q of m.quarantined) lines.push(`Quarantined: ${q.source} -> ${q.destination} (the value is not shown)`);
  } else {
    lines.push(`Instance already on this framework: upgrade ${m.upgrade.from_version} -> ${m.upgrade.to_version}`);
    for (const c of m.upgrade.changes.filter((/** @type {any} */ x) => x.action !== 'unchanged')) lines.push(`  ${c.action.padEnd(9)}  ${c.path}`);
  }
  lines.push(
    m.applied
      ? 'The working tree was changed; .git and .github were not touched.'
      : m.mode === 'apply'
        ? 'The working tree was NOT changed: the Instance failed verification before the swap.'
        : 'Nothing was written (dry run: add --apply to migrate).',
  );
  return `${lines.join('\n')}\n\n`;
}

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('migrate-vault needs exactly one argument: <repo>');
  let outcome;
  try {
    outcome = await migrateVault({
      repoArg: ctx.args[0],
      apply: ctx.values.apply === true,
      reportArg: ctx.values.report,
      template: ctx.values.template,
      version: ctx.version,
      today: ctx.today,
    });
  } catch (error) {
    // A refusal still prints the JSON report when it was asked for, so a caller reads the status and reason.
    if (error instanceof UsageError && ctx.json) ctx.print(formatJson(refusalReport(error, ctx.args[0], ctx.version)));
    throw error;
  }
  const { result, reportDir } = outcome;
  const report = migrateReport(result, ctx.version);
  if (reportDir !== undefined) {
    await mkdir(reportDir, { recursive: true });
    await writeAtomic(join(reportDir, 'migration-report.md'), reportMarkdown(report));
    await writeAtomic(join(reportDir, 'migration-report.json'), formatJson(report));
  }
  ctx.print(ctx.json ? formatJson(report) : `${describe(report)}${formatHuman(report)}`);
  return exitCodeFor(report);
}
