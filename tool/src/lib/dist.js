/**
 * The publish-tree builder (ADR 0012): a deterministic, allowlisted copy of what the public template
 * repository carries. Nothing is read from outside the allowlist, text is normalized to LF, files are
 * sorted, and no date or machine detail enters a byte, so one source commit gives one tree.
 *
 * Published layout: `README.md` (from `publish/README.md`), `LICENSE` (when the repository has one),
 * `.github/workflows/*` (from `publish/workflows/`, the reusable workflow of ticket #41),
 * `template/**` (the vault base) and `tool/**` (ADR 0013: `bin/`, `src/`, a reduced `package.json` and
 * `package-lock.json`, so a vault can run the tool without access to the private source repository).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { byCodeUnit, listFiles, OS_DROPPINGS } from './files.js';
import { hashContent, isText, normalizeLineEndings } from './hashing.js';
import { finding } from './report.js';
import { displayPath, secretNamePatterns } from './secret-names.js';
import { scanBytes } from './secrets.js';

/** Where each allowlisted source lives, relative to the repository root. */
export const SOURCES = Object.freeze({
  template: 'template',
  readme: 'publish/README.md',
  workflows: 'publish/workflows',
  licenseNames: ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'],
});

/** Folder names that are never published, at any depth of the template. */
const EXCLUDED_FOLDERS = new Set(['.git', 'node_modules', 'INPUT', 'tests']);

/** Folder prefixes (relative to the template) that are never published. */
const EXCLUDED_PREFIXES = ['docs/planning/', 'docs/research/', '.claude/worktrees/'];

/** @param {string} path path relative to the template, forward slashes @returns {string | null} why it is left out, or null */
function exclusionReason(path) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  if (segments.slice(0, -1).some((s) => EXCLUDED_FOLDERS.has(s))) return 'private-folder';
  if (EXCLUDED_PREFIXES.some((p) => path.startsWith(p))) return 'private-folder';
  if (name === 'settings.local.json' || /^\.env(\..*)?$/.test(name) && name !== '.env.example' || /\.(pem|key)$/.test(name)) return 'local-configuration';
  return null;
}

/** Account names in a path that do not identify a person. */
const NEUTRAL_NAMES = new Set(['public', 'default', 'all users', 'runner', 'user', 'username', 'name', 'you', 'yourname', 'me', 'example']);

