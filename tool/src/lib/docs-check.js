/**
 * Documentation consistency: the docs of the framework repository are checked
 * against the code that is actually running. The "reality" is the set of
 * command modules in `src/commands/` and doctor check modules in `src/checks/`
 * of THIS framework; the documents come from the repository root being
 * checked, so a fixture doc tree can be checked against the real code.
 *
 * What counts as a citation (a document author controls these by how they write):
 *   - a command: `sbk <name>` or `bin/sbk.js <name>` inside a code span or fenced block;
 *   - a doctor check id: a backticked id in the first cell of a table whose header cell is
 *     "Check", a `- \`id\`: ...` bullet under a "Doctor checks" heading, or a backticked id
 *     next to the words "check" or "checks" (before or after);
 *   - a count: "<N> doctor checks" or "<N> commands" in prose, N as digits or a number word.
 *
 * Known limits: link anchors (`#section`) are not verified; prose that names a
 * command or check without code formatting is not read; a count phrased any
 * other way is not read.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { listFiles } from './files.js';
import { loadModules } from './discover.js';
import { extractLinks } from './links.js';
import { fenceTracker, normalizeNewlines, stripBom } from './markdown.js';
import { FRAMEWORK_ROOT } from './paths.js';
import { checkResult, finding } from './report.js';

const COMMANDS_DIR = join(FRAMEWORK_ROOT, 'src', 'commands');
const CHECKS_DIR = join(FRAMEWORK_ROOT, 'src', 'checks');

/** Documents that must exist in the repository. */
export const REQUIRED_DOCS = Object.freeze([
  'README.md',
  'CHANGELOG.md',
  'docs/setup-guide.md',
  'template/README.md',
  'template/AGENTS.md',
]);

/** Documents whose citations of commands, check ids and counts are verified, besides `docs/*.md`. */
const CITING_DOCS = ['README.md', 'CHANGELOG.md', 'template/README.md', 'template/AGENTS.md'];

/** Documents that must name every shipped doctor check. */
const CHECK_REFERENCE_DOCS = ['README.md', 'template/AGENTS.md'];

/** Root documents and folders whose relative Markdown links must resolve. */
const LINKED_ROOT_FILES = ['README.md', 'CHANGELOG.md', 'GLOSSARY.md', 'AGENTS.md', 'CLAUDE.md', 'template/README.md', 'template/AGENTS.md'];

const NUMBER_WORDS = new Map(
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
    .split(' ')
    .map((word, index) => [word, index + 1]),
);

/**
 * @typedef {import('./report.js').Finding} Finding
 *
 * @typedef {object} Reality
 * @property {{ name: string }[]} commands every command the CLI ships
 * @property {string[]} checkIds every doctor check the CLI ships
 */

/** @returns {Promise<Reality>} what the running framework actually ships */
export async function loadReality() {
  const commands = await loadModules(COMMANDS_DIR);
  const checks = await loadModules(CHECKS_DIR);
  return { commands: commands.map((c) => ({ name: c.name })), checkIds: checks.map((c) => c.id) };
}

/**
 * @param {string} root
 * @param {string} rel root-relative path with forward slashes
 * @returns {Promise<string | null>} text with LF endings, or null when the file does not exist
 */
