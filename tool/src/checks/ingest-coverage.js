import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { isImported, readFrontmatter } from '../lib/frontmatter.js';
import { fromVaultPath, listVaultFiles, toVaultPath } from '../lib/paths.js';
import { finding, importedSummary } from '../lib/report.js';
import { loadRawSources } from '../lib/sources.js';
import { isHeldBack, ZONE_INDEX_NAME, ZONES } from '../lib/zones.js';

export const id = 'ingest-coverage';

/** Zones that hold agent-written notes; the inbox pointer notes in `50-ops/inbox/` are not summaries. */
const NOTE_ZONES = [ZONES.proposals, ZONES.compiled, ZONES.ops];
const SKIPPED_PREFIXES = [`${ZONES.ops}/inbox/`, `${ZONES.ops}/log/`];

/** A raw source is text when its first 8 KB holds no NUL byte. */
const BINARY_PROBE = 8192;

/**
 * @param {unknown} value a `sources` item or `raw_source` value
 * @returns {string | null} the cited target without wikilink syntax, alias, anchor or the zone prefix
 */
function citedTarget(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const wikilink = /^\[\[(.*)\]\]$/.exec(text);
  if (wikilink) text = wikilink[1];
  text = text.split('|')[0].split('#')[0].replaceAll('\\', '/').trim().replace(/^\/+/, '');
  if (text.toLowerCase().startsWith(`${ZONES.sources}/`)) text = text.slice(ZONES.sources.length + 1);
  return text === '' ? null : text.toLowerCase();
}

/**
 * @param {string} text raw source content, LF or CRLF
 * @returns {number} number of lines; a final line break does not start another line
 */
function countLines(text) {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

/**
 * @param {number} from first line, inclusive
 * @param {number} to last line, inclusive
 * @returns {string}
 */
const span = (from, to) => (from === to ? `${from}` : `${from}-${to}`);

/**
 * A `source` note that cites one raw source declares, in `covers`, the inclusive line ranges
 * of that raw source its summary covers (`["1-120", "121-300"]`). The check errors when the
 * ranges leave a line of the raw source uncovered, so a summary of a long transcript cannot
 * quietly describe only its beginning, and warns when `covers` is absent. Notes that cite no
 * raw source, binary raw sources and the inbox pointer notes `capture` writes are not checked.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  const report = (/** @type {string} */ path, /** @type {'error' | 'warning'} */ severity, /** @type {string} */ rule, /** @type {string} */ message) =>
    findings.push(finding(path, rule, severity, message));

  const candidates = [];
  for (const file of await listVaultFiles(vault)) {
    if (!file.toLowerCase().endsWith('.md') || !NOTE_ZONES.some((zone) => file.startsWith(`${zone}/`))) continue;
    if (isHeldBack(file) || SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix)) || file.endsWith(`/${ZONE_INDEX_NAME}`)) continue;
    const frontmatter = readFrontmatter(await readFile(fromVaultPath(vault, file), 'utf8'));
    if (!frontmatter.present || 'error' in frontmatter || frontmatter.data.type !== 'source') continue;
    candidates.push({ file, data: frontmatter.data });
  }
  if (candidates.length === 0) return findings;

  // Every name a note may use for a raw source: path below 10-sources/, file name, each with and without extension.
  const raw = (await loadRawSources(vault)).filter((s) => !s.path.endsWith(`${sep}${ZONE_INDEX_NAME}`));
  /** @type {Map<string, Set<(typeof raw)[number]>>} */
  const byName = new Map();
  for (const entry of raw) {
    const below = toVaultPath(`${vault}${sep}${ZONES.sources}`, entry.path).toLowerCase();
    const base = below.slice(below.lastIndexOf('/') + 1);
    for (const key of [below, base, below.replace(/\.[^./]*$/, ''), base.replace(/\.[^./]*$/, '')]) {
      if (!byName.has(key)) byName.set(key, new Set());
      /** @type {Set<(typeof raw)[number]>} */ (byName.get(key)).add(entry);
    }
  }

  /** @type {string[]} imported notes with no usable coverage declaration */
  const undeclared = [];
  for (const { file, data } of candidates) {
    const cited = new Set();
    const values = [...(Array.isArray(data.sources) ? data.sources : [data.sources]), data.raw_source];
    for (const value of values) {
      const target = citedTarget(value);
      if (target === null) continue;
      for (const entry of byName.get(target) ?? []) cited.add(entry);
    }
    if (cited.size === 0) continue;
    if (cited.size > 1) {
      if (isImported(data)) {
        undeclared.push(file); // the old framework never declared coverage; summarized below
        continue;
      }
      report(file, 'error', 'coverage-ambiguous', `cites ${cited.size} raw sources; a source note summarizes exactly one, so split it`);
      continue;
    }
    const [entry] = cited;
    const bytes = await readFile(entry.path);
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) continue;
    const total = countLines(bytes.toString('utf8'));
    if (total === 0) continue;
    const rawName = toVaultPath(vault, entry.path);

    if (data.covers === undefined || data.covers === null || data.covers === '') {
      if (isImported(data)) {
        undeclared.push(file);
        continue;
      }
      report(file, 'warning', 'coverage-missing', `has no covers; add covers: ["1-${total}"] once the summary covers all ${total} lines of ${rawName}`);
      continue;
    }
    if (!Array.isArray(data.covers)) continue; // the frontmatter-schema check reports the wrong shape

    /** @type {Array<[number, number]>} */
    const ranges = [];
    let valid = true;
    for (const item of data.covers) {
      const match = typeof item === 'string' ? /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(item) : null;
      const from = match ? Number(match[1]) : 0;
      const to = match ? Number(match[2]) : 0;
      if (!match || from < 1 || to < from) {
        report(file, 'error', 'covers-invalid', `covers item ${JSON.stringify(item)} is not a line range such as "1-120" (first line 1 or more, last line not before the first)`);
        valid = false;
      } else if (to > total) {
        report(file, 'error', 'covers-out-of-range', `covers item "${from}-${to}" ends after the last line; ${rawName} has ${total} lines`);
        valid = false;
      } else {
        ranges.push([from, to]);
      }
    }
    if (!valid) continue;

    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    /** @type {string[]} */
    const gaps = [];
    let next = 1; // first line not yet covered
    for (const [from, to] of ranges) {
      if (from > next) gaps.push(span(next, from - 1));
      next = Math.max(next, to + 1);
    }
    if (next <= total) gaps.push(span(next, total));
    if (gaps.length > 0) {
      report(file, 'error', 'source-not-covered', `covers leave lines ${gaps.join(', ')} of ${rawName} uncovered (${total} lines); extend the summary and covers, or split the source`);
    }
  }
  if (undeclared.length > 0) {
    findings.push(importedSummary(undeclared, 'coverage-undeclared-imported', 'info', 'cite raw sources without declaring coverage (the old framework never did)'));
  }
  return findings;
}