// Case does not matter on Windows, and a path can be written as a file URL or percent-encoded.
const WINDOWS_HOME = /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>:*?|]+)/gi;
const POSIX_HOME = /(?:^|[^\w.])\/(?:Users|home)\/([^/\s"'`<>:*?|]+)/gi;

/**
 * @param {string} line
 * @returns {string} the line with ASCII percent escapes decoded, twice (a path encoded twice is still a path)
 */
function decodePercent(line) {
  const once = (/** @type {string} */ s) => s.replace(/%([0-7][0-9a-f])/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return once(once(line));
}

/**
 * Lines that name a personal absolute path (`C:\Users\<account>`, `/Users/<account>`,
 * `/home/<account>`), in any case, as a `file:///` URL, or percent-encoded. Placeholders (`<name>`,
 * `$USER`, `%USERNAME%`) and neutral accounts are fine.
 * @param {string} text
 * @returns {number[]} 1-based line numbers; never the matched text
 */
export function personalPathLines(text) {
  /** @type {number[]} */
  const lines = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    for (const line of [raw, decodePercent(raw)]) {
      for (const pattern of [WINDOWS_HOME, POSIX_HOME]) {
        for (const match of line.matchAll(pattern)) {
          const account = match[1].toLowerCase();
          if (!/^[$%{[<*~]/.test(account) && !NEUTRAL_NAMES.has(account)) {
            lines.push(i + 1);
            return;
          }
        }
      }
    }
  });
  return lines;
}

/**
 * @typedef {object} DistFile
 * @property {string} path published path, forward slashes
 * @property {Uint8Array} bytes published bytes (text with LF line endings)
 * @property {string} sha256
 *
 * @typedef {object} DistPlan
 * @property {DistFile[]} files sorted by path
 * @property {string} treeHash
 * @property {string | null} license the license file published, or null when the repository has none
 * @property {import('./report.js').Finding[]} sourceFindings missing sources, exclusions and the license note
 * @property {import('./report.js').Finding[]} secretFindings
 * @property {import('./report.js').Finding[]} pathFindings
 */

/** @param {string} path @returns {Promise<boolean>} */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** @param {Uint8Array} bytes @returns {Uint8Array} text normalized to LF, binary untouched */
const publishBytes = (bytes) => (isText(bytes) ? normalizeLineEndings(bytes) : bytes);

/**
 * The tree hash: sha256 of the sorted `<file sha256>  <path>` listing, so it covers every path and
 * every byte and nothing else.
 * @param {{ path: string, sha256: string }[]} files sorted by path
 * @returns {string}
 */
export function treeHashOf(files) {
  return hashContent(Buffer.from(files.map((f) => `${f.sha256}  ${f.path}\n`).join(''), 'utf8'));
}

/** Folders of the source repository that make the tool, published under `tool/`. Nothing else is. */
const TOOL_FOLDERS = ['bin', 'src'];

/** The `package.json` fields the published tool needs to run and to install its one dependency from the lockfile. */
const TOOL_PACKAGE_FIELDS = ['name', 'version', 'license', 'description', 'private', 'type', 'bin', 'engines', 'dependencies'];

/**
 * Add `tool/` to the collected files: `bin/`, `src/`, a reduced `package.json` and `package-lock.json`.
 * Tests, docs, the template, `publish/`, `.github/`, `INPUT` and `node_modules` are not in the allowlist.
 * A repository without `bin/` publishes no tool; with one, every part of the tool must be present.
 * @param {string} root
 * @param {(path: string, source: string) => Promise<void>} add
 * @param {import('./report.js').Finding[]} sourceFindings
 * @returns {Promise<boolean>} whether the repository carries a tool
 */
async function addTool(root, add, sourceFindings) {
  /** @type {Map<string, string[]>} */
  const folders = new Map();
  for (const folder of TOOL_FOLDERS) {
    folders.set(folder, await listFiles(join(root, folder), { includeIgnored: true, skip: (name, isDir) => !isDir && OS_DROPPINGS.has(name) }));
  }
  if (folders.get('bin')?.length === 0) return false;
  for (const [folder, names] of folders) {
    if (names.length === 0) sourceFindings.push(finding(folder, 'source-missing', 'error', `the tool folder ${folder}/ is missing or empty`));
    for (const name of names) await add(`tool/${folder}/${name}`, join(root, folder, ...name.split('/')));
  }
  if (await isFile(join(root, 'package-lock.json'))) await add('tool/package-lock.json', join(root, 'package-lock.json'));
  else sourceFindings.push(finding('package-lock.json', 'source-missing', 'error', 'the lockfile of the tool is missing'));
  return true;
}

/**
 * @param {string} root
 * @returns {Promise<Uint8Array | null>} the reduced `package.json` of the tool, or null when it cannot be read
 */
async function toolPackageBytes(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    /** @type {Record<string, unknown>} */
    const reduced = {};
    for (const field of TOOL_PACKAGE_FIELDS) if (pkg[field] !== undefined) reduced[field] = pkg[field];
    return Buffer.from(`${JSON.stringify(reduced, null, 2)}\n`, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Plan the publish tree: read the allowlisted sources, apply the exclusions, scan what stays. Writes
 * nothing.
 * @param {string} root absolute repository root
 * @returns {Promise<DistPlan>}
 */
export async function planDist(root) {
  /** @type {Map<string, Uint8Array>} */
  const collected = new Map();
  /** @type {import('./report.js').Finding[]} */
  const sourceFindings = [];

  /** @param {string} path @param {string} source */
  const add = async (path, source) => collected.set(path, publishBytes(await readFile(source)));

  const templateDir = join(root, SOURCES.template);
  const templateFiles = await listFiles(templateDir, { includeIgnored: true, skip: (name, isDir) => !isDir && OS_DROPPINGS.has(name) });
  if (templateFiles.length === 0) sourceFindings.push(finding(SOURCES.template, 'source-missing', 'error', 'the template folder is missing or empty'));
  for (const file of templateFiles) {
    const reason = exclusionReason(file);
    if (reason !== null) sourceFindings.push(finding(displayPath(`${SOURCES.template}/${file}`), 'excluded', 'info', `left out of the publication (${reason})`));
    else await add(`template/${file}`, join(templateDir, ...file.split('/')));
  }

  if (await isFile(join(root, SOURCES.readme))) await add('README.md', join(root, SOURCES.readme));
  else sourceFindings.push(finding(SOURCES.readme, 'source-missing', 'error', 'the README of the published repository is missing'));

  const workflowDir = join(root, SOURCES.workflows);
  for (const file of await listFiles(workflowDir)) {
    if (/\.ya?ml$/.test(file)) await add(`.github/workflows/${file}`, join(workflowDir, ...file.split('/')));
  }

  if (await addTool(root, add, sourceFindings)) {
    const pkg = await toolPackageBytes(root);
    if (pkg === null) sourceFindings.push(finding('package.json', 'source-missing', 'error', 'the package.json of the tool cannot be read'));
    else collected.set('tool/package.json', pkg);
  }

  /** @type {string | null} */
  let license = null;
  for (const name of SOURCES.licenseNames) {
    if (await isFile(join(root, name))) {
      license = name;
      await add('LICENSE', join(root, name));
      break;
    }
  }
  if (license === null) {
    sourceFindings.push(finding('LICENSE', 'license-missing', 'info', 'the repository has no license file: a license decision is needed, and the tree is built without one'));
  }

  const files = [...collected.entries()]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([path, bytes]) => ({ path, bytes, sha256: hashContent(bytes) }));

  /** @type {import('./report.js').Finding[]} */
  const secretFindings = [];
  /** @type {import('./report.js').Finding[]} */
  const pathFindings = [];
  for (const file of files) {
    // A file name is published too: one that matches a secret pattern fails the build like secret content,
    // and is named in the report by its redacted form only.
    const shown = displayPath(file.path);
    for (const pattern of secretNamePatterns(file.path)) {
      secretFindings.push(finding(shown, pattern, 'error', `secret pattern "${pattern}" matched in the file name`));
    }
    for (const hit of scanBytes(file.bytes)) {
      secretFindings.push(finding(shown, hit.pattern, 'error', `secret pattern "${hit.pattern}" matched at line ${hit.line}`, hit.line));
    }
    if (isText(file.bytes)) {
      for (const line of personalPathLines(Buffer.from(file.bytes).toString('utf8'))) {
        pathFindings.push(finding(shown, 'personal-path', 'error', `a personal absolute path appears at line ${line}`, line));
      }
    }
  }

  return { files, treeHash: treeHashOf(files), license, sourceFindings, secretFindings, pathFindings };
}

/**
 * The manifest written beside the tree. It holds no date, so the same source gives the same bytes.
 * @param {DistPlan} plan
 * @param {{ version: string, sourceCommit: string | null }} meta
 * @returns {object}
 */
export function manifestOf(plan, { version, sourceCommit }) {
  return {
    manifest_version: 1,
    framework_version: version,
    source_commit: sourceCommit,
    license: plan.license === null ? { file: null, decision_needed: true } : { file: 'LICENSE', source: plan.license, decision_needed: false },
    tree_hash: plan.treeHash,
    files: plan.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
}

/**
 * Compare a folder with the planned tree. Line endings are ignored for text (a CRLF checkout of the
 * same tree is equal); a top-level `.git` folder is not part of the tree.
 * @param {string} dir absolute folder to compare
 * @param {DistPlan} plan
 * @returns {Promise<import('./report.js').Finding[]>}
 */
export async function compareTree(dir, plan) {
  const listed = await listFiles(dir, { includeIgnored: true, skip: (name, isDir) => (isDir && name === '.git') || (!isDir && OS_DROPPINGS.has(name)) });
  // The tree's own `manifest.json` (written by `dist`, it cannot list itself) is not part of the planned files.
  const actual = listed.filter((path) => path !== 'manifest.json');
  const wanted = new Map(plan.files.map((f) => [f.path, f.sha256]));
  /** @type {import('./report.js').Finding[]} */
  const findings = [];
  for (const [path, sha256] of wanted) {
    if (!actual.includes(path)) findings.push(finding(displayPath(path), 'dist-missing', 'error', 'is in the built tree but not in the folder'));
    else if (hashContent(await readFile(join(dir, ...path.split('/')))) !== sha256) findings.push(finding(displayPath(path), 'dist-differs', 'error', 'differs from the built tree'));
  }
  for (const path of actual) {
    if (!wanted.has(path)) findings.push(finding(displayPath(path), 'dist-extra', 'error', 'is in the folder but not in the built tree'));
  }
  return findings;
}
