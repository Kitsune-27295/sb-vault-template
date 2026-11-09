/**
 * Shared logic of `attach` and `detach`: where the global file of a tool is, how to read it
 * safely. Writing is in `safe-write.js`; the text edits themselves are in `attach-block.js`.
 */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './errors.js';
import { BYTE_LIMIT, LINE_BUDGET, editLines, scanMarkers } from './attach-block.js';
import { requireDirectory } from './instance.js';
import { invocation } from './attach-paths.js';
import { splitLines } from './markdown.js';
import { absoluteSlash, slash } from './paths.js';
import { readSafeText } from './safe-read.js';

/**
 * The tools `attach` can write to: where each one's global instruction file is. The directory is
 * `<home>/<dirName>` unless the environment variable `envDir` names another one (Codex home).
 * @type {Readonly<Record<string, { label: string, dirName: string, file: string, envDir?: string, note?: string }>>}
 */
const TOOLS = Object.freeze({
  claude: { label: 'Claude Code', dirName: '.claude', file: 'CLAUDE.md' },
  codex: { label: 'Codex', dirName: '.codex', file: 'AGENTS.md', envDir: 'CODEX_HOME' },
  gemini: { label: 'Gemini CLI and Antigravity', dirName: '.gemini', file: 'GEMINI.md', note: 'Gemini CLI and Antigravity both read this file' },
  copilot: { label: 'VS Code Copilot', dirName: '.copilot', file: 'copilot-instructions.md' },
});

/** Targets with a global file, in the order `--target all` visits them. */
export const FILE_TARGETS = Object.freeze(Object.keys(TOOLS));

/** Targets only `--print` accepts: tools with no global file to write. */
const PRINT_ONLY_TARGETS = Object.freeze(['cursor']);

/** @param {string} target a name from `FILE_TARGETS` @returns {{ label: string, note?: string }} */
export const toolInfo = (target) => TOOLS[target];

/**
 * @param {string | undefined} value the `--target` option: names separated by commas, or `all`
 * @param {boolean} print whether `--print` was given, which also accepts the print-only targets
 * @returns {string[]} distinct target names, in the order given
 * @throws {UsageError} for a missing, empty or unknown name, or a print-only name without `--print`
 */
export function parseTargets(value, print = false) {
  const known = print ? [...FILE_TARGETS, ...PRINT_ONLY_TARGETS] : FILE_TARGETS;
  const supported = `${known.join(', ')}, all`;
  if (value === undefined) throw new UsageError(`--target is required; supported: ${supported}`);
  const names = value.split(',').map((n) => n.trim());
  if (names.some((n) => n === '')) throw new UsageError(`--target has an empty name in "${value}"; supported: ${supported}`);
  const targets = new Set();
  for (const name of names) {
    if (name === 'all') FILE_TARGETS.forEach((t) => targets.add(t));
    else if (known.includes(name)) targets.add(name);
    else if (PRINT_ONLY_TARGETS.includes(name)) throw new UsageError(`${name} has no global file to write; use --print to get a block to paste`);
    else throw new UsageError(`unknown target "${name}"; supported: ${supported}`);
  }
  return [...targets];
}

/**
 * `--permissions` edits the Claude Code settings only, so the targets must resolve to exactly `claude`.
 * @param {string[]} targets names from `parseTargets`
 * @throws {UsageError} for any other target, a list of several, or `all`
 */
export function requireClaudeOnly(targets) {
  if (targets.length !== 1 || targets[0] !== 'claude') throw new UsageError(`--permissions applies only to --target claude, not ${targets.join(', ')}; nothing was written`);
}

/** @param {string | undefined} value the `--home` option; the OS home directory when absent @returns {Promise<string>} */
export function resolveHome(value) {
  return requireDirectory(value ?? homedir(), 'home directory');
}


/**
 * @typedef {object} Loaded
 * @property {string} target target name
 * @property {string} dir tool directory
 * @property {string} file global instruction file
 * @property {boolean} skipped the tool directory does not exist
 * @property {boolean} existed the file exists
 * @property {string} text its text, empty when it does not exist
 * @property {string[]} lines
 * @property {import('./attach-block.js').Scan} scan
 * @property {{ rule: string, message: string }[]} refusals reasons the file must not be edited
 */

