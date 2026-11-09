import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const TEXT_SNIFF_BYTES = 8192;
const CR = 0x0d;
const LF = 0x0a;

/**
 * A file is text when its first 8 KB contain no NUL byte.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isText(bytes) {
  return !bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/**
 * Replace every CRLF pair with LF. Works on bytes so no encoding is assumed.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function normalizeLineEndings(bytes) {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === CR && bytes[i + 1] === LF) continue; // drop the CR, keep the LF
    out[length++] = bytes[i];
  }
  return out.subarray(0, length);
}

/**
 * sha256 of exactly these bytes, with no normalization.
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex digest
 */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * sha256 of the content: text files are CRLF-normalized first, binary files are hashed raw.
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex digest
 */
export function hashContent(bytes) {
  return hashBytes(isText(bytes) ? normalizeLineEndings(bytes) : bytes);
}

/**
 * @param {string} path absolute file path
 * @returns {Promise<string>} lowercase hex digest
 */
export async function hashFile(path) {
  return hashContent(await readFile(path));
}
