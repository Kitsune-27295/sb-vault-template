import { UsageError } from '../lib/errors.js';
import { describeAdapters, loadAdapters } from '../lib/migrate/detect.js';
import { runImport, importReport } from '../lib/migrate/engine.js';
import { buildReport, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';

export const name = 'import';
export const summary = 'Import a vault from another framework into a new Instance (dry run unless --apply)';
export const usage = '<source> <target> [--from <adapter|auto>] [--apply] [--verify] | --list-adapters';
export const options = { from: { type: 'string' }, apply: { type: 'boolean' }, verify: { type: 'boolean' }, 'list-adapters': { type: 'boolean' } };

/**
 * `--list-adapters`: every adapter and detect-only entry, with what it detects and its status.
 * @param {import('../cli.js').CommandContext} ctx
 * @returns {Promise<number>} the exit code
 */
async function listAdapters(ctx) {
  if (ctx.args.length > 0) throw new UsageError('--list-adapters takes no arguments');
  const adapters = describeAdapters(await loadAdapters());
  if (ctx.json) {
    ctx.print(JSON.stringify({ ...buildReport({ frameworkVersion: ctx.version, vault: '.', checks: [] }), adapters }, null, 2) + '\n');
  } else {
    const width = Math.max(...adapters.map((a) => a.id.length));
    const rows = adapters.map((a) => `${a.id.padEnd(width)}  ${a.status === 'adapter' ? 'adapter     ' : 'detect-only '} ${a.detects}`);
    ctx.print(`${rows.join('\n')}\n\nA detect-only entry is recognized by --from auto but has no adapter yet: use --from generic.\n`);
  }
  return 0;
}

/** How many unresolved links and to-do items the human summary lists before it points at the JSON report. */
const LISTED = 20;

/**
 * @param {ReturnType<typeof importReport>} report
 * @returns {string} the human summary of the plan and its outcome
 */
function describe(report) {
  const { import: imp } = /** @type {any} */ (report);
  if (imp.detect_only) {
    return `Detected ${imp.adapter} (confidence ${imp.detection.confidence}): ${imp.detection.evidence.join('; ')}\nThis framework has no adapter yet: use --from generic. Nothing was written\n\n`;
  }
  const c = imp.counts;
  const lines = [
    `Adapter: ${imp.adapter} (confidence ${imp.detection.confidence}): ${imp.detection.evidence.join('; ')}`,
    `Entries: ${c.total}: ${c.mapped} mapped, ${c.preserved} preserved verbatim, ${c.excluded} excluded, ${c.quarantined} quarantined`,
  ];
  const reasons = Object.entries(imp.excluded_reasons).map(([reason, n]) => `${reason} ${n}`);
  if (reasons.length > 0) lines.push(`Excluded: ${reasons.join(', ')}`);
  for (const q of imp.entries.filter((/** @type {any} */ e) => e.outcome === 'quarantined' && e.secrets !== undefined)) {
    const where = (/** @type {any} */ s) => (s.field === undefined ? `${s.pattern} at line ${s.line}` : `${s.pattern} in the file ${s.field}`);
    lines.push(`Quarantined: ${q.source} -> ${q.destination} (${q.secrets.map(where).join(', ')}; the value is not shown)`);
  }
  const links = imp.entries.filter((/** @type {any} */ e) => e.reason === 'link-not-followed');
  if (links.length > 0) {
    lines.push(`Links not followed: ${links.length} (a link is never followed or copied)`);
    for (const l of links.slice(0, LISTED)) lines.push(`  ${l.source}`);
    if (links.length > LISTED) lines.push(`  ... and ${links.length - LISTED} more in the JSON report`);
  }
  for (const c1 of imp.collisions) lines.push(`Renamed: ${c1.source} -> ${c1.destination} (${c1.wanted} was taken)`);
  const unresolved = imp.unresolved_links;
  if (unresolved.length > 0) {
    lines.push(`Unresolved links: ${unresolved.length} (kept as written)`);
    for (const l of unresolved.slice(0, LISTED)) lines.push(`  ${l.from}:${l.line} ${l.kind === 'wikilink' ? `[[${l.target}]]` : l.target} (${l.reason})`);
    if (unresolved.length > LISTED) lines.push(`  ... and ${unresolved.length - LISTED} more in the JSON report`);
  }
  if (imp.todo.length > 0) {
    lines.push(`To do: ${imp.todo.length} finding(s) the import could not fix`);
    for (const t of imp.todo.slice(0, LISTED)) lines.push(`  ${t.severity}: ${t.path} [${t.rule}] ${t.message}`);
  }
  const closing = {
    apply: imp.applied ? `Wrote the Instance and the manifest ${imp.manifest}` : 'The Instance failed verification and was not created: nothing was written',
    verify: 'Verified the Instance against the source and the manifest: nothing was written',
    'dry-run': 'Nothing was written (dry run: add --apply to import, or --verify to re-check a finished import)',
  };
  lines.push(closing[imp.mode]);
  return `${lines.join('\n')}\n\n`;
}

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.values['list-adapters']) return listAdapters(ctx);
  if (ctx.args.length !== 2) throw new UsageError('import needs exactly two arguments: <source> <target>');
  if (ctx.values.apply && ctx.values.verify) throw new UsageError('--apply and --verify cannot be combined: verify re-checks an import that is already written');
  const result = await runImport({
    source: ctx.args[0],
    target: ctx.args[1],
    from: ctx.values.from ?? 'auto',
    apply: ctx.values.apply === true,
    verify: ctx.values.verify === true,
    version: ctx.version,
    today: ctx.today,
  });
  const report = importReport(result, ctx.version);
  ctx.print(ctx.json ? formatJson(report) : `${describe(report)}${formatHuman(report)}`);
  return exitCodeFor(report);
}
