import { UsageError } from '../lib/errors.js';
import { checkDocs } from '../lib/docs-check.js';
import { requireDirectory } from '../lib/instance.js';
import { FRAMEWORK_ROOT } from '../lib/paths.js';
import { buildReport, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';

export const name = 'docs-check';
export const summary = 'Verify the repository documentation against the commands and doctor checks that exist';
export const usage = '[repo-root]';

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length > 1) throw new UsageError('docs-check takes at most one argument: [repo-root]');
  const root = ctx.args.length === 1 ? await requireDirectory(ctx.args[0], 'repository root') : FRAMEWORK_ROOT;

  const report = buildReport({ frameworkVersion: ctx.version, vault: root, checks: await checkDocs(root) });
  ctx.print(ctx.json ? formatJson(report) : formatHuman(report));
  return exitCodeFor(report);
}
