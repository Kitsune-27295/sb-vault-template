import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';
import { resolveTemplate } from '../lib/system-files.js';
import { upgradeCheck, upgradeInstance } from '../lib/upgrade-vault.js';

export const name = 'upgrade';
export const summary = 'Preview (default) or apply (--apply) a framework upgrade of the System zone';
export const usage = '<vault> [--apply] [--template <dir>]';
export const options = { apply: { type: 'boolean' }, template: { type: 'string' } };

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('upgrade needs exactly one argument: <vault>');
  const vault = await requireInstance(ctx.args[0]);
  const template = await resolveTemplate(ctx.values.template);
  const apply = ctx.values.apply === true;
  const result = await upgradeInstance({ vault, template, apply, version: ctx.version });
  const { changes } = result;

  const report = {
    ...buildReport({ frameworkVersion: ctx.version, vault, checks: [upgradeCheck(result)] }),
    upgrade: {
      mode: apply ? 'apply' : 'dry-run',
      applied: apply,
      from_version: result.from_version,
      to_version: result.to_version,
      changes,
    },
  };

  if (ctx.json) {
    ctx.print(formatJson(report));
  } else {
    const lines = [
      `${apply ? 'Upgrade applied' : 'Dry run, no file changed'}: ${result.from_version} -> ${result.to_version}`,
      ...changes.map((c) => `  ${c.action.padEnd(9)}  ${c.path}`),
      '',
    ];
    if (!apply) lines.push('Run again with --apply to perform these changes.', '');
    ctx.print(lines.join('\n') + '\n' + formatHuman(report));
  }
  return exitCodeFor(report);
}
