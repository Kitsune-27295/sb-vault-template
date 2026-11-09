/**
 * Carry an old log over into the Instance log (ADR 0011): every entry line stays as it was and the
 * hash chain of `src/lib/log.js` is added after each entry. The chain runs across the monthly files,
 * so the caller passes the last chain value of the file before.
 */
import { chainHash, parseHeader } from '../log.js';
import { normalizeNewlines, stripBom } from '../markdown.js';

/** Matches a line the Instance log would read as a chain line, valid or not. */
const CHAIN_LIKE = /^<!--\s*chain:/;

/**
 * @param {string} text one monthly log file of the old framework
 * @returns {{ entries: string[][] } | null} the entries (header line first, then the body lines without
 *   trailing blank lines), or null when the text is not a plain list of entries: text before the first
 *   entry other than one `# ...` title line, an entry-like line that is not a valid header, or a
 *   chain-like line in a body. A title line is allowed and not carried: the original file keeps it.
 */
export function parseOldLog(text) {
  const lines = normalizeNewlines(stripBom(text)).split('\n');
  /** @type {string[][]} */
  const entries = [];
  let titled = false;
  for (const line of lines) {
    if (parseHeader(line) !== null) {
      entries.push([line]);
    } else if (line.startsWith('## [') || CHAIN_LIKE.test(line)) {
      return null;
    } else if (entries.length > 0) {
      /** @type {string[]} */ (entries.at(-1)).push(line);
    } else if (line.trim() !== '') {
      if (titled || !/^# +\S/.test(line)) return null;
      titled = true;
    }
  }
  for (const entry of entries) while (entry.length > 1 && entry[entry.length - 1].trim() === '') entry.pop();
  return { entries };
}

/**
 * @param {string} text one monthly log file of the old framework
 * @param {string} previous chain value of the entry before the first one here
 * @returns {{ text: string, chain: string }} the chained file (LF) and the chain value of its last entry
 * @throws {Error} when the text is not a plain list of entries
 */
export function chainOldLog(text, previous) {
  const parsed = parseOldLog(text);
  if (parsed === null) throw new Error('the log file is not a plain list of entries');
  let chain = previous;
  const blocks = parsed.entries.map((lines) => {
    chain = chainHash(chain, lines.join('\n'));
    return `${lines.join('\n')}\n<!-- chain: ${chain} -->\n`;
  });
  return { text: blocks.join('\n'), chain };
}
