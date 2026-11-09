import { readFile } from 'node:fs/promises';
import { isImported, readFrontmatter } from '../lib/frontmatter.js';
import { isIsoDate } from '../lib/dates.js';
import { fromVaultPath, listVaultFiles } from '../lib/paths.js';
import { finding, importedSummary } from '../lib/report.js';
import { isHeldBack, ZONES } from '../lib/zones.js';

export const id = 'review-overdue';

/** Zones that hold typed notes, the same ones the frontmatter check reads. */
const NOTE_ZONES = [ZONES.proposals, ZONES.compiled, ZONES.ops];

/**
 * A `procedure` is due for review on its `review_by` date; the day after, it is
 * overdue. `today` is the local date unless `--today` overrides it. A missing or
 * malformed `review_by` is the frontmatter check's business, not this one's.
 * @param {{ vault: string, today: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault, today }) {
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const imported = [];
  for (const file of await listVaultFiles(vault)) {
    if (!file.toLowerCase().endsWith('.md') || !NOTE_ZONES.some((zone) => file.startsWith(`${zone}/`)) || isHeldBack(file)) continue;
    const frontmatter = readFrontmatter(await readFile(fromVaultPath(vault, file), 'utf8'));
    if (!frontmatter.present || 'error' in frontmatter) continue;
    const { type, review_by: reviewBy } = frontmatter.data;
    if (type !== 'procedure') continue;
    const date = reviewBy instanceof Date ? reviewBy.toISOString().slice(0, 10) : reviewBy;
    if (typeof date !== 'string' || !isIsoDate(date) || date >= today) continue;
    if (isImported(frontmatter.data)) {
      imported.push(file); // many imported procedures must not drown real findings; summarized below
      continue;
    }
    findings.push(
      finding(file, 'review-overdue', 'warning', `review_by ${date} is before ${today}; review this procedure and move the date`),
    );
  }
  if (imported.length > 0) {
    findings.push(importedSummary(imported, 'review-overdue-imported', 'warning', `are past their review_by date; review these procedures and move the dates`));
  }
  return findings;
}
