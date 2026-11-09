/**
 * The claude-second-brain adapter: a vault built with the `claude-second-brain` template, an LLM
 * wiki that Claude maintains from immutable raw sources (ADR 0011; research note
 * `docs/research/other-frameworks-vault-formats.md`, section 1.1).
 *
 * Detection. The signature is three paths together: a `raw-sources/` folder, `wiki/index.md` and
 * `wiki/log.md`. Confidence is 0.8 when all three exist (0 when any is missing, so a vault that only
 * partly looks like it falls through to `generic`), plus 0.15 when the root `CLAUDE.md` is titled
 * "LLM Wiki - Schema & Operating Instructions" (any dash), plus 0.05 for further template marks
 * (`.qmd/`, `wiki/overview.md`, `wiki/sources/` or `wiki/qa/` pages).
 *
 * Mapping, one outcome per file:
 *
 * - `raw-sources/**` (articles, pdfs, personal): raw sources, `10-sources/<file name>`, bytes kept.
 *   The framework recorded no sidecar, so each gets one filled from marked defaults (the engine's
 *   `sidecar_seed`), with the folder it came from kept as `source_folder`. `README.md` is kept
 *   verbatim, and a `*.meta.json` found there is kept verbatim too, never read as a sidecar.
 * - `wiki/*.md` by the frontmatter `type` (the six page types):
 *     source-summary -> 40-compiled/sources/, note type `source`
 *     topic, entity, qa, overview -> 40-compiled/ (same sub-folder as in `wiki/`), note types
 *       `concept`, `entity`, `concept`, `concept`. The Instance requires a cited source for these, so
 *       a page whose `sources` list is empty cannot be mapped and is kept verbatim (`no-sources`);
 *       only an `overview` without sources becomes a `moc`, a map of the wiki, which needs none.
 *     `wiki/index.md` -> 40-compiled/wiki-index.md, note type `moc` (the Instance regenerates its own
 *       zone indexes; this copy keeps the old catalog and its links)
 *     `wiki/log.md` -> 50-ops/log/<first month>.md, entries verbatim with the hash chain added
 *   The original `type` always survives: a changed type moves to `legacy_type`, other keys the schema
 *   lacks (`related`) become `legacy_` keys. A page with no valid frontmatter or an unknown `type`
 *   is kept verbatim (`type-unknown`); so is any other `admin` page.
 * - The root `CLAUDE.md` (the framework's schema) and `raw-sources/README.md` are kept verbatim
 *   (`framework-file`); every other note and file outside `raw-sources/` and `wiki/` is the curator's
 *   and is kept verbatim.
 * - Excluded, with a reason: `.qmd/` (`derived-cache`), `.claude/` `.cursor/` `.smart-env/`
 *   (`agent-state`), `.trash/` (`trash`), Obsidian plugin `data.json` (`plugin-data`, may hold
 *   tokens), the template's tooling (`framework-tooling`) and `.gitkeep` files (`placeholder`).
 *
 * Contradiction callouts (`> [!WARNING] Contradiction`) and uncertainty markers (`[?]`) are body text,
 * which the frontmatter mapping never touches.
 */
import { join } from 'node:path';
import { readFrontmatter } from '../../frontmatter.js';
import { normalizeNewlines, stripBom } from '../../markdown.js';
import { readSafeText } from '../../safe-read.js';
import { isSidecarPath } from '../../sidecar.js';
import { ZONES } from '../../zones.js';
import { baseName, commonExclusion, excluded, mapped, mappedNote, preserved, trashOrPluginData } from '../adapter-kit.js';
import { withPreamble } from '../carry-log.js';
import { finalConfidence } from '../detect-kit.js';

export const id = 'claude-second-brain';
export const summary = 'A claude-second-brain vault: raw-sources, wiki pages, index and log';

/** The six page types the template defines. */
const PAGE_TYPES = new Set(['overview', 'topic', 'entity', 'source-summary', 'qa', 'admin']);

/** Page types the Instance can only hold with a cited source. */
const NEEDS_SOURCES = new Map([
  ['topic', 'concept'],
  ['entity', 'entity'],
  ['qa', 'concept'],
]);

/** Files at the vault root that belong to the template's tooling, not to the curator. */
const TOOLING = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'mise.toml', 'tsconfig.json', '.gitignore', '.gitignore.template']);

/** Root folders of tools and agents: state of one machine or one session. */
const AGENT_STATE = new Set(['.claude', '.cursor', '.smart-env']);

/** @typedef {{ files: string[] }} Context */

/**
 * @param {string} root
 * @param {string} file source-relative path
 * @returns {Promise<string | null>} the text, or null when it is not readable UTF-8
 */
