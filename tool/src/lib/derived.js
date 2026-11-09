/**
 * Derived state: everything `sbk index` writes and `doctor` re-derives (ADR 0002,
 * planning 04 sections 2.3 and 3). Nothing here is a source of truth; each file
 * is a pure function of the notes on disk, so it is rebuilt, never hand-edited.
 *
 *   - `index.md`            root router: the Zones and the maps of content (notes of
 *                           type `moc`) only, so its size does not grow with page count;
 *   - `<zone>/_index.md`    one line per item of the Zone, for the Zones 10 to 50;
 *   - `50-ops/hot.md`       operational memory: the counts block between fixed marker
 *                           comments is computed, the text around it belongs to the curator.
 *
 * Output is deterministic (sorted, no timestamps) and built with LF line endings;
 * comparisons ignore the line ending of the file on disk, and a file that is CRLF on
 * disk is written back as CRLF.
 *
 * Generated files carry no frontmatter, so the `frontmatter-schema` check (which
 * skips a Markdown file without a frontmatter block) leaves them alone, and they
 * open with a generated-marker comment instead.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { byCodeUnit, listFiles } from './files.js';
import { readFrontmatter } from './frontmatter.js';
import { readLog } from './log.js';
import { fenceTracker, normalizeNewlines, splitFrontmatter } from './markdown.js';
import { SIDECAR_SUFFIX } from './sidecar.js';
import { GENERATED_MARKER, HOT_PATH, INDEXED_ZONES, ZONE_INDEX_NAME, ZONES } from './zones.js';

/** Vault-relative path of the root index. */
export const ROOT_INDEX_PATH = 'index.md';

/** Lines `hot.md` may have before `doctor` warns (the memory budget). */
export const HOT_LINE_BUDGET = 60;

/** Marker comments that fence the computed counts block in `hot.md`. */
export const COUNTS_START = '<!-- sbk:counts:start -->';
export const COUNTS_END = '<!-- sbk:counts:end -->';

/** Zones searched for maps of content. Raw sources and the System zone hold none. */
const MOC_ZONES = [ZONES.human, ZONES.proposals, ZONES.compiled, ZONES.ops];

const ZONE_SUMMARIES = Object.freeze({
  [ZONES.sources]: 'Raw sources: immutable captures, each with a sidecar',
  [ZONES.human]: 'Human notes: written by the curator only',
  [ZONES.proposals]: "Proposals: agent-written content awaiting the curator's decision",
  [ZONES.compiled]: 'Compiled knowledge: agent-maintained notes that cite their sources',
  [ZONES.ops]: 'Operations: operational memory, decisions, lessons, inbox and the append-only log',
  [ZONES.system]: 'System: schema, templates and framework files managed by upgrade (not indexed)',
});

const MAX_SUMMARY = 160;

/** A level-1 heading line; group 1 is its text without closing hashes. */
const HEADING = /^# +(\S.*?)(?:\s+#+)?\s*$/;

/** A derived file whose fence markers are damaged; nothing can be regenerated safely. */
export class DerivedError extends Error {
  /**
   * @param {string} path vault-relative path of the damaged file
   * @param {string} message
   */
  constructor(path, message) {
    super(message);
    this.name = 'DerivedError';
    this.path = path;
  }
}

/**
 * @typedef {object} Item
 * @property {string} path vault-relative path with forward slashes
 * @property {string} title
 * @property {string} summary one line, may be empty
 * @property {string | null} type frontmatter `type`, when present
 */

/**
 * Regular files below a Zone: no dot-files, no `_drop/` folders (raw drops that
 * are not notes yet), no generated `_index.md` of the Zone itself.
 * @param {string} vault
 * @param {string} zone
 * @returns {Promise<string[]>} sorted vault-relative paths
 */
