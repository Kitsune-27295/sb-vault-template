import { loadLinkGraph } from '../lib/links.js';
import { finding } from '../lib/report.js';

export const id = 'broken-links';

/**
 * No link points at nothing. A `[[wikilink]]` must resolve to a file of the
 * Instance by file name or path; a Markdown link must point at an existing local
 * file or folder. Links in code spans and fenced code, URLs and anchor-only links
 * are ignored, and so are links in raw sources, the System zone and the append-only
 * log. Wikilinks in the frontmatter `sources` field must resolve too (a source id is
 * the file name of a raw source); wikilinks in other frontmatter fields are not resolved.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const graph = await loadLinkGraph(vault);
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  for (const note of graph.notes) {
    const reported = new Set();
    for (const link of note.links) {
      const inSources = link.frontmatter && link.field === 'sources';
      if ((link.frontmatter && !inSources) || !graph.isBroken(link, note.path)) continue;
      const key = `${inSources ? 'source' : link.kind}\0${link.target}`;
      if (reported.has(key)) continue;
      reported.add(key);
      if (inSources) {
        findings.push(
          finding(note.path, 'broken-source-link', 'error', `line ${link.line}: the sources entry [[${link.target}]] does not resolve to any raw source or note in the Instance`),
        );
      } else if (link.kind === 'wikilink') {
        findings.push(finding(note.path, 'broken-wikilink', 'error', `line ${link.line}: [[${link.target}]] does not resolve to any note in the Instance`));
      } else {
        findings.push(finding(note.path, 'broken-markdown-link', 'error', `line ${link.line}: the link target "${link.target}" is not a file in the Instance`));
      }
    }
  }
  return findings;
}
