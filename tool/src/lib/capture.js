/**
 * Capture: seal a local file into the raw sources zone.
 *
 * A clean file is copied to `10-sources/<source-id><ext>`, gets a
 * `<file>.meta.json` sidecar and a pointer note `50-ops/inbox/<source-id>.md`.
 * A file that matches a secret pattern is copied to
 * `50-ops/quarantine/<source-id><ext>` (with a sidecar) instead: nothing enters
 * `10-sources/` and no inbox note is written. Either way one log entry is
 * appended through `appendEntry`.
 *
 * The scan runs on the bytes before anything is written, so material that
 * matches never touches the immutable zone, not even briefly. Nothing here
 * deletes or overwrites a file: writes use the exclusive flag, and a capture
 * whose target already exists is reported as a duplicate. The secret value is
 * never read out of the scan: the log, the inbox note and every message name
 * pattern and line only.
 *
 * A correction is a capture with `supersedes`: the new file becomes a new raw
 * source whose sidecar records `supersedes: <old id>`, the old sidecar gains
 * `superseded_by: <new id>` (the old raw file is never touched) and the log
 * entry is `supersede`. The old source is checked before anything is written;
 * a correction that gets quarantined leaves the old version as it was.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { UsageError } from './errors.js';
import { exists, listFiles } from './files.js';
import { hashContent } from './hashing.js';
import { appendEntry, readLog, verifyLog } from './log.js';
import { sidecarPathFor } from './sidecar.js';
import { loadRawSources, markSuperseded } from './sources.js';
import { scanBytes, scanText } from './secrets.js';
import { QUARANTINE_DIR, ZONES } from './zones.js';

/** Inbox folder, relative to the vault root, with forward slashes. */
export const INBOX_DIR = `${ZONES.ops}/inbox`;

/** Drop folder where tools such as Obsidian Web Clipper leave unsealed files. */
export const DROP_DIR = `${INBOX_DIR}/_drop`;

export { QUARANTINE_DIR };

/**
 * @typedef {object} CaptureResult
 * @property {'captured' | 'quarantined' | 'duplicate'} status
 * @property {string} sourceId
 * @property {string} originalName
 * @property {string} path vault-relative path of the stored file (the existing one for a duplicate)
 * @property {import('./secrets.js').SecretFinding[]} findings secret findings; empty unless quarantined
 * @property {string} [supersedes] id of the source this capture corrects, when it was a correction
 */

/** Stored in place of a file name or origin that matched a secret pattern. */
const WITHHELD_NAME = 'withheld (the file name matched a secret pattern)';
const WITHHELD_ORIGIN = 'withheld (the origin matched a secret pattern)';

/**
 * Fail before anything is written when the log cannot take an entry.
 * @param {string} vault absolute vault path
 * @returns {Promise<void>}
 * @throws {UsageError}
 */
export async function assertLogWritable(vault) {
  if (verifyLog(await readLog(vault)).some((p) => p.severity === 'error')) {
    throw new UsageError('the log fails verification, nothing was captured; run doctor and restore it first');
  }
}

/**
 * Find the source a correction replaces and refuse one that cannot be replaced.
 * @param {string} vault absolute vault path
 * @param {string} id source id
 * @returns {Promise<import('./sources.js').RawSourceEntry>}
 * @throws {UsageError} when the source does not exist, has no valid sidecar or is already superseded
 */
async function resolveSupersededSource(vault, id) {
  const sources = await loadRawSources(vault);
  const old = sources.find((s) => s.id === id);
  if (!old) throw new UsageError(`cannot supersede ${id}: no such raw source in ${ZONES.sources}/; nothing was written`);
  if (old.sidecar === null) {
    throw new UsageError(`cannot supersede ${id}: its sidecar is missing or invalid; run doctor; nothing was written`);
  }
  const next = old.sidecar.superseded_by ?? sources.find((s) => s.sidecar?.supersedes === id)?.id;
  if (next !== undefined) throw new UsageError(`cannot supersede ${id}: it is already superseded by ${next}; nothing was written`);
  return old;
}