async function readDoc(root, rel) {
  try {
    return normalizeNewlines(stripBom(await readFile(join(root, ...rel.split('/')), 'utf8')));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} root
 * @param {string} folder root-relative folder
 * @param {boolean} recursive
 * @returns {Promise<string[]>} root-relative paths of the `.md` files, sorted
 */
async function listMarkdown(root, folder, recursive) {
  const files = await listFiles(join(root, ...folder.split('/')), {
    recursive,
    skip: (name, isDirectory) => isDirectory && name.startsWith('.'),
  });
  return files.filter((f) => f.endsWith('.md')).map((f) => `${folder}/${f}`);
}

/**
 * @param {string} root
 * @returns {Promise<{ path: string, text: string }[]>} the documents whose citations are verified
 */
async function citingDocs(root) {
  const paths = [...CITING_DOCS, ...(await listMarkdown(root, 'docs', false))];
  const docs = [];
  for (const path of [...new Set(paths)]) {
    const text = await readDoc(root, path);
    if (text !== null) docs.push({ path, text });
  }
  return docs;
}

/**
 * Text that is code: every line of a fenced block and the content of every inline code span.
 * @param {string} text LF text
 * @returns {{ line: number, text: string }[]}
 */
function codeSegments(text) {
  /** @type {{ line: number, text: string }[]} */
  const segments = [];
  const stateOf = fenceTracker();
  text.split('\n').forEach((line, index) => {
    const state = stateOf(line);
    if (state === 'code') segments.push({ line: index + 1, text: line });
    if (state !== 'text') return;
    for (const span of line.matchAll(/`([^`\n]+)`/g)) segments.push({ line: index + 1, text: span[1] });
  });
  return segments;
}

/** Text with fenced blocks removed (line numbers kept), for reading prose. */
function proseLines(text) {
  /** @type {{ line: number, text: string }[]} */
  const lines = [];
  const stateOf = fenceTracker();
  text.split('\n').forEach((line, index) => {
    if (stateOf(line) === 'text') lines.push({ line: index + 1, text: line });
  });
  return lines;
}

/**
 * @param {string} text
 * @returns {{ name: string, line: number }[]} every command a document names
 */
export function citedCommands(text) {
  const cited = [];
  for (const segment of codeSegments(text)) {
    for (const match of segment.text.matchAll(/(?<![\w./-])(?:sbk|(?:\.\/)?bin\/sbk\.js)[ \t]+([a-z][a-z0-9-]*)(?![\w-])/g)) {
      cited.push({ name: match[1], line: segment.line });
    }
  }
  return cited;
}

const ID_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * @param {string} text
 * @returns {{ id: string, line: number }[]} every doctor check id a document names (see the module comment)
 */
export function citedCheckIds(text) {
  /** @type {{ id: string, line: number }[]} */
  const cited = [];
  const add = (/** @type {string} */ token, /** @type {number} */ line) => {
    if (ID_SHAPE.test(token)) cited.push({ id: token, line });
  };
  const prose = proseLines(text);
  let inCheckTable = false;
  let underChecksHeading = false;
  for (const { line, text: content } of prose) {
    const heading = /^#{1,6}\s+(.*)$/.exec(content);
    if (heading) underChecksHeading = /doctor checks/i.test(heading[1]);
    if (content.trimStart().startsWith('|')) {
      const cells = content.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
      if (/^:?-{2,}:?$/.test(cells[0])) continue;
      if (!inCheckTable) {
        inCheckTable = cells[0].toLowerCase() === 'check';
        continue;
      }
      const token = /^`([^`]+)`/.exec(cells[0]);
      if (token) add(token[1], line);
      continue;
    }
    inCheckTable = false;
    const bullet = /^\s*[-*]\s+`([^`]+)`:/.exec(content);
    if (underChecksHeading && bullet) add(bullet[1], line);
    for (const match of content.matchAll(/\bchecks?\s+((?:`[^`\n]+`(?:\s*(?:,|and|or)\s*)*)+)/gi)) {
      for (const token of match[1].matchAll(/`([^`\n]+)`/g)) add(token[1], line);
    }
    for (const match of content.matchAll(/`([^`\n]+)`\s+(?:doctor\s+)?check\b/gi)) add(match[1], line);
  }
  return cited;
}

/**
 * @param {string} text
 * @returns {{ kind: 'commands' | 'checks', count: number, line: number, phrase: string }[]} counts a document cites
 */
