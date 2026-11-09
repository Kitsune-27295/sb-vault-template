import { UsageError } from '../lib/errors.js';
import { DEFAULT_ZONES, findNotes, resolveZone } from '../lib/find.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, checkResult, exitCodeFor, finding, formatHuman, formatJson } from '../lib/report.js';
import { ZONES } from '../lib/zones.js';

export const name = 'find';
export const summary = 'Search the notes of an Instance (read-only): all terms must match, ranked, accents and case ignored';
export const usage = '<vault> <term>... [--zone <zone>] [--raw] [--limit <n>]';
export const options = {
  zone: { type: /** @type {'string'} */ ('string') },
  raw: { type: /** @type {'boolean'} */ ('boolean') },
  limit: { type: /** @type {'string'} */ ('string') },
};

const DEFAULT_LIMIT = 10;

/** @param {string | undefined} value @returns {number} */
function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9]\d{0,5}$/.test(value.trim())) throw new UsageError(`--limit must be a positive whole number, got "${value}"`);
  return Number(value);
}

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  const [vaultArg, ...words] = ctx.args;
  const terms = words.flatMap((word) => word.split(/\s+/)).filter((term) => term !== '');
  if (vaultArg === undefined || terms.length === 0) throw new UsageError('find needs a vault and at least one term: <vault> <term>...');
  const { zone, raw } = ctx.values;
  if (zone !== undefined && raw === true) throw new UsageError('--raw cannot be combined with --zone; use --zone sources to search the Raw sources alone');
  const limit = parseLimit(ctx.values.limit);
  const zones = zone !== undefined ? [resolveZone(zone)] : raw === true ? [ZONES.sources, ...DEFAULT_ZONES] : DEFAULT_ZONES;
  const vault = await requireInstance(vaultArg);

  const { hits, total } = await findNotes({ vault, terms, zones, limit });
  const report = buildReport({
    frameworkVersion: ctx.version,
    vault,
    checks: [checkResult('find', hits.map((h) => finding(h.path, 'match', 'info', h.snippet, h.line)))],
  });
  const query = { terms, zones, limit, total, shown: hits.length };
  if (ctx.json) {
    ctx.print(formatJson({ ...report, query, hits }));
    return exitCodeFor(report);
  }
  if (hits.length === 0) {
    ctx.print(`no notes match: ${terms.join(' ')}\n`);
    return 0;
  }
  const lines = hits.flatMap((h) => [`${h.path}:${h.line}  ${h.title}`, `    ${h.snippet}`]);
  const more = total > hits.length ? `; ${total - hits.length} more not shown (raise --limit)` : '';
  ctx.print(`${lines.join('\n')}\n\n${hits.length} of ${total} ${total === 1 ? 'note' : 'notes'} shown${more}\n`);
  return 0;
}
