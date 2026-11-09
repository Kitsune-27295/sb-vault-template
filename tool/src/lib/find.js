/**
 * Read-only search of an Instance. Scans the Markdown notes of the searchable
 * Zones on every call: no index and no cache is built (ADR 0002). Terms are
 * case- and accent-insensitive and all of them must occur in a note. Notes
 * rank by where the terms occur: title and description first, then headings,
 * then body text; ties go to the more recently updated note, then to the path.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { COUNTS_END, COUNTS_START } from './derived.js';
import { byCodeUnit, listFiles } from './files.js';
import { readFrontmatter } from './frontmatter.js';
import { fenceTracker, splitFrontmatter } from './markdown.js';
import { GENERATED_MARKER, HOT_PATH, ZONES, isZoneIndex } from './zones.js';

/** Zones searched by default; Raw sources are added on request. */
export const DEFAULT_ZONES = Object.freeze([ZONES.human, ZONES.proposals, ZONES.compiled, ZONES.ops]);

/** Folders of the Operations zone that never hold notes to find: quarantined material and the drop folder. */
const EXCLUDED_PREFIXES = ['50-ops/quarantine/', '50-ops/inbox/_drop/'];

const SNIPPET_WIDTH = 160;

/** Where a term was found, best first. */
const TIER_NAMES = ['title', 'heading', 'body'];

/**
 * Resolve a zone name given with `--zone`.
 * @param {string} value a short name (`human`) or a folder name (`20-human`)
 * @returns {string} the Zone folder
 * @throws {UsageError} for a name that is not a searchable Zone
 */
export function resolveZone(value) {
  const key = value.trim().toLowerCase();
  const searchable = Object.entries(ZONES).filter(([, folder]) => folder === ZONES.sources || DEFAULT_ZONES.includes(folder));
  const match = searchable.find(([name, folder]) => key === name || key === folder);
  if (match === undefined) {
    throw new UsageError(`unknown zone "${value}"; use one of: ${searchable.map(([name]) => name).join(', ')}`);
  }
  return match[1];
}

/**
 * Lower-case a text and drop its accents, so that "Cafe", "CAFE" and the same word with an accent are equal.
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Fold a text and remember, for every folded character, where it came from.
 * @param {string} text
 * @returns {{ text: string, origin: number[] }} `origin[i]` is the index in `text` of folded character `i`
 */
function foldWithOrigin(text) {
  let folded = '';
  /** @type {number[]} */
  const origin = [];
  let index = 0;
  for (const char of text) {
    const part = fold(char);
    for (let i = 0; i < part.length; i += 1) origin.push(index);
    folded += part;
    index += char.length;
  }
  return { text: folded, origin };
}

/**
 * @typedef {object} Candidate a piece of a note that terms can occur in
 * @property {number} tier index in `TIER_NAMES`
 * @property {number} line 0-based line in the file
 * @property {string} text the text shown in a snippet, whitespace collapsed
 */

/**
 * @param {string} path vault-relative path
 * @param {string} text file content
 * @returns {{ title: string, updated: string, candidates: Candidate[] }}
 */
function readNote(path, text) {
  const { lines, present, end, bodyStart } = splitFrontmatter(text);
  const front = readFrontmatter(text);
  const data = 'data' in front ? front.data : {};
  const collapse = (/** @type {string} */ value) => value.replace(/\s+/g, ' ').trim();
  const keyLine = (/** @type {string} */ key) => {
    if (!present || end === -1) return 0;
    const found = lines.findIndex((line, i) => i > 0 && i < end && new RegExp(`^${key}\\s*:`).test(line));
    return found === -1 ? 0 : found;
  };

  /** @type {Candidate[]} */
  const candidates = [];
  const metaTitle = typeof data.title === 'string' ? collapse(data.title) : '';
  if (metaTitle !== '') candidates.push({ tier: 0, line: keyLine('title'), text: metaTitle });
  if (typeof data.description === 'string' && collapse(data.description) !== '') {
    candidates.push({ tier: 0, line: keyLine('description'), text: collapse(data.description) });
  }

  let title = metaTitle;
  const stateOf = fenceTracker();
  let inCounts = false;
  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i];
    const state = stateOf(line);
    if (path === HOT_PATH) {
      // The generated counts block repeats numbers on every note; it is not content.
      if (line.includes(COUNTS_START)) inCounts = true;
      if (inCounts) {
        if (line.includes(COUNTS_END)) inCounts = false;
        continue;
      }
    }
    if (state === 'fence-open' || state === 'fence-close' || line.trim() === '') continue;
    const heading = state === 'text' ? /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line) : null;
    if (heading !== null) {
      const headingText = collapse(heading[2]);
      // Without a `title` property, the first level-one heading is the title.
      const isTitle = title === '' && heading[1] === '#';
      if (isTitle) title = headingText;
      candidates.push({ tier: isTitle ? 0 : 1, line: i, text: headingText });
    } else {
      candidates.push({ tier: 2, line: i, text: collapse(line) });
    }
  }
  if (title === '') title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const updated = data.updated instanceof Date ? data.updated.toISOString().slice(0, 10) : typeof data.updated === 'string' ? data.updated : '';
  return { title, updated, candidates };
}

