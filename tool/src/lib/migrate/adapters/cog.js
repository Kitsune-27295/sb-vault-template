/**
 * The `cog` adapter: a vault built with COG-second-brain (research note `other-frameworks-vault-formats.md`
 * section 1.2, ADR 0011).
 *
 * Detection (confidence 0 to 1, first evidence found adds up, capped at 0.98):
 *
 * - `COG-VERSION` at the root: 0.4 (the framework's own marker);
 * - the numbered folders `00-inbox` to `06-templates`, counted from the files the vault holds: 0.4
 *   times the share present, and only when at least four are present, so a vault with a lone
 *   `04-projects` folder is not taken for COG;
 * - `cog-update.sh` at the root: 0.1; `05-knowledge/people/README.md`: 0.1.
 *
 * A complete COG vault scores 0.98; the folders without the marker score at most 0.6, which still
 * beats the generic fallback (0.2) by more than the tie margin.
 *
 * Mapping (decisions for the points the research left UNVERIFIED):
 *
 * - Folders `00-inbox` to `05-knowledge` are curator content and keep their relative paths under
 *   `20-human/cog/`, byte for byte: people profiles keep the Compiled Truth and Timeline sections and
 *   every `[Source: [[path]] | date | confidence: x]` citation line exactly as written. They are NOT
 *   promoted to the compiled zone: an `entity` or `concept` note needs a `sources` list that resolves
 *   to a raw source, COG records none, and inventing provenance is worse than keeping the note human.
 * - `06-templates/` and everything that fits no folder stay verbatim under `20-human/_imported/cog/`.
 * - `COG-VERSION` is kept verbatim there too (reason `version-marker`) so the Instance remembers which
 *   COG release it came from.
 * - Framework-owned files, which `cog-update.sh` replaces (`.claude/`, `.agents/`, `skills/`,
 *   `scripts/`, plugin folders, the root docs and agent files, `05-knowledge/people/README.md`), are
 *   excluded with reason `framework-owned`. `.claude/settings*.json` is the exception: it holds the
 *   curator's own settings, so it is kept verbatim.
 * - Derived or unsafe state is excluded: `.trash/`, `.obsidian/cache/`, `*.tmp`, and Obsidian plugin
 *   `data.json` files (they can hold tokens).
 * - `MY-INTEGRATIONS.md` and any other file with a secret-looking string are quarantined by the engine.
 */
import { ZONES } from '../../zones.js';
import { commonExclusion, excluded, mapped, preserved, trashOrPluginData } from '../adapter-kit.js';
import { finalConfidence } from '../detect-kit.js';

export const id = 'cog';
export const summary = 'COG-second-brain: numbered folders, people profiles with Compiled Truth and Timeline';

/** The numbered folders of a COG vault, in order. */
const FOLDERS = ['00-inbox', '01-daily', '02-personal', '03-professional', '04-projects', '05-knowledge', '06-templates'];

/** Folders whose content is the curator's and is mapped (the template folder is only preserved). */
const CONTENT_FOLDERS = new Set(FOLDERS.slice(0, 6));

/** Where mapped content goes in the Instance. */
const MAPPED_AREA = `${ZONES.human}/cog`;

/** Folders at the root that `cog-update.sh` owns. */
const FRAMEWORK_DIRS = new Set(['.agents', '.claude', '.claude-plugin', '.cursor-plugin', '.gemini', '.kiro', '.github', 'skills', 'scripts']);

/** Files at the root that `cog-update.sh` owns. */
const FRAMEWORK_ROOT_FILES = new Set([
  'README.md',
  'SETUP.md',
  'WORKFLOW.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'cog-update.sh',
  'plugin.json',
  'marketplace-entry.json',
  '.cursorrules',
  'docs/AGENT-SUPPORT.md',
  'docs/SKILL-DISTILLATION.md',
  '05-knowledge/people/README.md',
]);

/** The curator's own Claude Code settings, which live inside a framework folder. */
const USER_SETTINGS = new Set(['.claude/settings.json', '.claude/settings.local.json']);

const VERSION_FILE = 'COG-VERSION';
const UPDATE_SCRIPT = 'cog-update.sh';
const PEOPLE_README = '05-knowledge/people/README.md';

/** @typedef {{ files: string[] }} Context */

/**
 * @param {string} _root
 * @param {Context} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(_root, { files }) {
  const present = new Set(files);
  const folders = FOLDERS.filter((folder) => files.some((f) => f.startsWith(`${folder}/`)));
  let confidence = 0;
  /** @type {string[]} */
  const evidence = [];
  if (present.has(VERSION_FILE)) {
    confidence += 0.4;
    evidence.push(`${VERSION_FILE} at the root`);
  }
  if (folders.length >= 4) {
    confidence += (0.4 * folders.length) / FOLDERS.length;
    evidence.push(`${folders.length} of ${FOLDERS.length} numbered folders (${folders.join(', ')})`);
  }
  if (present.has(UPDATE_SCRIPT)) {
    confidence += 0.1;
    evidence.push(`${UPDATE_SCRIPT} at the root`);
  }
  if (present.has(PEOPLE_README)) {
    confidence += 0.1;
    evidence.push(PEOPLE_README);
  }
  if (evidence.length === 0) return { confidence: 0, evidence: [`no ${VERSION_FILE}, no numbered COG folders`] };
  return { confidence: finalConfidence(confidence), evidence };
}

/** @param {string} file source-relative path @returns {string} its first folder, or an empty string for a file at the root */
const topFolder = (file) => (file.includes('/') ? file.slice(0, file.indexOf('/')) : '');

/**
 * The reason a file that is not curator content is never imported, or null.
 * @param {string} file source-relative path
 * @returns {string | null}
 */
function exclusionReason(file) {
  const common = commonExclusion(file);
  if (common !== null) return common;
  const cleanup = trashOrPluginData(file);
  if (cleanup !== null) return cleanup;
  if (file.startsWith('.obsidian/cache/')) return 'derived-cache';
  if (file.toLowerCase().endsWith('.tmp')) return 'temporary-file';
  if (USER_SETTINGS.has(file)) return null;
  if (FRAMEWORK_ROOT_FILES.has(file) || FRAMEWORK_DIRS.has(topFolder(file))) return 'framework-owned';
  return null;
}

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<import('../plan.js').PlanEntry[]>}
 */
export async function plan(root, { files }) {
  return files.map((file) => {
    const reason = exclusionReason(file);
    if (reason !== null) return excluded(file, reason);
    if (file === VERSION_FILE) return preserved(id, file, 'version-marker');
    if (USER_SETTINGS.has(file)) return preserved(id, file, 'user-settings');
    const folder = topFolder(file);
    if (CONTENT_FOLDERS.has(folder)) {
      return mapped(file, `${MAPPED_AREA}/${file}`, { kind: file.toLowerCase().endsWith('.md') ? 'note' : 'file' });
    }
    return preserved(id, file, folder === '06-templates' ? 'templates' : 'no-zone');
  });
}
