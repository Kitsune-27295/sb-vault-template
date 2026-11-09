/**
 * The operations log: append-only Markdown files in `50-ops/log/`, one per
 * month (`YYYY-MM.md`), whose entries are linked by a hash chain so an edited,
 * removed or reordered entry can be detected without git.
 *
 * Entry format (LF shown; CRLF working copies are normalized before hashing):
 *
 *     ## [YYYY-MM-DD] <action> | <title>
 *     <optional body, any number of lines>
 *     <!-- chain: <64 lowercase hex> -->
 *
 * Entries in a file are separated by one blank line. The chain value of an
 * entry is `sha256(previousChain + "\n" + entryText)` as lowercase hex, where
 * `entryText` is the header line plus the body lines (LF line endings, no
 * trailing blank lines) and `previousChain` is the chain value of the entry
 * before it. The first entry of the whole log chains from GENESIS. The chain
 * runs across monthly files in file-name order.
 *
 * Known limit: the chain proves the entries are consistent with each other.
 * Removing the newest entries, or editing an entry and recomputing every chain
 * value after it, still yields a consistent chain, and the `capture-ledger`
 * check cannot see a capture whose entry was removed with it. Nothing inside
 * the Instance can prove otherwise; a copy of the newest chain value, or the
 * version history of the Instance, kept outside it, is the anchor.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { normalizeNewlines } from './markdown.js';
import { scanText } from './secrets.js';
import { ZONES } from './zones.js';

/** Log folder, relative to the vault root, with forward slashes. */
export const LOG_DIR = `${ZONES.ops}/log`;

/**
 * Actions only `capture` writes. Each entry titled with a source id is what the
 * `capture-ledger` check matches against the raw sources on disk, so `sbk log`
 * refuses them.
 */
export const CAPTURE_ACTIONS = Object.freeze(['capture', 'supersede']);

/** Chain value that precedes the first entry of a log. */
export const GENESIS = '0'.repeat(64);

const FILE_NAME = /^\d{4}-(0[1-9]|1[0-2])\.md$/;
const HEADER = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z][a-z0-9-]*) \| (\S.*)$/;
const CHAIN_LINE = /^<!-- chain: ([0-9a-f]{64}) -->$/;
const ACTION = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {object} Entry
 * @property {number} index 1-based position within its file
 * @property {number} line 1-based line number of the header
 * @property {string} header the header line
 * @property {string} text normalized entry text that is hashed
 * @property {string | null} chain stored chain value; null when the entry is malformed
 *
 * @typedef {object} LogProblem
 * @property {string} file file name inside the log folder
 * @property {'chain-broken' | 'entry-malformed' | 'log-file-name'} rule
 * @property {'error' | 'warning'} severity
 * @property {string} message
 *
 * @typedef {object} LogFile
 * @property {string} name
 * @property {Entry[]} entries
 * @property {LogProblem[]} problems parse problems
 */

/**
 * @param {string} previousChain
 * @param {string} entryText
 * @returns {string} chain value of the entry
 */
export function chainHash(previousChain, entryText) {
  return createHash('sha256').update(`${previousChain}\n${entryText}`).digest('hex');
}

/**
 * @param {string} header an entry header line
 * @returns {{ date: string, action: string, title: string } | null} null when it is not a valid header
 */
export function parseHeader(header) {
  const match = HEADER.exec(header);
  return match === null ? null : { date: match[1], action: match[2], title: match[3] };
}

/**
 * Split the content of one monthly file into entries.
 * @param {string} name file name, used in problem reports
 * @param {string} raw file content
 * @returns {LogFile}
 */
export function parseLogFile(name, raw) {
  const lines = normalizeNewlines(raw).split('\n');
  /** @type {Entry[]} */
  const entries = [];
  /** @type {LogProblem[]} */
  const problems = [];
  const problem = (/** @type {string} */ message) =>
    problems.push({ file: name, rule: 'entry-malformed', severity: 'error', message });

  /** @type {{ line: number, header: string, body: string[] } | null} */
  let open = null;
  /** @param {string | null} chain */
  const close = (chain) => {
    if (!open) return;
    const body = [...open.body];
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    entries.push({
      index: entries.length + 1,
      line: open.line,
      header: open.header,
      text: [open.header, ...body].join('\n'),
      chain,
    });
    if (chain === null) problem(`entry ${entries.length} "${open.header}" (line ${open.line}) has no valid chain line`);
    open = null;
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (HEADER.test(line)) {
      close(null);
      open = { line: lineNo, header: line, body: [] };
    } else if (line.startsWith('## [')) {
      problem(`line ${lineNo} looks like an entry header but does not match "## [YYYY-MM-DD] <action> | <title>"`);
      close(null);
    } else if (/^<!--\s*chain:/.test(line)) {
      if (!open) problem(`line ${lineNo} is a chain line outside an entry`);
      else if (!CHAIN_LINE.test(line)) {
        problem(`line ${lineNo} is a chain line with an invalid value`);
        close(null);
      } else close(/** @type {RegExpMatchArray} */ (line.match(CHAIN_LINE))[1]);
    } else if (open) {
      open.body.push(line);
    } else if (line.trim() !== '') {
      problem(`line ${lineNo} is text outside any entry`);
    }
  });
  close(null);
  return { name, entries, problems };
}