async function walkZone(vault, zone) {
  const files = await listFiles(join(vault, zone), {
    skip: (name, isDirectory) => name.startsWith('.') || (isDirectory && name === '_drop'),
  });
  return files.map((file) => `${zone}/${file}`).filter((path) => path !== `${zone}/${ZONE_INDEX_NAME}`);
}

/** @param {string} text @returns {string} one line, no wikilink syntax */
function oneLine(text) {
  return text.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} text @returns {string} */
function truncate(text) {
  const chars = Array.from(text);
  return chars.length <= MAX_SUMMARY ? text : `${chars.slice(0, MAX_SUMMARY - 3).join('')}...`;
}

/**
 * First level-1 heading of a note body, ignoring fenced code.
 * @param {string} text file content
 * @returns {string | null}
 */
function firstHeading(text) {
  const { lines, bodyStart } = splitFrontmatter(text);
  const stateOf = fenceTracker();
  for (const [index, line] of lines.entries()) {
    const state = stateOf(line);
    if (index < bodyStart || state !== 'text') continue;
    const match = HEADING.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * @param {string} vault
 * @param {string} path vault-relative
 * @param {string} [content] text to describe instead of reading the file (used for
 *   notes that `index` is about to write)
 * @returns {Promise<Item>}
 */
async function describe(vault, path, content) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (!path.toLowerCase().endsWith('.md')) return { path, title: name, summary: '', type: null };
  const text = content ?? (await readFile(join(vault, ...path.split('/')), 'utf8'));
  const frontmatter = readFrontmatter(text);
  const data = 'data' in frontmatter ? frontmatter.data : {};
  const text1 = (/** @type {unknown} */ value) => (typeof value === 'string' ? oneLine(value) : '');
  const title = text1(data.title) || oneLine(firstHeading(text) ?? '') || name.replace(/\.md$/i, '');
  return {
    path,
    title,
    summary: truncate(text1(data.description)),
    type: typeof data.type === 'string' ? data.type : null,
  };
}

/**
 * The paths of the items of one Zone: Markdown notes, plus every non-sidecar
 * file in the raw sources Zone.
 * @param {string} vault
 * @param {string} zone
 * @returns {Promise<string[]>} sorted
 */
async function zonePaths(vault, zone) {
  return (await walkZone(vault, zone)).filter((p) =>
    zone === ZONES.sources ? !p.endsWith(SIDECAR_SUFFIX) : p.toLowerCase().endsWith('.md'),
  );
}

/** @param {Item} item @returns {string} one list line */
function itemLine(item) {
  const target = item.path.toLowerCase().endsWith('.md') ? item.path.slice(0, -3) : item.path;
  return `- [[${target}|${item.title}]]${item.summary === '' ? '' : ` - ${item.summary}`}`;
}

/** @param {string[]} lines @returns {string} */
const document = (lines) => `${[GENERATED_MARKER, ...lines].join('\n')}\n`;

/**
 * @param {string} zone
 * @param {Item[]} items
 * @returns {string}
 */
function renderZoneIndex(zone, items) {
  return document([
    `# Index of ${zone}`,
    '',
    `${ZONE_SUMMARIES[zone]}.`,
    '',
    ...(items.length === 0 ? ['No items yet.'] : items.map(itemLine)),
  ]);
}

/** @param {Item[]} mocs @returns {string} */
function renderRootIndex(mocs) {
  const zoneLines = Object.values(ZONES).map((zone) =>
    INDEXED_ZONES.includes(zone)
      ? `- [[${zone}/_index|${zone}]] - ${ZONE_SUMMARIES[zone]}`
      : `- ${zone} - ${ZONE_SUMMARIES[zone]}`,
  );
  return document([
    '# Index',
    '',
    'Router for this Instance: the Zones and the maps of content. Each Zone lists its own items in its `_index` note.',
    '',
    '## Zones',
    '',
    ...zoneLines,
    '',
    '## Maps of content',
    '',
    ...(mocs.length === 0 ? ['No maps of content yet.'] : mocs.map(itemLine)),
  ]);
}

/**
 * @param {{ inbox: number, proposals: number, lastLog: string | null }} counts
 * @returns {string[]} the lines between the markers
 */
function countsBlock({ inbox, proposals, lastLog }) {
  return [
    'Generated by `sbk index`. Do not edit between the markers.',
    '',
    `- Inbox: ${inbox} pointer ${inbox === 1 ? 'note' : 'notes'}`,
    `- Pending proposals: ${proposals}`,
    `- Last log entry: ${lastLog ?? 'none'}`,
  ];
}

/**
 * The `hot.md` a new Instance starts with; also what `index` writes when it is missing.
 * @param {string[]} block lines between the markers
 * @returns {string[]} lines of the note
 */
function defaultHotLines(block) {
  return [
    '# Hot',
    '',
    `Operational memory for the next session. Keep it short: \`sbk doctor\` warns above ${HOT_LINE_BUDGET} lines. Write your own notes outside the generated block.`,
    '',
    COUNTS_START,
    ...block,
    COUNTS_END,
    '',
    '## Notes for the next session',
    '',
    'Replace this placeholder with what the next session needs to know.',
  ];
}

/**
 * Put a counts block into the text of `hot.md`, leaving every line outside the
 * markers untouched. A note without markers gets the block appended.
 * @param {string} existing LF text of the current note
 * @param {string[]} block
 * @returns {string} LF text
 * @throws {DerivedError} when the markers are unbalanced, repeated or out of order
 */
function applyCounts(existing, block) {
  const lines = existing.split('\n');
  const starts = lines.flatMap((l, i) => (l.trim() === COUNTS_START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === COUNTS_END ? [i] : []));
  if (starts.length === 0 && ends.length === 0) {
    const body = existing.replace(/\n+$/, '');
    return `${body === '' ? '' : `${body}\n\n`}${COUNTS_START}\n${block.join('\n')}\n${COUNTS_END}\n`;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new DerivedError(
      HOT_PATH,
      `needs exactly one ${COUNTS_START} line followed by one ${COUNTS_END} line; fix the markers by hand`,
    );
  }
  return [...lines.slice(0, starts[0] + 1), ...block, ...lines.slice(ends[0])].join('\n');
}

/**
 * @param {string} vault
 * @returns {Promise<string | null>} newest entry date in the log, `YYYY-MM-DD`
 */
async function lastLogDate(vault) {
  const { files } = await readLog(vault);
  let last = null;
  for (const file of files) {
    for (const entry of file.entries) {
      const date = /^## \[(\d{4}-\d{2}-\d{2})\]/.exec(entry.header)?.[1];
      if (date !== undefined && (last === null || date > last)) last = date;
    }
  }
  return last;
}

/**
 * @param {string} vault
 * @param {string} path vault-relative
 * @returns {Promise<string | null>} file content, or null when it does not exist
 */
async function readIfExists(vault, path) {
  try {
    return await readFile(join(vault, ...path.split('/')), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Regenerate every derived file in memory.
 * @param {string} vault absolute vault path
 * @returns {Promise<Map<string, string>>} vault-relative path to LF content, in a fixed order
 * @throws {DerivedError} when the markers in `hot.md` are damaged
 */
export async function computeDerived(vault) {
  /** @type {Map<string, string[]>} */
  const paths = new Map();
  for (const zone of INDEXED_ZONES) paths.set(zone, await zonePaths(vault, zone));
  // `index` always leaves a hot.md behind, so it belongs to the Operations index even on the first run.
  const ops = /** @type {string[]} */ (paths.get(ZONES.ops));
  if (!ops.includes(HOT_PATH)) paths.set(ZONES.ops, [...ops, HOT_PATH].sort(byCodeUnit));

  const inboxPrefix = `${ZONES.ops}/inbox/`;
  const counts = {
    inbox: /** @type {string[]} */ (paths.get(ZONES.ops)).filter((p) => p.startsWith(inboxPrefix)).length,
    proposals: /** @type {string[]} */ (paths.get(ZONES.proposals)).length,
    lastLog: await lastLogDate(vault),
  };
  const block = countsBlock(counts);
  const existingHot = await readIfExists(vault, HOT_PATH);
  const hot =
    existingHot === null ? `${defaultHotLines(block).join('\n')}\n` : applyCounts(normalizeNewlines(existingHot), block);

  /** @type {Map<string, Item[]>} */
  const items = new Map();
  for (const zone of INDEXED_ZONES) {
    const zonePathList = /** @type {string[]} */ (paths.get(zone));
    items.set(zone, await Promise.all(zonePathList.map((p) => describe(vault, p, p === HOT_PATH ? hot : undefined))));
  }
  const mocs = MOC_ZONES.flatMap((zone) => items.get(zone) ?? [])
    .filter((item) => item.type === 'moc')
    .sort((a, b) => byCodeUnit(a.path, b.path));

  /** @type {Map<string, string>} */
  const derived = new Map();
  derived.set(ROOT_INDEX_PATH, renderRootIndex(mocs));
  for (const zone of INDEXED_ZONES) {
    derived.set(`${zone}/${ZONE_INDEX_NAME}`, renderZoneIndex(zone, items.get(zone) ?? []));
  }
  derived.set(HOT_PATH, hot);
  return derived;
}

/**
 * @typedef {object} Staleness
 * @property {string} path vault-relative path of the file that differs
 * @property {'derived-missing' | 'derived-stale'} rule
 * @property {string} message
 */

/**
 * Compare the regenerated state with the files on disk.
 * @param {string} vault
 * @returns {Promise<{ indexed: boolean, stale: Staleness[] }>} `indexed` is false when
 *   no derived file exists at all, a vault that `index` has never run on
 * @throws {DerivedError}
 */
export async function diffDerived(vault) {
  const expected = await computeDerived(vault);
  /** @type {Staleness[]} */
  const stale = [];
  let present = 0;
  for (const [path, content] of expected) {
    const onDisk = await readIfExists(vault, path);
    if (onDisk === null) {
      stale.push({ path, rule: 'derived-missing', message: 'is missing; run `sbk index <vault>`' });
      continue;
    }
    if (path !== HOT_PATH || onDisk.includes(COUNTS_START)) present += 1;
    if (normalizeNewlines(onDisk) !== content) {
      stale.push({
        path,
        rule: 'derived-stale',
        message:
          path === HOT_PATH
            ? 'the computed counts block is out of date or missing; run `sbk index <vault>`'
            : 'is out of date with the notes on disk; run `sbk index <vault>`',
      });
    }
  }
  return { indexed: present > 0, stale };
}

/**
 * Regenerate the derived files and write those that differ.
 * @param {string} vault
 * @returns {Promise<{ written: string[], unchanged: string[] }>} vault-relative paths
 * @throws {DerivedError} before anything is written
 */
export async function writeDerived(vault) {
  const expected = await computeDerived(vault);
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const unchanged = [];
  for (const [path, content] of expected) {
    const onDisk = await readIfExists(vault, path);
    if (onDisk !== null && normalizeNewlines(onDisk) === content) {
      unchanged.push(path);
      continue;
    }
    const full = join(vault, ...path.split('/'));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, onDisk?.includes('\r\n') ? content.replace(/\n/g, '\r\n') : content);
    written.push(path);
  }
  return { written, unchanged };
}

/**
 * True when the vault has derived state and it matches the notes. Used by
 * commands that change the inputs of derived state (the log) so that fresh
 * state stays fresh; state that was already stale is left for `doctor` to report.
 * @param {string} vault
 * @returns {Promise<boolean>}
 */
export async function isDerivedFresh(vault) {
  try {
    const { indexed, stale } = await diffDerived(vault);
    return indexed && stale.length === 0;
  } catch (error) {
    if (error instanceof DerivedError) return false;
    throw error;
  }
}