/**
 * A short window of `text` around a character offset.
 * @param {string} text
 * @param {number} at offset of the match
 * @returns {string}
 */
function snippetAround(text, at) {
  if (text.length <= SNIPPET_WIDTH) return text;
  const start = Math.max(0, Math.min(at - 40, text.length - SNIPPET_WIDTH));
  const end = Math.min(text.length, start + SNIPPET_WIDTH);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}

/**
 * @typedef {object} Hit
 * @property {string} path vault-relative path with forward slashes
 * @property {number} line 1-based line of the best match
 * @property {string} snippet the matching text, shortened
 * @property {string} title the note's title
 * @property {string} zone the Zone folder the note is in
 * @property {'title' | 'heading' | 'body'} matched where the best match is: the title or description, a heading, or body text
 */

/**
 * Match a note against folded terms.
 * @param {string} path
 * @param {string} text file content
 * @param {string[]} terms folded, non-empty, unique
 * @returns {{ hit: Hit, tiers: number[], updated: string } | null} null when a term is missing
 */
function matchNote(path, text, terms) {
  const note = readNote(path, text);
  const folded = note.candidates.map((candidate) => ({ candidate, ...foldWithOrigin(candidate.text) }));
  /** The terms each candidate holds. */
  const found = folded.map(({ text: haystack }) => terms.filter((term) => haystack.includes(term)));
  /** For every term, the best tier it occurs in. */
  const tiers = [0, 0, 0];
  let best = TIER_NAMES.length;
  for (const term of terms) {
    let termBest = TIER_NAMES.length;
    found.forEach((held, i) => {
      if (held.includes(term)) termBest = Math.min(termBest, folded[i].candidate.tier);
    });
    if (termBest === TIER_NAMES.length) return null;
    tiers[termBest] += 1;
    best = Math.min(best, termBest);
  }
  // The shown line: in the best tier, the first candidate that holds the most terms.
  let pick = -1;
  found.forEach((held, i) => {
    if (folded[i].candidate.tier !== best) return;
    if (pick === -1 || held.length > found[pick].length) pick = i;
  });
  const { candidate, text: haystack, origin } = folded[pick];
  const firstAt = Math.min(...found[pick].map((term) => haystack.indexOf(term)));
  const hit = {
    path,
    line: candidate.line + 1,
    snippet: snippetAround(candidate.text, origin[firstAt] ?? 0),
    title: note.title,
    zone: path.slice(0, path.indexOf('/')),
    matched: /** @type {'title' | 'heading' | 'body'} */ (TIER_NAMES[best]),
  };
  return { hit, tiers, updated: note.updated };
}

/**
 * Search an Instance. Nothing is written.
 * @param {object} input
 * @param {string} input.vault absolute path of the Instance
 * @param {string[]} input.terms words that must all occur in a note
 * @param {readonly string[]} input.zones Zone folders to search
 * @param {number} input.limit most hits to return
 * @returns {Promise<{ hits: Hit[], total: number }>} the best `limit` hits and how many notes matched
 */
export async function findNotes({ vault, terms, zones, limit }) {
  const wanted = [...new Set(terms.map(fold).filter((term) => term !== ''))];
  /** @type {{ hit: Hit, tiers: number[], updated: string }[]} */
  const matches = [];
  for (const zone of zones) {
    const files = await listFiles(join(vault, zone));
    for (const file of files) {
      const path = `${zone}/${file}`;
      if (!/\.md$/i.test(file) || isZoneIndex(path) || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      const text = await readFile(join(vault, zone, ...file.split('/')), 'utf8');
      if (text.startsWith(GENERATED_MARKER)) continue;
      const match = matchNote(path, text, wanted);
      if (match !== null) matches.push(match);
    }
  }
  matches.sort((a, b) => {
    for (let i = 0; i < a.tiers.length; i += 1) if (a.tiers[i] !== b.tiers[i]) return b.tiers[i] - a.tiers[i];
    if (a.updated !== b.updated) return byCodeUnit(b.updated, a.updated);
    return byCodeUnit(a.hit.path, b.hit.path);
  });
  return { hits: matches.slice(0, limit).map((m) => m.hit), total: matches.length };
}
