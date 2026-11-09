import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, checkResult, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';
import { scanFile, scanVault, toReportFindings } from '../lib/secrets.js';

export const name = 'scan-secrets';
export const summary = 'Scan a vault (raw sources and compiled notes) or one file for secret patterns';
export const usage = '<vault-or-file>';

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('scan-secrets needs exactly one argument: <vault-or-file>');
  const target = resolve(ctx.args[0]);
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new UsageError(`not found: ${target}`);
  }
  const results = info.isDirectory()
    ? await scanVault(await requireInstance(target))
    : (await scanFile(target)).map((f) => ({ ...f, path: basename(target) }));

  const report = buildReport({
    frameworkVersion: ctx.version,
    vault: target,
    checks: [checkResult('secret-scan', toReportFindings(results))],
  });
  ctx.print(ctx.json ? formatJson(report) : formatHuman(report));
  return exitCodeFor(report);
}
