import { readFile } from 'node:fs/promises';
import { readFrontmatter } from '../lib/frontmatter.js';
import { fromVaultPath, listVaultFiles } from '../lib/paths.js';
import { finding } from '../lib/report.js';
import { isZoneIndex, ZONES } from '../lib/zones.js';

export const id = 'pending-proposals';

/**
 * Lists the notes waiting in the proposals zone for the curator to promote or
 * discard. Information only: the findings are `info`, so they never fail the
 * check or change the exit code.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  for (const file of await listVaultFiles(vault)) {
    if (!file.startsWith(`${ZONES.proposals}/`) || !file.toLowerCase().endsWith('.md') || isZoneIndex(file)) continue;
    const frontmatter = readFrontmatter(await readFile(fromVaultPath(vault, file), 'utf8'));
    const title = frontmatter.present && 'data' in frontmatter ? frontmatter.data.title : undefined;
    findings.push(
      finding(file, 'pending-proposal', 'info', `proposal awaiting review${typeof title === 'string' && title !== '' ? `: ${title}` : ''}`),
    );
  }
  return findings;
}
