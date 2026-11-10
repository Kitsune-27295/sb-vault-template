/**
 * The `sb` adapter: a vault made with the `sb` template (docs/research/sb-vault-format-and-update-flow.md).
 *
 * Mapping (ADR 0011):
 *
 *   sources/<id>.md + <id>.meta.json     10-sources/<id>.md (bytes unchanged) + <id>.md.meta.json (rewritten: sidecar-map)
 *   sources/inbox/ pairs                 10-sources/ too: `sb capture` already names the raw source,
 *                                        and wiki pages cite those ids
 *   wiki/*.md  source, concept, entity,
 *              procedure                 40-compiled/ with the same type
 *   wiki/*.md  incident, analysis        40-compiled/ as `concept`; the original type stays in `legacy_type`
 *   memory/decisions/*.md                50-ops/decisions/ (type decision)
 *   memory/journal/**                    50-ops/journal/ as type `log`; the original type stays in `legacy_type`
 *   memory/hot.md, lessons.md, others    50-ops/memory/, 50-ops/lessons/, verbatim (the Instance keeps its own hot.md)
 *   log/YYYY-MM.md                       50-ops/log/ with the hash chain added to each entry
 *   notes/, context/, CONVENTIONS.md     20-human/
 *   AGENTS.md, CLAUDE.md, vault.map.yaml,
 *   eval/, import/, skills, .sb/*.json   kept verbatim under 20-human/_imported/sb/
 *   index.md, the rest of .sb/, tooling  excluded with a reason
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFrontmatter } from '../../frontmatter.js';
import { parseHeader } from '../../log.js';
import { normalizeNewlines, stripBom } from '../../markdown.js';
import { readSafeText } from '../../safe-read.js';
import { isSidecarPath } from '../../sidecar.js';
import { ZONES } from '../../zones.js';
import { baseName, commonExclusion, excluded, findRawSources, mapped, mappedNote, preserved } from '../adapter-kit.js';
import { finalConfidence } from '../detect-kit.js';
import { parseOldLog } from '../log-chain.js';

export const id = 'sb';
export const summary = 'A vault made with the sb template: frozen sources, wiki, memory, log and inbox';

/** Wiki page types and the note type each is written as. */
const WIKI_TYPES = new Map([
  ['source', 'source'],
  ['concept', 'concept'],
  ['entity', 'entity'],
  ['procedure', 'procedure'],
  ['incident', 'concept'],
  ['analysis', 'concept'],
]);

/** Files owned by the sb framework itself and rewritten by `sb upgrade`: the Instance has its own. */
const FRAMEWORK_FILES = new Map([
  ['setup-sb.py', 'framework-file'],
  ['.sb-version', 'framework-file'],
  ['.gitattributes', 'framework-file'],
  ['.github/workflows/sb-update.yml', 'framework-file'],
  ['.claude/settings.json', 'framework-file'],
]);

/** Folders that hold the state of one machine or one tool. */
const MACHINE_FOLDERS = ['.githooks', '.aios', '.cache', '.vscode'];

/** Files whose original text is kept for reference under the imported area. */
const REFERENCE_FILES = new Map([
  ['AGENTS.md', 'framework-original'],
  ['CLAUDE.md', 'framework-original'],
  ['vault.map.yaml', 'sb-tooling'],
  ['.sb/config.json', 'provenance'],
  ['.sb/templates.json', 'provenance'],
]);

const LOG_FILE = /^log\/\d{4}-(0[1-9]|1[0-2])\.md$/;
const LOG_LINE = /^## \[\d{4}-\d{2}-\d{2}\] [a-z][a-z-]* \| \S/m;

/** @typedef {{ files: string[] }} Context */

/** @param {string} root @param {string} source @returns {string} absolute path */
const abs = (root, source) => join(root, ...source.split('/'));

/** @param {string} path @returns {boolean} */
const isMarkdown = (path) => path.toLowerCase().endsWith('.md');

