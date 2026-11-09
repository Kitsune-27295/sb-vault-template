/**
 * Links of an imported note after its target moved (ADR 0011). A link is rewritten only when, as
 * written, it no longer reaches the file it reached in the source; everything else in the note stays
 * byte for byte. A link that cannot be resolved is reported, never guessed.
 */
import { posix } from 'node:path';
import { blankCode, scanLine } from '../links.js';
import { splitFrontmatter, stripBom } from '../markdown.js';

const BOM = String.fromCharCode(0xfeff);


/**
 * @typedef {object} UnresolvedLink
 * @property {string} from source path of the note that holds the link
 * @property {number} line 1-based
 * @property {string} target as written
 * @property {'wikilink' | 'markdown'} kind
 * @property {'not-found' | 'ambiguous' | 'target-excluded'} reason
 *
 * @typedef {object} LinkContext
 * @property {string} from source path of the note
 * @property {string} destination where the note will be in the Instance
 * @property {ReturnType<typeof import('../links.js').makeResolver>} source resolver over the source vault
 * @property {ReturnType<typeof import('../links.js').makeResolver>} target resolver over the Instance
 * @property {Map<string, string>} pathMap source path to Instance path, for every file that moves
 */

/** @param {string} path @returns {string} a relative Markdown link target: spaces, parentheses and percent signs escaped */
const encodePath = (path) => path.replace(/[ ()%<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * @param {string} text note content, LF or CRLF, with or without a byte order mark
 * @param {LinkContext} context
 * @returns {{ text: string, changed: number, unresolved: UnresolvedLink[] }}
 */
export function rewriteLinks(text, context) {
  const body = stripBom(text);
  const bom = body !== text;
  const parts = body.split(/(\r?\n)/); // lines at even indexes, their terminators between
  const lines = parts.filter((_, i) => i % 2 === 0);
  const { bodyStart } = splitFrontmatter(parts.join(''));
  const scanned = [...lines.slice(0, bodyStart), ...blankCode(lines.slice(bodyStart))];

  /** @type {UnresolvedLink[]} */
  const unresolved = [];
  let changed = 0;
  lines.forEach((line, index) => {
    /** @type {{ from: number, to: number, text: string }[]} */
    const edits = [];
    for (const span of scanLine(scanned[index], index >= bodyStart)) {
      const link = { kind: span.kind, target: span.target, line: index + 1, frontmatter: index < bodyStart };
      const report = (/** @type {UnresolvedLink['reason']} */ reason) =>
        unresolved.push({ from: context.from, line: index + 1, target: span.target, kind: span.kind, reason });
      const found = context.source.locate(link, context.from);
      if (found.files.length === 0) {
        if (!found.folder) report('not-found');
        continue;
      }
      if (found.files.length > 1) {
        report('ambiguous');
        continue;
      }
      const moved = context.pathMap.get(found.files[0]);
      if (moved === undefined) {
        report('target-excluded');
        continue;
      }
      const now = context.target.locate(link, context.destination).files;
      if (now.length === 1 && now[0] === moved) continue; // still reaches the same file as written

      if (span.kind === 'wikilink') {
        edits.push({ from: span.from, to: span.to, text: moved.replace(/\.md$/i, '') });
        // Keep what the reader sees: a link with no alias gets the old name as its alias (not in a table cell).
        const close = line.indexOf(']]', span.to);
        if (close !== -1 && !line.slice(span.to, close).includes('|') && !/^\s*\|/.test(line)) {
          edits.push({ from: close, to: close, text: `|${span.target}` });
        }
      } else {
        edits.push({ from: span.from, to: span.to, text: encodePath(posix.relative(posix.dirname(context.destination), moved)) });
      }
      changed++;
    }
    let result = line;
    for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
      result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
    }
    parts[index * 2] = result;
  });
  return { text: (bom ? BOM : '') + parts.join(''), changed, unresolved };
}
