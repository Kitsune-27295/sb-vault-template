import { loadLinkGraph } from '../lib/links.js';
import { finding } from '../lib/report.js';
import { isZoneIndex, ZONES } from '../lib/zones.js';

export const id = 'orphan-notes';

/**
 * Every note in the compiled zone has at least one inbound link from another
 * note in the human, proposals, compiled or operations zones. Wikilinks in the
 * frontmatter count (an Obsidian property link is a backlink); a link from a
 * note to itself does not. An orphan is a warning: it is dead weight, not corruption.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const graph = await loadLinkGraph(vault);
  const linked = new Set();
  for (const note of graph.notes) {
    if (isZoneIndex(note.path)) continue; // a generated index links every page; it is not a curator's link
    for (const link of note.links) {
      for (const target of graph.resolve(link, note.path)) {
        if (target !== note.path) linked.add(target);
      }
    }
  }
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  for (const file of graph.files) {
    if (!file.startsWith(`${ZONES.compiled}/`) || !file.toLowerCase().endsWith('.md')) continue;
    if (linked.has(file) || isZoneIndex(file)) continue;
    findings.push(finding(file, 'orphan-note', 'warning', 'no other note links to this note'));
  }
  return findings;
}