/**
 * Evidence is the sb-specific markers (a version file, the installer, the `.sb/` state) plus the
 * layout (flat wiki, sidecars beside sources, log lines, memory). The layout alone is common to other
 * frameworks, so without a marker the confidence stays below the generic adapter's 0.2.
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(root, { files }) {
  const has = (/** @type {(f: string) => boolean} */ test) => files.some(test);
  /** @type {string[]} */
  const evidence = [];
  let markers = 0;
  let layout = 0;
  const marker = (/** @type {number} */ weight, /** @type {string} */ text) => {
    markers += weight;
    evidence.push(text);
  };
  const shape = (/** @type {number} */ weight, /** @type {string} */ text) => {
    layout += weight;
    evidence.push(text);
  };
  if (files.includes('.sb-version')) marker(0.3, '.sb-version');
  if (files.includes('setup-sb.py')) marker(0.2, 'setup-sb.py');
  if (files.includes('.sb/config.json') || files.includes('.sb/templates.json')) marker(0.2, '.sb/ state (config.json or templates.json)');
  if (has((f) => /^wiki\/[^/]+\.md$/.test(f))) shape(0.1, 'wiki/ with pages');
  if (has((f) => /^sources\/(inbox\/)?[^/]+\.meta\.json$/.test(f))) shape(0.1, 'sources/ with .meta.json sidecars');
  if (files.includes('memory/hot.md')) shape(0.05, 'memory/hot.md');
  const logFile = files.find((f) => LOG_FILE.test(f));
  if (logFile !== undefined) {
    const head = (await readFile(abs(root, logFile), 'utf8').catch(() => '')).slice(0, 4096);
    if (LOG_LINE.test(head)) shape(0.1, 'log/YYYY-MM.md with "## [date] op | title" entries');
  }
  if (markers === 0) return { confidence: finalConfidence(layout, 0.15), evidence: evidence.length > 0 ? [...evidence, 'no sb marker file, so only a partial match'] : ['no sb signature'] };
  return { confidence: finalConfidence(markers + layout, 0.95), evidence };
}

/**
 * @param {string} path absolute path of a Markdown file
 * @returns {Promise<{ type: string | null, hasFrontmatter: boolean, valid: boolean }>}
 */
async function readType(path) {
  const read = await readSafeText(path);
  if (read.status !== 'ok') return { type: null, hasFrontmatter: false, valid: false };
  const frontmatter = readFrontmatter(normalizeNewlines(stripBom(read.text)));
  if (!frontmatter.present) return { type: null, hasFrontmatter: false, valid: true };
  if ('error' in frontmatter) return { type: null, hasFrontmatter: true, valid: false };
  return { type: typeof frontmatter.data.type === 'string' ? frontmatter.data.type : null, hasFrontmatter: true, valid: true };
}

/**
 * Raw sources of sb: a Markdown file under `sources/` whose `<stem>.meta.json` holds a sha256.
 * @param {string} sidecar a sidecar path
 * @returns {string | null} the raw source path it stands for
 */
const rawOf = (sidecar) => (sidecar.startsWith('sources/') ? `${sidecar.slice(0, -'.meta.json'.length)}.md` : null);

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<import('../plan.js').PlanEntry[]>}
 */
export async function plan(root, { files }) {
  const raws = await findRawSources(root, files, rawOf);
  const sidecars = new Map([...raws].map(([raw, sidecar]) => [sidecar, raw]));
  /** @type {import('../plan.js').PlanEntry[]} */
  const entries = [];
  for (const file of files) entries.push(await classify(root, file, raws, sidecars));
  return entries;
}

/**
 * @param {string} root
 * @param {string} file
 * @param {Map<string, string>} raws raw source path to sidecar path
 * @param {Map<string, string>} sidecars sidecar path to raw source path
 * @returns {Promise<import('../plan.js').PlanEntry>}
 */
