import { readFile } from 'node:fs/promises';

/** Suffix of a raw source's sidecar file: `<file>.meta.json`. */
export const SIDECAR_SUFFIX = '.meta.json';

/**
 * @typedef {object} Sidecar
 * @property {string} sha256 hash of the raw source (CRLF-normalized for text)
 * @property {string} captured_at ISO 8601 capture time
 * @property {string} origin file path or description of where the source came from
 * @property {string} original_name file name at capture time
 * @property {string} [supersedes] id of the version this one replaces
 * @property {string} [superseded_by] id of the version that replaces this one
 */

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isSidecarPath(path) {
  return path.endsWith(SIDECAR_SUFFIX);
}

/**
 * @param {string} rawSourcePath
 * @returns {string} path of the sidecar belonging to the raw source
 */
export function sidecarPathFor(rawSourcePath) {
  return rawSourcePath + SIDECAR_SUFFIX;
}

/**
 * @param {string} sidecarPath
 * @returns {string} path of the raw source the sidecar describes
 */
export function rawSourcePathFor(sidecarPath) {
  return sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
}

const REQUIRED_STRING_FIELDS = ['captured_at', 'origin', 'original_name'];

/**
 * Check a parsed sidecar against the format.
 * @param {unknown} value
 * @returns {string[]} problems; empty when valid
 */
export function validateSidecar(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['sidecar must be a JSON object'];
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    problems.push('sha256 must be 64 lowercase hex characters');
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  for (const field of ['supersedes', 'superseded_by']) {
    if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field] === '')) {
      problems.push(`${field} must be a non-empty string when present`);
    }
  }
  return problems;
}

/**
 * Read and validate a sidecar file.
 * @param {string} path absolute path of the sidecar
 * @returns {Promise<{ sidecar: Sidecar } | { problems: string[] }>}
 */
export async function readSidecar(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { problems: [`not valid JSON (${/** @type {Error} */ (error).message})`] };
  }
  const problems = validateSidecar(value);
  return problems.length > 0 ? { problems } : { sidecar: value };
}