export function citedCounts(text) {
  const cited = [];
  const number = '(\\d+|' + [...NUMBER_WORDS.keys()].join('|') + ')';
  const pattern = new RegExp(`\\b${number}\\s+(doctor\\s+checks|(?:sbk\\s+)?commands)\\b`, 'gi');
  for (const { line, text: content } of proseLines(text)) {
    for (const match of content.matchAll(pattern)) {
      const count = /^\d+$/.test(match[1]) ? Number(match[1]) : /** @type {number} */ (NUMBER_WORDS.get(match[1].toLowerCase()));
      cited.push({ kind: /** @type {'commands' | 'checks'} */ (/checks/i.test(match[2]) ? 'checks' : 'commands'), count, line, phrase: match[0] });
    }
  }
  return cited;
}

/** @param {string} path @param {string} rule @param {string} message @param {number} [line] @returns {Finding} */
const error = (path, rule, message, line) => finding(path, rule, 'error', message, line);

/**
 * @param {{ path: string, text: string }[]} docs
 * @param {Reality} reality
 * @returns {Finding[]}
 */
function commandFindings(docs, reality) {
  const known = new Set(reality.commands.map((c) => c.name));
  /** @type {Finding[]} */
  const findings = [];
  for (const doc of docs) {
    for (const { name, line } of citedCommands(doc.text)) {
      if (!known.has(name)) {
        findings.push(error(doc.path, 'unknown-command', `names "sbk ${name}", which is not a command (commands: ${[...known].join(', ')})`, line));
      }
    }
  }
  return findings;
}

/**
 * @param {{ path: string, text: string }[]} docs
 * @param {Reality} reality
 * @returns {Finding[]}
 */
