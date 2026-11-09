/**
 * Plain-text helpers for Markdown notes, shared by every module that reads one:
 * line endings, the byte order mark, the frontmatter block and fenced code.
 */

/**
 * @param {string} text
 * @returns {string} the text without a leading byte order mark
 */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/**
 * Line endings do not matter when comparing or hashing text: CRLF becomes LF.
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Split text into lines that keep their own terminator, so joining them gives the text back.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * @param {string} line a line from `splitLines`
 * @returns {string} the line without its terminator (LF or CRLF)
 */
export function stripEol(line) {
  return line.replace(/\r?\n$/, '');
}

/**
 * @param {string[]} lines lines from `splitLines`
 * @returns {string} the file's own line ending: that of its first terminated line, else LF
 */
export function lineEnding(lines) {
  const first = lines.find((l) => l.endsWith('\n'));
  return first?.endsWith('\r\n') ? '\r\n' : '\n';
}

/**
 * @typedef {object} SplitNote
 * @property {string[]} lines every line of the note, without the byte order mark
 * @property {boolean} present whether the first line opens a frontmatter block (`---`)
 * @property {number} end index in `lines` of the line that closes the block, or -1 when there is no
 *   block or it is never closed
 * @property {number} bodyStart index in `lines` of the first body line: just after the closing
 *   line, or 0 when there is no closed block
 */

/**
 * Find the YAML frontmatter block at the top of a Markdown note. A note carries
 * frontmatter when its first line is `---`; the block ends at the next line that
 * is `---` or `...`. CRLF and LF files give the same result.
 * @param {string} text file content
 * @returns {SplitNote}
 */
export function splitFrontmatter(text) {
  const lines = stripBom(text).split(/\r?\n/);
  if (lines[0].trimEnd() !== '---') return { lines, present: false, end: -1, bodyStart: 0 };
  const end = lines.findIndex((line, i) => i > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'));
  return { lines, present: true, end, bodyStart: end === -1 ? 0 : end + 1 };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * How a line relates to fenced code blocks.
 * @typedef {'text' | 'fence-open' | 'code' | 'fence-close'} FenceState
 */

/**
 * Track fenced code blocks line by line. Call the returned function with every
 * line of a note, in order. A fence opens with three or more backticks or
 * tildes (a backtick fence whose info string holds a backtick is an inline code
 * span, not a fence) and closes with a line of the same character, at least as
 * long, and nothing else.
 * @returns {(line: string) => FenceState}
 */
export function fenceTracker() {
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  return (line) => {
    const marker = FENCE.exec(line);
    if (fence !== null) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') {
        fence = null;
        return 'fence-close';
      }
      return 'code';
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      return 'fence-open';
    }
    return 'text';
  };
}
