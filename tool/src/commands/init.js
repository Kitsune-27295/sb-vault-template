import { assertEmptyOrMissing, createInstance } from '../lib/create-instance.js';
import { UsageError } from '../lib/errors.js';
import { resolveUserPath } from '../lib/paths.js';
import { buildReport, checkResult, formatHuman, formatJson } from '../lib/report.js';
import { resolveTemplate } from '../lib/system-files.js';
import { LOCK_PATH, ZONE_FOLDERS } from '../lib/zones.js';

export const name = 'init';
export const summary = 'Create a new Instance in an empty folder';
export const usage = '<target> [--template <dir>]';
export const options = { template: { type: 'string' } };

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('init needs exactly one argument: <target>');
  const target = resolveUserPath(ctx.args[0]);
  const template = await resolveTemplate(ctx.values.template);
  await assertEmptyOrMissing(target);
  await createInstance({ target, template, version: ctx.version });

  const report = buildReport({
    frameworkVersion: ctx.version,
    vault: target,
    checks: [checkResult('init', [])],
  });
  ctx.print(
    ctx.json
      ? formatJson(report)
      : `Created instance at ${target}\nZones: ${ZONE_FOLDERS.join(', ')}\nLock: ${LOCK_PATH}\n\n${formatHuman(report)}`,
  );
  return 0;
}
