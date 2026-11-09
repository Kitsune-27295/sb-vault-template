import { isDerivedFresh, writeDerived } from '../lib/derived.js';
import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { appendEntry, CAPTURE_ACTIONS } from '../lib/log.js';
import { buildReport, checkResult, formatHuman, formatJson } from '../lib/report.js';

export const name = 'log';
export const summary = 'Append an entry to the hash-chained operations log';
export const usage = '<vault> --action <a> --title <t> [--body <text>] [--date YYYY-MM-DD]';
export const options = {
  action: { type: /** @type {'string'} */ ('string') },
  title: { type: /** @type {'string'} */ ('string') },
  body: { type: /** @type {'string'} */ ('string') },
  date: { type: /** @type {'string'} */ ('string') },
};

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('log needs exactly one argument: <vault>');
  const { action, title, body, date } = ctx.values;
  if (action === undefined) throw new UsageError('log needs --action <action>');
  if (title === undefined) throw new UsageError('log needs --title <title>');
  if (CAPTURE_ACTIONS.includes(action)) {
    throw new UsageError(`the action "${action}" is reserved for \`sbk capture\`, which logs each source it seals; nothing was written`);
  }
  const vault = await requireInstance(ctx.args[0]);

  // The log feeds derived state (last log date, the Operations index); keep fresh state fresh.
  const wasFresh = await isDerivedFresh(vault);
  const entry = await appendEntry({ vault, action, title, body, date });
  if (wasFresh) await writeDerived(vault);
  const report = buildReport({
    frameworkVersion: ctx.version,
    vault,
    checks: [checkResult('log', [])],
  });
  ctx.print(
    ctx.json ? formatJson(report) : `Appended to ${entry.file}\n${entry.header}\nchain: ${entry.chain}\n`,
  );
  return 0;
}
