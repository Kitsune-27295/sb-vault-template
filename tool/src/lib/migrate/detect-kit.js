/**
 * What the adapters share for detection: reading the head of a few Markdown files without loading a
 * whole large vault, and rounding a confidence the same way everywhere.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeNewlines, stripBom } from '../markdown.js';

/** At most this many Markdown files are sampled for frontmatter evidence. */
const SAMPLE_FILES = 300;

/** How many bytes of each sampled file are read: enough for a frontmatter block. */
const HEAD_BYTES = 2048;

/**
 * @param {string} root absolute source path
 * @param {string[]} files every source file
 * @returns {Promise<string[]>} the head of up to SAMPLE_FILES Markdown files (unreadable ones are skipped)
 */
export async function sampleHeads(root, files) {
  const chosen = files.filter((f) => f.toLowerCase().endsWith('.md')).slice(0, SAMPLE_FILES);
  const heads = [];
  for (const file of chosen) {
    let handle;
    try {
      handle = await open(join(root, ...file.split('/')), 'r');
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      // Normalized so a pattern with `^` and `$` works on a BOM or CRLF file: no BOM, LF line ends.
      heads.push(normalizeNewlines(stripBom(buffer.subarray(0, bytesRead).toString('utf8'))));
    } catch {
      // an unreadable file is no evidence
    } finally {
      await handle?.close();
    }
  }
  return heads;
}

/**
 * @param {number} confidence
 * @param {number} [cap] the highest value the adapter documents; default 0.98
 * @returns {number} capped and rounded to two decimals
 */
export const finalConfidence = (confidence, cap = 0.98) => Math.round(Math.min(confidence, cap) * 100) / 100;
