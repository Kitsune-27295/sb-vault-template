/**
 * The generic adapter: any Markdown vault. It classifies only what is certain and keeps the rest
 * verbatim under `20-human/_imported/generic/` (ADR 0011). Certain means:
 *
 * - a file with a `<file>.meta.json` beside it that holds a sha256 is a raw source, so it goes to
 *   the Raw sources zone with its sidecar;
 * - a Markdown note whose frontmatter says `type: decision` or `type: lesson` is operational
 *   memory, so it goes to the Operations zone with its frontmatter mapped onto the schema.
 *
 * Everything a curator wrote by hand stays in the Human zone, whatever its frontmatter says.
 */
import { join } from 'node:path';
import { readFrontmatter } from '../../frontmatter.js';
import { readSafeText } from '../../safe-read.js';
import { isSidecarPath, rawSourcePathFor } from '../../sidecar.js';
import { ZONES } from '../../zones.js';
import { baseName, commonExclusion, excluded, findRawSources, mapped, mappedNote, preserved } from '../adapter-kit.js';

export const id = 'generic';
export const summary = 'Any Markdown vault: classifies only what is certain, keeps the rest verbatim';

/** Note types this adapter is certain about, with the Operations folder each goes to. */
const OPERATIONAL_TYPES = new Map([
  ['decision', `${ZONES.ops}/decisions`],
  ['lesson', `${ZONES.ops}/lessons`],
]);

/** @typedef {{ files: string[] }} Context */

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(root, { files }) {
  const notes = files.filter((f) => f.toLowerCase().endsWith('.md')).length;
  if (notes === 0) return { confidence: 0, evidence: ['no Markdown files'] };
  return { confidence: 0.2, evidence: [`${notes} Markdown files`, 'the fallback for any Markdown vault'] };
}

/**
 * @param {string} root
 * @param {Context} context
 * @returns {Promise<import('../plan.js').PlanEntry[]>}
 */
export async function plan(root, { files }) {
  const raws = await findRawSources(root, files, rawSourcePathFor);
  /** @type {import('../plan.js').PlanEntry[]} */
  const entries = [];
  for (const file of files) {
    const reason = commonExclusion(file);
    if (reason !== null) {
      entries.push(excluded(file, reason));
    } else if (raws.has(file)) {
      entries.push(mapped(file, `${ZONES.sources}/${baseName(file)}`, { kind: 'raw-source' }));
    } else if (isSidecarPath(file) && raws.has(rawSourcePathFor(file))) {
      // The engine settles a sidecar's destination beside its raw source; this one only has to be valid.
      entries.push(mapped(file, `${ZONES.sources}/${baseName(file)}`, { kind: 'sidecar', sidecar_for: rawSourcePathFor(file) }));
    } else {
      const type = file.toLowerCase().endsWith('.md') ? await operationalType(join(root, ...file.split('/'))) : null;
      entries.push(type === null ? preserved(id, file) : mappedNote(file, `${OPERATIONAL_TYPES.get(type)}/${baseName(file)}`, type));
    }
  }
  return entries;
}

/**
 * @param {string} path absolute path of a Markdown file
 * @returns {Promise<string | null>} the note type when the frontmatter is valid and names one this adapter maps
 */
async function operationalType(path) {
  const read = await readSafeText(path);
  if (read.status !== 'ok') return null;
  const frontmatter = readFrontmatter(read.text);
  if (!frontmatter.present || 'error' in frontmatter) return null;
  const type = frontmatter.data.type;
  return typeof type === 'string' && OPERATIONAL_TYPES.has(type) ? type : null;
}