async function readText(root, file) {
  const read = await readSafeText(join(root, ...file.split('/')));
  return read.status === 'ok' ? read.text : null;
}

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(root, { files }) {
  const present = new Set(files);
  const marks = [
    ['raw-sources/ folder', files.some((f) => f.startsWith('raw-sources/'))],
    ['wiki/index.md', present.has('wiki/index.md')],
    ['wiki/log.md', present.has('wiki/log.md')],
  ];
  const missing = marks.filter(([, found]) => !found).map(([name]) => String(name));
  if (missing.length > 0) return { confidence: 0, evidence: [`missing ${missing.join(', ')}`] };

  const evidence = ['raw-sources/ folder', 'wiki/index.md', 'wiki/log.md'];
  let confidence = 0.8;
  const schema = present.has('CLAUDE.md') ? await readText(root, 'CLAUDE.md') : null;
  const title = schema === null ? undefined : stripBom(schema).split(/\r?\n/).find((line) => line.trim() !== '');
  if (title !== undefined && /^#\s+LLM Wiki\s*[-–—]+\s*Schema/i.test(title)) {
    confidence += 0.15;
    evidence.push('CLAUDE.md titled "LLM Wiki - Schema & Operating Instructions"');
  }
  const extra = files.some((f) => f.startsWith('.qmd/') || f === 'wiki/overview.md' || /^wiki\/(sources|qa)\/./.test(f));
  if (extra) {
    confidence += 0.05;
    evidence.push('template marks (.qmd/, wiki/overview.md, wiki/sources/ or wiki/qa/ pages)');
  }
  return { confidence: finalConfidence(confidence, 1), evidence };
}

/**
 * @param {string} file source-relative path
 * @returns {string | null} why the file is never imported, or null
 */
function exclusion(file) {
  const common = commonExclusion(file);
  if (common !== null) return common;
  const segments = file.split('/');
  const name = /** @type {string} */ (segments.at(-1));
  if (segments[0] === '.qmd') return 'derived-cache';
  if (AGENT_STATE.has(segments[0])) return 'agent-state';
  const cleanup = trashOrPluginData(file);
  if (cleanup !== null) return cleanup;
  if (name === '.gitkeep') return 'placeholder';
  if (segments.length === 1 && TOOLING.has(name)) return 'framework-tooling';
  if (segments[0] === 'scripts' && segments[1] === 'qmd') return 'framework-tooling';
  return null;
}

/**
 * @param {unknown} sources a frontmatter `sources` value
 * @returns {boolean} true when it lists at least one source
 */
const hasSources = (sources) => Array.isArray(sources) && sources.some((s) => typeof s === 'string' && s.trim() !== '');

/**
 * One wiki page.
 * @param {string} root
 * @param {string} file `wiki/...md`
 * @returns {Promise<import('../plan.js').PlanEntry>}
 */
async function planPage(root, file) {
  if (file === 'wiki/log.md') return planLog(root, file);
  const text = await readText(root, file);
  const frontmatter = text === null ? null : readFrontmatter(normalizeNewlines(stripBom(text)));
  const type = frontmatter !== null && frontmatter.present && !('error' in frontmatter) ? frontmatter.data.type : undefined;
  if (typeof type !== 'string' || !PAGE_TYPES.has(type)) return preserved(id, file, 'type-unknown');
  const data = /** @type {{ present: true, data: Record<string, unknown> }} */ (frontmatter).data;
  const below = file.slice('wiki/'.length);

  if (file === 'wiki/index.md') return mappedNote(file, `${ZONES.compiled}/wiki-index.md`, 'moc');
  if (type === 'admin') return preserved(id, file, 'admin-page');
  if (type === 'source-summary') return mappedNote(file, `${ZONES.compiled}/${below.startsWith('sources/') ? below : `sources/${baseName(below)}`}`, 'source');
  const cited = hasSources(data.sources);
  if (type === 'overview') return mappedNote(file, `${ZONES.compiled}/${below}`, cited ? 'concept' : 'moc');
  return cited ? mappedNote(file, `${ZONES.compiled}/${below}`, /** @type {string} */ (NEEDS_SOURCES.get(type))) : preserved(id, file, 'no-sources');
}

/**
 * The log: carried over when it converts cleanly, kept verbatim when it has no entry or cannot convert.
 * @param {string} root
 * @param {string} file
 * @returns {Promise<import('../plan.js').PlanEntry>}
 */
async function planLog(root, file) {
  const text = await readText(root, file);
  if (text === null) return preserved(id, file, 'log-unreadable');
  try {
    const { month } = withPreamble(text, id);
    return mapped(file, `${ZONES.ops}/log/${month}.md`, { kind: 'log', transforms: ['log-chain-preamble'] });
  } catch (error) {
    return preserved(id, file, /** @type {{ code?: string }} */ (error).code === 'no-entries' ? 'log-empty' : 'log-unconvertible');
  }
}

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<import('../plan.js').PlanEntry[]>}
 */
export async function plan(root, { files }) {
  /** @type {import('../plan.js').PlanEntry[]} */
  const entries = [];
  for (const file of files) {
    const reason = exclusion(file);
    const lower = file.toLowerCase();
    if (reason !== null) {
      entries.push(excluded(file, reason));
    } else if (file === 'CLAUDE.md' || file === 'raw-sources/README.md') {
      entries.push(preserved(id, file, 'framework-file'));
    } else if (file.startsWith('raw-sources/')) {
      if (isSidecarPath(file)) {
        entries.push(preserved(id, file, 'unexpected-sidecar'));
      } else {
        const folder = file.split('/').length > 2 ? file.split('/')[1] : null;
        entries.push(
          mapped(file, `${ZONES.sources}/${baseName(file)}`, {
            kind: 'raw-source',
            sidecar_seed: { original_name: baseName(file), ...(folder === null ? {} : { source_folder: folder }) },
          }),
        );
      }
    } else if (file.startsWith('wiki/') && lower.endsWith('.md')) {
      entries.push(await planPage(root, file));
    } else {
      entries.push(preserved(id, file, lower.endsWith('.md') ? 'human-note' : 'no-zone'));
    }
  }
  return entries;
}
