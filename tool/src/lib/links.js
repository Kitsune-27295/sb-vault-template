import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fenceTracker, splitFrontmatter } from './markdown.js';
import { fromVaultPath, listVaultFiles } from './paths.js';
import { IMPORTED_AREA, isHeldBack, ZONES } from './zones.js';

/**
 * Zones whose notes are read for links. Raw sources are immutable captures that
 * may hold any link the captured page had, and the System zone holds templates
 * with placeholder links, so neither is a source of links.
 */
const LINK_SOURCE_ZONES = [ZONES.human, ZONES.proposals, ZONES.compiled, ZONES.ops];

/**
 * The append-only log is a record, not knowledge: an entry can never be
 * corrected, so a link in it must never be able to fail a check for good. Its
 * notes are not read for links (a log file can still be the target of one).
 */
const LOG_PREFIX = `${ZONES.ops}/log/`;

/**
 * Material `import` kept verbatim (`20-human/_imported/`) is also not read for links: it is a copy
 * of someone else's notes, and a link that was dead in the source stays dead. The migration
 * manifest lists those links (`unresolved_links`); a note the curator moves out of the folder is
 * checked like any other.
 */

/**
 * @typedef {object} Link
 * @property {'wikilink' | 'markdown'} kind
 * @property {string} target as written, without alias, anchor or title
 * @property {number} line 1-based line in the note
 * @property {boolean} frontmatter whether the link is in the frontmatter block
 * @property {string} [field] for a frontmatter link, the property it is in (`sources`)
 *
 * @typedef {object} LinkGraph
 * @property {string[]} files every file of the Instance, vault-relative with forward slashes
 * @property {{ path: string, links: Link[] }[]} notes Markdown notes in the link source zones
 * @property {(link: Link, from: string) => string[]} resolve vault-relative files a link points to
 * @property {(link: Link, from: string) => boolean} isBroken true when the link points at no file or folder
 */

/**
 * Blank out fenced code blocks and inline code spans, keeping every newline so
 * line numbers stay valid.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function blankCode(lines) {
  const stateOf = fenceTracker();
  const out = lines.map((line) => (stateOf(line) === 'text' ? line : ''));
  // Inline code spans: a backtick run closes at the next run of the same length.
  const joined = out.join('\n');
  let result = '';
  let i = 0;
  while (i < joined.length) {
    if (joined[i] !== '`') {
      result += joined[i++];
      continue;
    }
    let end = i;
    while (joined[end] === '`') end++;
    const run = joined.slice(i, end);
    let close = -1;
    for (let j = end; j < joined.length; j++) {
      if (joined[j] !== '`') continue;
      let k = j;
      while (joined[k] === '`') k++;
      if (k - j === run.length) {
        close = j;
        break;
      }
      j = k - 1;
    }
    if (close === -1) {
      result += run;
      i = end;
      continue;
    }
    result += joined.slice(i, close + run.length).replace(/[^\n]/g, ' ');
    i = close + run.length;
  }
  return result.split('\n');
}

/**
 * @typedef {object} LinkSpan a link found in one line, with where its target is written
 * @property {'wikilink' | 'markdown'} kind
 * @property {string} target as `Link.target`
 * @property {number} from index in the line where the target text starts (before any decoding)
 * @property {number} to index just after the target text
 */

/**
 * The links of one line, wikilinks first, then (when `markdown`) Markdown links. The one place that
 * knows the link syntax: `extractLinks` reads it, and `import` rewrites the target text it points at.
 * @param {string} line a line without its terminator, code already blanked
 * @param {boolean} markdown whether to read Markdown links too (not in the frontmatter block)
 * @returns {LinkSpan[]}
 */
