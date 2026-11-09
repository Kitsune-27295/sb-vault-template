import { DerivedError, writeDerived } from '../lib/derived.js';
import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, checkResult, formatJson } from '../lib/report.js';

export const name = 'index';
export const summary = 'Regenerate the root index, the Zone indexes and the counts in 50-ops/hot.md';
export const usage = '<vault>';

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('index needs exactly one argument: <vault>');
  const vault = await requireInstance(ctx.args[0]);

  let result;
  try {
    result = await writeDerived(vault);
  } catch (error) {
    if (error instanceof DerivedError) throw new UsageError(`${error.path} ${error.message}; nothing was written`);
    throw error;
  }
  const report = buildReport({
    frameworkVersion: ctx.version,
    vault,
    checks: [checkResult('index', [])],
  });
  const lines = [
    ...result.written.map((p) => `wrote ${p}`),
    `${result.written.length} written, ${result.unchanged.length} unchanged`,
  ];
  ctx.print(ctx.json ? formatJson(report) : `${lines.join('\n')}\n`);
  return 0;
}
