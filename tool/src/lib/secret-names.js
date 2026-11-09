/**
 * Secrets in FILE NAMES. A name that matches a secret pattern is treated like secret content: the
 * file is quarantined, and the name itself never reaches a report, a manifest, a log entry, an index
 * or a message. Two forms stand in for it, both derived from a hash of the path up to that segment,
 * so they are stable and cannot be turned back into the name:
 *
 * - the display form `[redacted-name-<8 hex>]`, for reports and messages;
 * - the safe form `redacted-name-<8 hex>`, for a destination path (no brackets, which Markdown links
 *   and wikilinks would misread). A short extension (`.md`) is kept in both.
 */
import { hashBytes } from './hashing.js';
import { scanText } from './secrets.js';

const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * @param {string} segment one path segment
 * @returns {string[]} names of the secret patterns the segment matches (underscores read as spaces too)
 */
function segmentPatterns(segment) {
  const hits = new Set([...scanText(segment), ...scanText(segment.replace(/_/g, ' '))].map((f) => f.pattern));
  return [...hits];
}

/**
 * @param {string} path forward-slash path
 * @returns {string[]} names of the secret patterns that any segment of the path matches, never the name
 */
export function secretNamePatterns(path) {
  return [...new Set(path.split('/').flatMap(segmentPatterns))];
}

/**
 * @param {string} path
 * @param {(hash: string) => string} stand the replacement of a secret segment, from its 8 hex of hash
 * @returns {string}
 */
function replaceSecretSegments(path, stand) {
  const segments = path.split('/');
  return segments
    .map((segment, i) => {
      if (segmentPatterns(segment).length === 0) return segment;
      const hash = hashBytes(Buffer.from(segments.slice(0, i + 1).join('/'), 'utf8')).slice(0, 8);
      const extension = i === segments.length - 1 ? (EXTENSION.exec(segment)?.[0] ?? '') : '';
      return `${stand(hash)}${extension}`;
    })
    .join('/');
}

/**
 * @param {string} path a source path
 * @returns {string} the path with each secret-matching segment replaced by `[redacted-name-<8 hex>]`; any other path unchanged
 */
export const displayPath = (path) => replaceSecretSegments(path, (hash) => `[redacted-name-${hash}]`);

/**
 * @param {string} path a source path
 * @returns {string} the path as a destination: each secret-matching segment replaced by `redacted-name-<8 hex>`
 */
export const safePath = (path) => replaceSecretSegments(path, (hash) => `redacted-name-${hash}`);