/**
 * @param {string} name
 * @returns {string} lowercase slug of at most 40 characters
 */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'source' : slug;
}

/**
 * @param {string} name
 * @returns {string} lowercase extension with its dot, restricted to a safe character set
 */
function safeExtension(name) {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/**
 * @param {string} path
 * @param {string | Uint8Array} data
 * @returns {Promise<void>} writes a new file; throws if it already exists
 */
const writeNew = (path, data) => writeFile(path, data, { flag: 'wx' });

/**
 * Capture one file's content.
 * @param {object} input
 * @param {string} input.vault absolute vault path
 * @param {Uint8Array} input.bytes file content
 * @param {string} input.originalName file name at capture time
 * @param {string} input.origin where the content came from
 * @param {boolean} [input.originGiven] true when the curator wrote the origin; false for the default (a path)
 * @param {string} [input.supersedes] id of the raw source this content corrects
 * @param {Date} [input.now]
 * @returns {Promise<CaptureResult>}
 * @throws {UsageError} when an origin the curator wrote matches a secret pattern, or the source to supersede is missing or already superseded
 */
export async function captureBytes({ vault, bytes, originalName, origin, originGiven = true, supersedes, now = new Date() }) {
  const old = supersedes === undefined ? undefined : await resolveSupersededSource(vault, supersedes);
  const originFindings = scanText(origin);
  if (originGiven && originFindings.length > 0) {
    const names = [...new Set(originFindings.map((f) => f.pattern))].join(', ');
    throw new UsageError(`the origin text matches secret pattern(s) ${names}; nothing was written`);
  }
  const sha256 = hashContent(bytes);
  const capturedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const date = capturedAt.slice(0, 10);

  // Everything that lands in a file name, a sidecar or the log is scanned, not only the content. A
  // value that matches quarantines the file and is replaced by a placeholder, never stored.
  /** @type {import('./secrets.js').SecretFinding[]} */
  const metadataFindings = [];
  const readable = slugify(basename(originalName, extname(originalName)));
  const nameMatches = [...scanText(originalName), ...scanText(`${date}-${readable}-${sha256.slice(0, 8)}`)];
  const patterns = (/** @type {import('./secrets.js').SecretFinding[]} */ found) => [...new Set(found.map((f) => f.pattern))];
  metadataFindings.push(...patterns(nameMatches).map((pattern) => ({ line: 1, pattern, field: 'file name' })));
  metadataFindings.push(...patterns(originFindings).map((pattern) => ({ line: 1, pattern, field: 'origin' })));
  const storedName = nameMatches.length > 0 ? WITHHELD_NAME : originalName;
  const storedOrigin = originFindings.length > 0 ? WITHHELD_ORIGIN : origin;
  const slug = nameMatches.length > 0 ? 'source' : readable;
  const sourceId = `${date}-${slug}-${sha256.slice(0, 8)}`;
  const fileName = `${sourceId}${safeExtension(originalName)}`;

  const findings = [...metadataFindings, ...scanBytes(bytes)];
  const quarantined = findings.length > 0;
  const dir = quarantined ? QUARANTINE_DIR : ZONES.sources;
  const relPath = `${dir}/${fileName}`;
  const target = join(vault, ...relPath.split('/'));
  const notePath = join(vault, ...`${INBOX_DIR}/${sourceId}.md`.split('/'));

  if ((await exists(target)) || (await exists(sidecarPathFor(target))) || (!quarantined && (await exists(notePath)))) {
    return { status: 'duplicate', sourceId, originalName: storedName, path: relPath, findings: [] };
  }

  await mkdir(join(vault, ...dir.split('/')), { recursive: true });
  await writeNew(target, bytes);
  await writeNew(
    sidecarPathFor(target),
    JSON.stringify(
      { sha256, captured_at: capturedAt, origin: storedOrigin, original_name: storedName, ...(supersedes === undefined ? {} : { supersedes }) },
      null,
      2,
    ) + '\n',
  );

  if (quarantined) {
    const lines = [...new Set(findings.map((f) => (f.field === undefined ? `line ${f.line} ${f.pattern}` : `${f.field} ${f.pattern}`)))];
    await appendEntry({
      vault,
      action: 'quarantine',
      title: sourceId,
      body: `Secret pattern matched; moved to ${relPath}. The CLI never deletes quarantined material.${
        supersedes === undefined ? '' : `\nIntended correction of ${supersedes}; that source is unchanged.`
      }\n${lines.map((l) => `- ${l}`).join('\n')}`,
    });
    return { status: 'quarantined', sourceId, originalName: storedName, path: relPath, findings };
  }

  await mkdir(join(vault, ...INBOX_DIR.split('/')), { recursive: true });
  await writeNew(
    notePath,
    [
      '---',
      'type: source',
      `title: Inbox ${sourceId}`,
      `created: ${date}`,
      `updated: ${date}`,
      'status: draft',
      `raw_source: ${relPath}`,
      '---',
      '',
      `# Inbox: ${sourceId}`,
      '',
      `Captured ${capturedAt}. Not yet ingested.`,
      '',
      `Raw source: [[${relPath}]]`,
      ...(old ? ['', `Supersedes: [[${ZONES.sources}/${basename(old.path)}]]`] : []),
      '',
    ].join('\n'),
  );
  if (old && supersedes !== undefined) {
    await markSuperseded(old.sidecarPath, sourceId);
    await appendEntry({
      vault,
      action: 'supersede',
      title: sourceId,
      body: `Raw source ${relPath}\nsha256 ${sha256}\nSupersedes ${supersedes} (${ZONES.sources}/${basename(old.path)}); the old source is unchanged\nInbox note ${INBOX_DIR}/${sourceId}.md`,
    });
    return { status: 'captured', sourceId, originalName: storedName, path: relPath, findings: [], supersedes };
  }
  await appendEntry({
    vault,
    action: 'capture',
    title: sourceId,
    body: `Raw source ${relPath}\nsha256 ${sha256}\nInbox note ${INBOX_DIR}/${sourceId}.md`,
  });
  return { status: 'captured', sourceId, originalName: storedName, path: relPath, findings: [] };
}

/**
 * Capture a file from disk. The original is left in place.
 * @param {object} input
 * @param {string} input.vault absolute vault path
 * @param {string} input.file absolute path of the file
 * @param {string} [input.origin] origin written by the curator
 * @param {string} [input.defaultOrigin] used when `origin` is absent; default: the file's absolute path
 * @param {string} [input.supersedes] id of the raw source this file corrects
 * @returns {Promise<CaptureResult>}
 */
export async function captureFile({ vault, file, origin, defaultOrigin = file, supersedes }) {
  const bytes = await readFile(file);
  return captureBytes({ vault, bytes, originalName: basename(file), origin: origin ?? defaultOrigin, originGiven: origin !== undefined, supersedes });
}

/**
 * Seal every file in the drop folder. A sealed file leaves the drop folder: it
 * now lives in `10-sources/` (clean) or `50-ops/quarantine/` (matched). A
 * duplicate stays where it is.
 * @param {object} input
 * @param {string} input.vault absolute vault path
 * @param {string} [input.origin] default: the file's vault-relative path in the drop folder
 * @returns {Promise<CaptureResult[]>}
 */
export async function captureDropFolder({ vault, origin }) {
  const dropRoot = join(vault, ...DROP_DIR.split('/'));
  /** @type {CaptureResult[]} */
  const results = [];
  for (const relative of await listFiles(dropRoot)) {
    const file = join(dropRoot, ...relative.split('/'));
    const result = await captureFile({ vault, file, origin, defaultOrigin: `${DROP_DIR}/${relative}` });
    // The content is stored and logged; only now is the drop copy removed.
    if (result.status !== 'duplicate') await rm(file);
    results.push(result);
  }
  return results;
}
