/**
 * An old log that opens with more than a title (a frontmatter block, an intro paragraph), carried
 * into the Instance log (ADR 0011). `log-chain.js` carries a plain list of entries; this module
 * first turns the text before the first entry into the body of one leading entry, so nothing the
 * old file said is dropped, then hands the result to the same chaining.
 */
import { parseHeader } from '../log.js';
import { normalizeNewlines, stripBom } from '../markdown.js';
import { chainOldLog, parseOldLog } from './log-chain.js';

/**
 * @param {string} text the old log
 * @param {string} label adapter id, named in the leading entry
 * @returns {{ text: string, month: string }} the text to chain and the month of its first entry
 * @throws {Error} with `code` `no-entries` when no line is an entry header, or `unconvertible` when the
 *   result is not a plain list of entries (an entry-like line that is not a valid header, a chain line)
 */
export function withPreamble(text, label) {
  const lines = normalizeNewlines(stripBom(text)).split('\n');
  const first = lines.findIndex((line) => parseHeader(line) !== null);
  if (first === -1) throw Object.assign(new Error('the log has no entry of the form "## [YYYY-MM-DD] <action> | <title>"'), { code: 'no-entries' });
  const preamble = lines.slice(0, first);
  while (preamble.length > 0 && preamble[0].trim() === '') preamble.shift();
  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === '') preamble.pop();

  const date = /** @type {{ date: string }} */ (parseHeader(lines[first])).date;
  const lead = preamble.length === 0 ? [] : [`## [${date}] import | ${label} log preamble`, ...preamble, ''];
  const joined = [...lead, ...lines.slice(first)].join('\n');
  if (parseOldLog(joined) === null) throw Object.assign(new Error('the log is not a plain list of entries'), { code: 'unconvertible' });
  return { text: joined, month: date.slice(0, 7) };
}

/**
 * @param {string} text the old log
 * @param {object} input
 * @param {string} input.label adapter id
 * @param {string} input.previous chain value of the entry before the first one here
 * @returns {{ text: string, chain: string }} the chained file (LF) and the chain value of its last entry
 * @throws {Error} as `withPreamble`
 */
export function chainLogWithPreamble(text, { label, previous }) {
  return chainOldLog(withPreamble(text, label).text, previous);
}