export function scanLine(line, markdown) {
  /** @type {LinkSpan[]} */
  const spans = [];
  for (const match of line.matchAll(/\[\[([^[\]]*)\]\]/g)) {
    // `\|` is how a table cell escapes the alias separator.
    const written = match[1].split('|')[0].replace(/\\$/, '').split(/[#^]/)[0];
    const target = written.trim();
    if (target === '') continue;
    const from = match.index + 2 + (written.length - written.trimStart().length);
    spans.push({ kind: 'wikilink', target, from, to: from + target.length });
  }
  if (!markdown) return spans;
  for (const match of line.matchAll(/\]\(\s*(?:<([^>]*)>|((?:[^()\s]|\([^()\s]*\))*))/g)) {
    const written = match[1] ?? match[2] ?? '';
    const destination = written.trim();
    if (destination === '' || destination.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) continue;
    const path = destination.split(/[#?]/)[0];
    let target = path;
    try {
      target = decodeURI(path);
    } catch {
      // keep the raw text when it is not valid percent-encoding
    }
    if (target === '') continue;
    const from = match.index + match[0].length - written.length + (written.length - written.trimStart().length);
    spans.push({ kind: 'markdown', target, from, to: from + path.length });
  }
  return spans;
}

/**
 * Links of one note, ignoring code spans and fenced code. Wikilinks in the
 * frontmatter block are reported with `frontmatter: true`; Markdown links are
 * read from the body only.
 * @param {string} text note content, LF or CRLF
 * @returns {Link[]}
 */
export function extractLinks(text) {
  const { lines, bodyStart } = splitFrontmatter(text);
  /** @type {Link[]} */
  const links = [];

  const scan = (/** @type {string[]} */ part, /** @type {number} */ offset, /** @type {boolean} */ frontmatter) => {
    /** @type {string | undefined} */
    let field;
    part.forEach((line, index) => {
      // The frontmatter key a link belongs to: the last top-level key above it.
      if (frontmatter) field = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1] ?? field;
      for (const span of scanLine(line, !frontmatter)) {
        links.push({
          kind: span.kind,
          target: span.target,
          line: offset + index + 1,
          frontmatter,
          ...(span.kind === 'wikilink' && frontmatter && field !== undefined ? { field } : {}),
        });
      }
    });
  };

  scan(lines.slice(0, bodyStart), 0, true);
  scan(blankCode(lines.slice(bodyStart)), bodyStart, false);
  return links;
}

/**
 * Index of every file by every name a wikilink may use: the file name with and
 * without `.md`, and every trailing path with and without `.md`. Lookups are
 * case-insensitive, as in Obsidian and on Windows.
 * @param {string[]} files
 * @returns {Map<string, string[]>}
 */
function indexFiles(files) {
  /** @type {Map<string, string[]>} */
  const index = new Map();
  const add = (/** @type {string} */ key, /** @type {string} */ file) => {
    const found = index.get(key);
    if (found) found.push(file);
    else index.set(key, [file]);
  };
  for (const file of files) {
    const parts = file.toLowerCase().split('/');
    for (let start = 0; start < parts.length; start++) {
      const tail = parts.slice(start).join('/');
      add(tail, file);
      if (tail.endsWith('.md')) add(tail.slice(0, -3), file);
    }
  }
  return index;
}

/** @type {Map<string, Promise<LinkGraph>>} */
const graphs = new Map();

/**
 * Read the link graph of a vault. The result is kept for the rest of the process
 * so the link checks, which run one after the other, walk the vault once.
 * @param {string} vault absolute vault path
 * @returns {Promise<LinkGraph>}
 */
export function loadLinkGraph(vault) {
  let graph = graphs.get(vault);
  if (graph === undefined) {
    graph = build(vault);
    graphs.set(vault, graph);
  }
  return graph;
}

/**
 * How the links of a set of files resolve: a wikilink by file name or trailing path, a Markdown link
 * by its path relative to the note. Used for an Instance and, by `import`, for a source vault.
 * @param {string[]} files every file, relative with forward slashes
 * @returns {Pick<LinkGraph, 'resolve' | 'isBroken'> & { locate: (link: Link, from: string) => { files: string[], folder: boolean } }}
 */
export function makeResolver(files) {
  const index = indexFiles(files);
  const folders = new Set();
  for (const file of files.map((f) => f.toLowerCase())) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) folders.add(file.slice(0, slash));
  }
  const byLowerName = new Map(files.map((f) => [f.toLowerCase(), f]));

  /**
   * @param {Link} link
   * @param {string} from
   * @returns {{ files: string[], folder: boolean }}
   */
  const locate = (link, from) => {
    if (link.kind === 'wikilink') {
      return { files: index.get(link.target.replace(/^\/+/, '').toLowerCase()) ?? [], folder: false };
    }
    const joined = link.target.startsWith('/')
      ? link.target.slice(1)
      : posix.join(posix.dirname(from), link.target.replaceAll('\\', '/'));
    const path = posix.normalize(joined).toLowerCase();
    if (path.startsWith('..') || path === '.') return { files: [], folder: false };
    for (const candidate of [path, `${path}.md`]) {
      const file = byLowerName.get(candidate);
      if (file !== undefined) return { files: [file], folder: false };
    }
    return { files: [], folder: folders.has(path) };
  };

  /** @type {LinkGraph['resolve']} */
  const resolve = (link, from) => locate(link, from).files;
  /** @type {LinkGraph['isBroken']} */
  const isBroken = (link, from) => {
    const { files: found, folder } = locate(link, from);
    return found.length === 0 && !folder;
  };

  return { locate, resolve, isBroken };
}

/** @param {string} vault @returns {Promise<LinkGraph>} */
async function build(vault) {
  const files = await listVaultFiles(vault);

  /** @type {LinkGraph['notes']} */
  const notes = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    if (!LINK_SOURCE_ZONES.some((zone) => file.startsWith(`${zone}/`)) || file.startsWith(LOG_PREFIX)) continue;
    if (file.startsWith(`${IMPORTED_AREA}/`) || isHeldBack(file)) continue;
    notes.push({ path: file, links: extractLinks(await readFile(fromVaultPath(vault, file), 'utf8')) });
  }

  const { resolve, isBroken } = makeResolver(files);
  return { files, notes, resolve, isBroken };
}
