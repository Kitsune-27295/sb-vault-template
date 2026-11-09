import { parse } from 'yaml';
import { splitFrontmatter } from './markdown.js';

/**
 * @typedef {{ present: false }
 *   | { present: true, data: Record<string, unknown> }
 *   | { present: true, error: string }} FrontmatterResult
 */

/** Frontmatter key `import` writes on every note it maps (the source path); its presence marks an imported note. */
export const IMPORT_MARKER = 'imported_from';

/**
 * @param {Record<string, unknown>} data frontmatter data of a note
 * @returns {boolean} true for a note the import engine wrote
 */
export function isImported(data) {
  return Object.hasOwn(data, IMPORT_MARKER);
}

/**
 * Read the YAML frontmatter block at the top of a Markdown note (see
 * `splitFrontmatter` for where the block starts and ends).
 * @param {string} text file content
 * @returns {FrontmatterResult}
 */
export function readFrontmatter(text) {
  const { lines, present, end } = splitFrontmatter(text);
  if (!present) return { present: false };
  if (end === -1) return { present: true, error: 'frontmatter block is not closed with a "---" line' };
  let value;
  try {
    value = parse(lines.slice(1, end).join('\n'));
  } catch (error) {
    const first = /** @type {Error} */ (error).message.split('\n')[0];
    return { present: true, error: `frontmatter is not valid YAML (${first})` };
  }
  if (value === null || value === undefined) return { present: true, data: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, error: 'frontmatter must be a YAML mapping of keys to values' };
  }
  return { present: true, data: /** @type {Record<string, unknown>} */ (value) };
}
