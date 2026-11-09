import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOT_LINE_BUDGET } from '../lib/derived.js';
import { finding } from '../lib/report.js';
import { HOT_PATH } from '../lib/zones.js';

export const id = 'memory-budget';

/**
 * The operational memory note is read at the start of every session, so it has
 * a line budget. Exceeding it is a warning, not an error.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  let text;
  try {
    text = await readFile(join(vault, ...HOT_PATH.split('/')), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length <= HOT_LINE_BUDGET) return [];
  return [
    finding(HOT_PATH, 'memory-budget-exceeded', 'warning', `has ${lines.length} lines, over the budget of ${HOT_LINE_BUDGET}; move detail to a linked note`),
  ];
}
