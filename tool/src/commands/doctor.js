import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';
import { runChecks } from '../lib/run-checks.js';

export const name = 'doctor';
export const summary = 'Verify every invariant of a vault and report violations';
export const usage = '<vault>';

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('doctor needs exactly one argument: <vault>');
  const vault = await requireInstance(ctx.args[0]);

  const report = buildReport({ frameworkVersion: ctx.version, vault, checks: await runChecks(vault, ctx.today) });
  ctx.print(ctx.json ? formatJson(report) : formatHuman(report));
  return exitCodeFor(report);
}