/**
 * Read every monthly file of the log in file-name order.
 * @param {string} vault absolute vault path
 * @returns {Promise<{ files: LogFile[], strays: string[] }>} `strays` are markdown files with a non-monthly name
 */
export async function readLog(vault) {
  const dir = join(vault, ...LOG_DIR.split('/'));
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { files: [], strays: [] };
    throw error;
  }
  const monthly = names.filter((n) => FILE_NAME.test(n)).sort();
  const strays = names.filter((n) => n.endsWith('.md') && !FILE_NAME.test(n)).sort();
  const files = [];
  for (const name of monthly) files.push(parseLogFile(name, await readFile(join(dir, name), 'utf8')));
  return { files, strays };
}

/**
 * Verify the chain of a whole log. Each entry is checked against the stored
 * chain value of the entry before it, so one edited entry gives one problem,
 * a removed entry gives one at its successor, and a swap gives two.
 * @param {{ files: LogFile[], strays: string[] }} log
 * @returns {LogProblem[]}
 */
export function verifyLog({ files, strays }) {
  /** @type {LogProblem[]} */
  const problems = [];
  let previous = GENESIS;
  for (const file of files) {
    problems.push(...file.problems);
    for (const entry of file.entries) {
      if (entry.chain === null) continue;
      if (chainHash(previous, entry.text) !== entry.chain) {
        problems.push({
          file: file.name,
          rule: 'chain-broken',
          severity: 'error',
          message:
            `entry ${entry.index} "${entry.header}" (line ${entry.line}) does not continue the chain: ` +
            'it was edited, or an entry before it was removed, moved or edited',
        });
      }
      previous = entry.chain;
    }
  }
  for (const name of strays) {
    problems.push({
      file: name,
      rule: 'log-file-name',
      severity: 'warning',
      message: 'not a monthly log file (YYYY-MM.md); it is not part of the chain',
    });
  }
  return problems;
}

/** @returns {string} today's local date as YYYY-MM-DD */
function today() {
  const d = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {string} date
 * @returns {boolean} true for a real calendar date in YYYY-MM-DD form
 */
function isCalendarDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

/**
 * Append one entry to the log. This is the only write path to the log; other
 * commands call it instead of touching the files.
 * @param {object} input
 * @param {string} input.vault absolute vault path
 * @param {string} input.action lowercase word such as `ingest`
 * @param {string} input.title one-line title
 * @param {string} [input.body] optional Markdown body
 * @param {string} [input.date] YYYY-MM-DD, default today (local time)
 * @returns {Promise<{ file: string, path: string, header: string, chain: string }>} `file` is vault-relative with forward slashes
 * @throws {UsageError} on invalid input, an older month than the newest file, or a log that already fails verification
 */
export async function appendEntry({ vault, action, title, body = '', date = today() }) {
  if (!ACTION.test(action)) throw new UsageError('action must be lowercase letters, digits and hyphens, starting with a letter');
  const cleanTitle = title.trim();
  if (cleanTitle === '' || /[\r\n]/.test(cleanTitle)) throw new UsageError('title must be one non-empty line');
  if (!isCalendarDate(date)) throw new UsageError(`date must be a real calendar date as YYYY-MM-DD, got "${date}"`);
  const cleanBody = normalizeNewlines(body).replace(/^\n+/, '').trimEnd();
  for (const line of cleanBody.split('\n')) {
    if (line.startsWith('## [') || /^<!--\s*chain:/.test(line)) {
      throw new UsageError(`body line would be read as a log entry header or chain line: ${line}`);
    }
  }
  // A log entry can never be corrected, so a secret must never get in. Only pattern names are reported.
  for (const [field, text] of [['action', action], ['title', cleanTitle], ['body', cleanBody]]) {
    const names = [...new Set(scanText(text).map((f) => f.pattern))];
    if (names.length > 0) {
      throw new UsageError(`the ${field} matches secret pattern(s) ${names.join(', ')}; nothing was written`);
    }
  }

  const log = await readLog(vault);
  if (verifyLog(log).some((p) => p.severity === 'error')) {
    throw new UsageError('the log fails verification, nothing was appended; run doctor and restore it first');
  }
  const name = `${date.slice(0, 7)}.md`;
  const newest = log.files.at(-1);
  if (newest && name < newest.name) {
    throw new UsageError(`the log is append-only: ${name} is older than the newest file ${newest.name}`);
  }
  const previous = log.files.flatMap((f) => f.entries).at(-1)?.chain ?? GENESIS;

  const header = `## [${date}] ${action} | ${cleanTitle}`;
  const text = cleanBody === '' ? header : `${header}\n${cleanBody}`;
  const chain = chainHash(previous, text);

  const dir = join(vault, ...LOG_DIR.split('/'));
  const path = join(dir, name);
  let existing = '';
  if (newest && newest.name === name) existing = await readFile(path, 'utf8');
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const separator = existing === '' ? '' : existing.endsWith('\n') ? eol : eol + eol;
  const block = `${text}\n<!-- chain: ${chain} -->\n`.replace(/\n/g, eol);
  await mkdir(dir, { recursive: true });
  await appendFile(path, separator + block);
  return { file: `${LOG_DIR}/${name}`, path, header, chain };
}