function checkIdFindings(docs, reality) {
  const known = new Set(reality.checkIds);
  /** @type {Finding[]} */
  const findings = [];
  for (const doc of docs) {
    for (const { id, line } of citedCheckIds(doc.text)) {
      if (!known.has(id)) findings.push(error(doc.path, 'unknown-check-id', `names the doctor check "${id}", which does not exist`, line));
    }
    if (!CHECK_REFERENCE_DOCS.includes(doc.path)) continue;
    const named = new Set([...doc.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
    for (const id of reality.checkIds) {
      if (!named.has(id)) findings.push(error(doc.path, 'check-undocumented', `does not document the doctor check \`${id}\``));
    }
  }
  return findings;
}

/**
 * @param {{ path: string, text: string }[]} docs
 * @param {Reality} reality
 * @returns {Finding[]}
 */
function countFindings(docs, reality) {
  const actual = { commands: reality.commands.length, checks: reality.checkIds.length };
  /** @type {Finding[]} */
  const findings = [];
  for (const doc of docs) {
    for (const cited of citedCounts(doc.text)) {
      if (cited.count !== actual[cited.kind]) {
        findings.push(
          error(doc.path, 'count-mismatch', `says "${cited.phrase}", but the framework ships ${actual[cited.kind]} ${cited.kind === 'checks' ? 'doctor checks' : 'commands'}`, cited.line),
        );
      }
    }
  }
  return findings;
}

/**
 * @param {string} root absolute repository root
 * @returns {Promise<string[]>} root-relative paths of every document whose links are verified
 */
async function linkedDocs(root) {
  const files = [];
  for (const rel of LINKED_ROOT_FILES) if ((await readDoc(root, rel)) !== null) files.push(rel);
  files.push(...(await listMarkdown(root, 'docs', true)));
  return [...new Set(files)].sort();
}

/**
 * Case-exact existence check: a link that only resolves on a case-insensitive
 * file system (Windows, macOS) is broken on Linux, where CI also runs.
 * @param {string} root
 * @param {string} rel root-relative path, normalized, forward slashes
 * @param {Map<string, Set<string> | null>} cache folder listings
 * @returns {Promise<boolean>}
 */
async function exists(root, rel, cache) {
  let folder = '';
  for (const part of rel.split('/').filter((p) => p !== '')) {
    if (!cache.has(folder)) {
      try {
        cache.set(folder, new Set(await readdir(join(root, ...folder.split('/').filter((p) => p !== '')))));
      } catch {
        cache.set(folder, null);
      }
    }
    if (!cache.get(folder)?.has(part)) return false;
    folder = folder === '' ? part : `${folder}/${part}`;
  }
  return true;
}

/**
 * @param {string} root
 * @returns {Promise<Finding[]>}
 */
async function linkFindings(root) {
  /** @type {Finding[]} */
  const findings = [];
  const cache = new Map();
  for (const path of await linkedDocs(root)) {
    const text = await readDoc(root, path);
    if (text === null) continue;
    for (const link of extractLinks(text)) {
      if (link.kind !== 'markdown') continue;
      const joined = link.target.startsWith('/') ? link.target.slice(1) : posix.join(posix.dirname(path), link.target.replaceAll('\\', '/'));
      const target = posix.normalize(joined);
      const inside = !target.startsWith('..') && resolve(root, ...target.split('/')).startsWith(resolve(root) + sep);
      if (!inside || !(await exists(root, target, cache))) {
        findings.push(error(path, 'broken-link', `link target "${link.target}" does not exist`, link.line));
      }
    }
  }
  return findings;
}

/**
 * @param {string} root
 * @param {Reality} reality
 * @returns {Promise<Finding[]>}
 */
async function releaseFindings(root, reality) {
  /** @type {Finding[]} */
  const findings = [];
  for (const rel of REQUIRED_DOCS) {
    if ((await readDoc(root, rel)) === null) findings.push(error(rel, 'file-missing', 'required document is missing'));
  }

  const readme = await readDoc(root, 'README.md');
  if (readme !== null) {
    const named = new Set(citedCommands(readme).map((c) => c.name));
    for (const { name } of reality.commands) {
      if (!named.has(name)) findings.push(error('README.md', 'command-undocumented', `does not document the command \`sbk ${name}\` (write it as \`sbk ${name}\` in a code span or block)`));
    }
    const lines = readme.split('\n');
    const start = lines.findIndex((l) => /^#{1,6}\s+.*exit codes?\b/i.test(l));
    let body = '';
    if (start !== -1) {
      const level = /^#+/.exec(lines[start])?.[0].length ?? 1;
      const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && (/^#+/.exec(l)?.[0].length ?? 7) <= level);
      body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
    }
    for (const code of ['0', '1', '2']) {
      if (!new RegExp(`(?<![\\w.])${code}(?![\\w.])`).test(body)) {
        findings.push(error('README.md', 'exit-codes-missing', `has no "Exit codes" section that explains exit code ${code}`));
      }
    }
  }

  const changelog = await readDoc(root, 'CHANGELOG.md');
  if (changelog !== null) {
    if (!/^#{1,3}\s+\[?(?:Unreleased|\d+\.\d+\.\d+)/im.test(changelog)) {
      findings.push(error('CHANGELOG.md', 'release-entry-missing', 'has no "Unreleased" or version heading'));
    }
    if (!/^#{1,6}\s+.*Upgrading from/im.test(changelog)) {
      findings.push(error('CHANGELOG.md', 'upgrade-section-missing', 'has no "Upgrading from" section'));
    }
  }
  return findings;
}

/**
 * Run every documentation check against a repository root.
 * @param {string} root absolute path of the repository whose documents are checked
 * @returns {Promise<import('./report.js').CheckResult[]>}
 */
export async function checkDocs(root) {
  const reality = await loadReality();
  const docs = await citingDocs(root);
  return [
    checkResult('docs-commands', commandFindings(docs, reality)),
    checkResult('docs-check-ids', checkIdFindings(docs, reality)),
    checkResult('docs-counts', countFindings(docs, reality)),
    checkResult('docs-links', await linkFindings(root)),
    checkResult('docs-release', await releaseFindings(root, reality)),
  ];
}
