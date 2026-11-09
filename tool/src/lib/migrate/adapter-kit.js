/**
 * What every adapter needs and none should rewrite: the exclusions that hold for any vault, the
 * imported-area path, the entry constructors, and the search for raw sources with a sidecar.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OS_DROPPINGS } from '../files.js';
import { IMPORTED_AREA } from '../zones.js';
import { isSidecarPath } from '../sidecar.js';
import { asObject } from './sidecar-map.js';

/**
 * @typedef {import('./plan.js').PlanEntry} PlanEntry
 * @typedef {import('./plan.js').Outcome} Outcome
 */

/** Version-control folders: history, not content. */
const VERSION_CONTROL = new Set(['.git', '.svn', '.hg']);

/** Obsidian state that changes on every open and belongs to one machine. */
const OBSIDIAN_MACHINE_STATE = new Set(['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/workspaces.json']);

/**
 * The reason a file is never imported, whatever the framework: version-control folders, operating
 * system files, dependency folders and the machine state of Obsidian.
 * @param {string} source source-relative path with forward slashes
 * @returns {string | null} reason code, or null when the file is content
 */
export function commonExclusion(source) {
  const segments = source.split('/');
  const name = /** @type {string} */ (segments.at(-1));
  if (segments.slice(0, -1).some((s) => VERSION_CONTROL.has(s))) return 'version-control';
  // A `.git` FILE (a worktree or submodule pointer) holds an absolute path of the author's machine.
  if (name === '.git') return 'version-control';
  if (OS_DROPPINGS.has(name)) return 'os-file';
  if (segments.slice(0, -1).includes('node_modules')) return 'dependencies';
  if (OBSIDIAN_MACHINE_STATE.has(source)) return 'machine-state';
  return null;
}

/**
 * Where a file is kept verbatim when no Zone fits: `20-human/_imported/<adapter>/<source path>`.
 * @param {string} adapter adapter id
 * @param {string} source source-relative path
 * @returns {string}
 */
export const importedPath = (adapter, source) => `${IMPORTED_AREA}/${adapter}/${source}`;

/**
 * A file that is not imported.
 * @param {string} source
 * @param {string} reason stable reason code
 * @returns {PlanEntry}
 */
export function excluded(source, reason) {
  return { source, outcome: 'excluded', destination: null, reason, kind: 'file', transforms: [] };
}

/**
 * A file kept verbatim under the imported area.
 * @param {string} adapter adapter id
 * @param {string} source
 * @param {string} [reason] default `no-zone`
 * @returns {PlanEntry}
 */
export function preserved(adapter, source, reason = 'no-zone') {
  return { source, outcome: 'preserved', destination: importedPath(adapter, source), reason, kind: 'file', transforms: [] };
}

/**
 * A file mapped into a Zone.
 * @param {string} source
 * @param {string} destination
 * @param {Partial<PlanEntry>} [extra] other entry fields: `kind`, `type`, `transforms`, `sidecar_for`, `sidecar_seed`
 * @returns {PlanEntry}
 */
export function mapped(source, destination, extra = {}) {
  return { source, outcome: 'mapped', destination, reason: null, kind: 'file', transforms: [], ...extra };
}

/**
 * A Markdown page mapped to a compiled or operational note: its frontmatter is mapped onto the schema.
 * @param {string} source
 * @param {string} destination
 * @param {string} type the note type written
 * @returns {PlanEntry}
 */
export const mappedNote = (source, destination, type) => mapped(source, destination, { kind: 'note', type, transforms: ['frontmatter'] });

/** @param {string} path source-relative path @returns {string} the last segment */
export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Exclusions two adapters share for folders and files that Obsidian and its plugins leave around.
 * @param {string} source source-relative path with forward slashes
 * @returns {string | null} `trash` for the trash folder, `plugin-data` for a plugin's `data.json` (it can hold
 *   tokens), or null
 */
export function trashOrPluginData(source) {
  const segments = source.split('/');
  if (segments[0] === '.trash') return 'trash';
  if (segments[0] === '.obsidian' && segments[1] === 'plugins' && segments.length > 2 && segments.at(-1) === 'data.json') return 'plugin-data';
  return null;
}

/**
 * Raw sources: a file with a sidecar beside it that parses and holds a sha256.
 * @param {string} root absolute source path
 * @param {string[]} files every source file
 * @param {(sidecar: string) => string | null} rawOf the raw source path a sidecar path stands for, or null when it is none
 * @returns {Promise<Map<string, string>>} raw source path to its sidecar path
 */
export async function findRawSources(root, files, rawOf) {
  const present = new Set(files);
  /** @type {Map<string, string>} */
  const raws = new Map();
  for (const file of files) {
    if (!isSidecarPath(file) || commonExclusion(file) !== null) continue;
    const raw = rawOf(file);
    if (raw === null || !present.has(raw) || commonExclusion(raw) !== null) continue;
    try {
      const sidecar = asObject(JSON.parse(await readFile(join(root, ...file.split('/')), 'utf8')));
      if (typeof sidecar?.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sidecar.sha256)) raws.set(raw, file);
    } catch {
      // not a sidecar this adapter can read: both files are kept verbatim by the caller
    }
  }
  return raws;
}