async function classify(root, file, raws, sidecars) {
  const common = commonExclusion(file);
  if (common !== null) return excluded(file, common);
  const segments = file.split('/');
  const top = segments[0];
  const name = baseName(file);

  // Derived and machine state.
  if (file === 'index.md') return excluded(file, 'derived-index');
  if (FRAMEWORK_FILES.has(file)) return excluded(file, /** @type {string} */ (FRAMEWORK_FILES.get(file)));
  if (file === '.claude/settings.local.json' || file === '.obsidian/graph.json' || MACHINE_FOLDERS.includes(top)) return excluded(file, 'machine-state');
  if (top === '.sb') {
    if (REFERENCE_FILES.has(file)) return preserved(id, file, /** @type {string} */ (REFERENCE_FILES.get(file)));
    return excluded(file, /\.bak/.test(name) ? 'backup-copy' : 'derived-cache');
  }

  // Frozen and inbox sources.
  if (top === 'sources') {
    if (raws.has(file)) {
      return mapped(file, `${ZONES.sources}/${name}`, { kind: 'raw-source' });
    }
    const raw = sidecars.get(file);
    if (raw !== undefined) {
      // The engine settles a sidecar's destination beside its raw source; this one only has to be valid.
      return mapped(file, `${ZONES.sources}/${name}`, { kind: 'sidecar', sidecar_for: raw, transforms: ['sidecar-map'] });
    }
    return preserved(id, file, isSidecarPath(file) || isMarkdown(file) ? 'no-valid-sidecar' : 'no-zone');
  }

  // The wiki: compiled pages.
  if (top === 'wiki' && isMarkdown(file)) {
    const read = await readType(abs(root, file));
    const type = read.type === null ? undefined : WIKI_TYPES.get(read.type);
    if (type === undefined) return preserved(id, file, read.valid ? 'wiki-type-unmapped' : 'frontmatter-invalid');
    return mappedNote(file, `${ZONES.compiled}/${name}`, type);
  }

  // Memory: decisions and journal are typed notes, the rest is carried as written.
  if (top === 'memory' && isMarkdown(file)) {
    const rest = segments.slice(1).join('/');
    if (segments[1] === 'decisions' || segments[1] === 'journal') {
      const read = await readType(abs(root, file));
      if (!read.valid) return preserved(id, file, 'frontmatter-invalid');
      return segments[1] === 'decisions'
        ? mappedNote(file, `${ZONES.ops}/decisions/${name}`, 'decision')
        : mappedNote(file, `${ZONES.ops}/journal/${name}`, 'log');
    }
    // Free text in the Operations zone must not carry frontmatter the schema would judge.
    if ((await readType(abs(root, file))).hasFrontmatter) return preserved(id, file, 'unexpected-frontmatter');
    return mapped(file, file === 'memory/lessons.md' ? `${ZONES.ops}/lessons/lessons.md` : `${ZONES.ops}/memory/${rest}`);
  }
  if (top === 'memory') return preserved(id, file);

  // The log: entries kept line for line, chain added.
  if (LOG_FILE.test(file)) {
    const read = await readSafeText(abs(root, file));
    if (read.status !== 'ok' || parseOldLog(read.text) === null) return preserved(id, file, 'log-unparsable');
    return mapped(file, `${ZONES.ops}/log/${name}`, { transforms: ['log-chain'] });
  }
  if (top === 'log') return preserved(id, file);

  // The curator's own text.
  if (top === 'notes' || top === 'context') return mapped(file, `${ZONES.human}/${file}`);
  if (file === 'CONVENTIONS.md') return mapped(file, `${ZONES.human}/CONVENTIONS.md`);

  // Everything else, including tooling config, earlier imports and skills, stays verbatim.
  if (REFERENCE_FILES.has(file)) return preserved(id, file, /** @type {string} */ (REFERENCE_FILES.get(file)));
  return preserved(id, file);
}