/**
 * Read a tool's global file without following links; every reason not to edit it becomes a refusal.
 * @param {string} home
 * @param {string} target a name from `FILE_TARGETS`
 * @returns {Promise<Loaded>}
 */
export async function loadTarget(home, target) {
  const tool = TOOLS[target];
  const override = tool.envDir === undefined ? undefined : process.env[tool.envDir];
  const dir = override !== undefined && override !== '' ? resolve(override) : join(home, tool.dirName);
  const file = join(dir, tool.file);
  /** @type {Loaded} */
  const loaded = { target, dir, file, skipped: false, existed: false, text: '', lines: [], scan: { blocks: new Map(), problems: [] }, refusals: [] };
  const dirInfo = await lstat(dir).catch(() => null);
  if (dirInfo === null) return { ...loaded, skipped: true };
  if (!dirInfo.isDirectory()) return { ...loaded, refusals: [{ rule: 'target-not-file', message: `${slash(dir)} is not a directory` }] };
  const read = await readSafeText(file);
  if (read.status === 'missing') return loaded;
  if (read.status === 'refused') return { ...loaded, existed: true, refusals: [{ rule: read.rule, message: `${slash(file)} ${read.reason}` }] };
  const text = read.text;
  const lines = splitLines(text);
  const scan = scanMarkers(lines);
  return { ...loaded, existed: true, text, lines, scan, refusals: scan.problems };
}

/**
 * Edit the loaded file in memory: add or update the block of `name`, or remove it when `block` is null.
 * @param {Loaded} loaded a target with no refusals
 * @param {string} name
 * @param {string[] | null} block
 * @returns {{ action: 'add' | 'update' | 'remove' | 'unchanged' | 'absent', text: string, lines: number, bytes: number, overBudget: boolean }}
 * @throws {UsageError} when the result would be larger than the hard limit
 */
export function planEdit(loaded, name, block) {
  const edit = editLines(loaded.lines, loaded.scan, name, block);
  if (edit.action === 'add' && loaded.scan.openFence) {
    throw new UsageError(`${slash(loaded.file)} ends inside an unclosed fenced code block, where a new block would not be seen; close the fence by hand; nothing was written`);
  }
  const bytes = Buffer.byteLength(edit.text, 'utf8');
  if (block !== null && bytes > BYTE_LIMIT) {
    throw new UsageError(`${slash(loaded.file)} would be ${bytes} bytes, above the ${BYTE_LIMIT} byte limit; nothing was written`);
  }
  const lines = splitLines(edit.text).length;
  return { ...edit, lines, bytes, overBudget: lines > LINE_BUDGET };
}

/** @param {Loaded} loaded @returns {string} why a missing tool directory is not an error */
export const skipMessage = (loaded) => `${TOOLS[loaded.target].label}: not installed here (no ${slash(loaded.dir)} directory); skipped, nothing was written`;

/**
 * @param {Loaded[]} loadedFiles the targets of one run, read
 * @returns {void}
 * @throws {UsageError} when any of the files must not be edited; no target is written then
 */
export function requireEditable(loadedFiles) {
  const refused = loadedFiles.filter((l) => l.refusals.length > 0);
  if (refused.length === 0) return;
  const parts = refused.map((l) => `refusing ${slash(l.file)}: ${l.refusals.map((r) => r.message).join('; ')}`);
  throw new UsageError(`${parts.join('; ')}; nothing was written`);
}

/**
 * The command that repairs or removes a wiring, shown in findings: the same absolute call the block uses.
 * @param {object} input
 * @param {'attach' | 'detach'} input.verb
 * @param {string} input.instance the Instance path with forward slashes
 * @param {string} input.target a name from `FILE_TARGETS`
 * @param {string | undefined} input.homeOption the `--home` value as given, repeated so the command acts on the same files
 * @param {boolean} [input.permissions] the command works on the Claude Code settings
 * @returns {string}
 */
export function repairCommand({ verb, instance, target, homeOption, permissions = false }) {
  const { node, cli } = invocation();
  const where = homeOption === undefined ? '' : ` --home "${absoluteSlash(homeOption)}"`;
  return `"${node}" "${cli}" ${verb} "${instance}" --target ${target}${permissions ? ' --permissions' : ''} --apply${where}`;
}
