/**
 * The plan of an import: one entry per source file, each with exactly one outcome. An adapter says
 * what each file is; this module adds what every adapter must guarantee the same way: hashes, secret
 * quarantine, deterministic names, link rewriting. Execution consumes only the result (ADR 0011).
 *
 * Entry shape (the manifest stores it as is, minus `mtime`):
 *
 *     source        path in the source vault, forward slashes
 *     outcome       mapped | preserved | excluded | quarantined
 *     destination   path in the Instance, or null for an excluded file
 *     reason        stable code: why excluded, quarantined or kept verbatim; null for mapped
 *     kind          note | raw-source | sidecar | file | log
 *     transforms    what changes the bytes, in the order applied: links, frontmatter, log-chain, log-chain-preamble, sidecar-map (empty: verbatim)
 *     type          note: the note type written (kind note only)
 *     sidecar_for   sidecar: source path of its raw source (kind sidecar only)
 *     sidecar_seed  raw-source whose framework recorded no sidecar: the facts the new sidecar starts from
 *                   (a plain JSON object, read like an old sidecar); execution writes the sidecar beside the copy
 *     size, mtime, sha256, byte_sha256   facts of every file that is not excluded: size, modification
 *                   time, the Instance's hash (CRLF-normalized for text) and the sha256 of the raw bytes
 *     secrets       quarantined: line and pattern name of each match in the content, or the pattern name
 *                   and `field: 'name'` for a match in the file name; never the value
 *     legacy_keys, defaults   what the frontmatter or sidecar mapping will keep or fill
 *     links_rewritten         how many links the note needs rewritten
 *     target_sha256  set by execution: sha256 of the written file whose bytes the engine produced
 *
 * Two kinds of entry are added by this module, not by an adapter: `excluded` with reason
 * `link-not-followed` for a symbolic link or junction of the source, and, for each old log that is
 * chained, a second entry `preserved` with reason `original-log-archive` that keeps the original
 * file byte for byte under the imported area. The archive shares its source path with the chained
 * log, so a plan holds one entry per source file plus one per archived log, and `counts.total` counts entries.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { QUARANTINE_DIR } from '../capture.js';
import { byCodeUnit } from '../files.js';
import { hashBytes, hashContent } from '../hashing.js';
import { makeResolver } from '../links.js';
import { LOG_DIR } from '../log.js';
import { TEMPLATE_DIR } from '../paths.js';
import { readSafeText } from '../safe-read.js';
import { loadSchema } from '../schema.js';
import { displayPath, safePath, secretNamePatterns } from '../secret-names.js';
import { scanBytes } from '../secrets.js';
import { SIDECAR_SUFFIX } from '../sidecar.js';
import { ZONES } from '../zones.js';
import { excluded, importedPath, preserved } from './adapter-kit.js';
import { mapFrontmatter } from './frontmatter-map.js';
import { rewriteLinks } from './rewrite-links.js';
import { asObject, mapSidecar } from './sidecar-map.js';

/**
 * @typedef {'mapped' | 'preserved' | 'excluded' | 'quarantined'} Outcome
 *
 * @typedef {object} PlanEntry
 * @property {string} source
 * @property {Outcome} outcome
 * @property {string | null} destination
 * @property {string | null} reason
 * @property {'note' | 'raw-source' | 'sidecar' | 'file' | 'log'} kind
 * @property {string[]} transforms
 * @property {string} [type]
 * @property {string} [sidecar_for]
 * @property {Record<string, unknown>} [sidecar_seed]
 * @property {number} [size]
 * @property {string} [mtime]
 * @property {string} [sha256]
 * @property {string} [byte_sha256]
 * @property {{ line?: number, pattern: string, field?: string }[]} [secrets]
 * @property {string[]} [legacy_keys]
 * @property {string[]} [defaults]
 * @property {number} [links_rewritten]
 * @property {string} [target_sha256] sha256 of the written file, set by execution for a file whose bytes changed
 *
 * @typedef {object} Collision
 * @property {string} source
 * @property {string} wanted
 * @property {string} destination
 *
 * @typedef {object} Plan
 * @property {string} adapter
 * @property {PlanEntry[]} entries sorted by source path
 * @property {Counts} counts
 * @property {Record<string, number>} excluded_reasons
 * @property {Collision[]} collisions
 * @property {import('./rewrite-links.js').UnresolvedLink[]} unresolved_links
 *
 * @typedef {{ total: number, mapped: number, preserved: number, excluded: number, quarantined: number }} Counts
 */

const OUTCOMES = ['mapped', 'preserved', 'excluded', 'quarantined'];
const KINDS = ['note', 'raw-source', 'sidecar', 'file', 'log'];
/** Zones an import writes into; the System zone belongs to the framework. */
const WRITABLE_ZONES = [ZONES.sources, ZONES.human, ZONES.proposals, ZONES.compiled, ZONES.ops];

/** Reason of the extra entry that keeps an old log's original bytes beside its chained copy. */
export const ARCHIVE_REASON = 'original-log-archive';

/** Reason of the entry for a symbolic link or junction of the source, which is never followed. */
export const LINK_REASON = 'link-not-followed';

/** @param {PlanEntry} entry @returns {boolean} true for an old log that is carried into the chained log */
const isChainedLog = (entry) => entry.outcome === 'mapped' && entry.transforms.some((t) => t.startsWith('log-chain'));

/** @param {PlanEntry} entry @returns {boolean} */
const isArchive = (entry) => entry.reason === ARCHIVE_REASON;

/**
 * The order of a plan: by source path, an archive after the chained log it copies.
 * @param {PlanEntry} a
 * @param {PlanEntry} b
 * @returns {number}
 */
export const byPlanOrder = (a, b) => byCodeUnit(a.source, b.source) || Number(isArchive(a)) - Number(isArchive(b));

/**
 * How two destinations are compared: Unicode-normalized (NFC) and case-folded, so that names that
 * differ only by composition (NFC and NFD) or case collide on every platform, not only on the one that folds them.
 * @param {string} name
 * @returns {string}
 */
export const foldName = (name) => name.normalize('NFC').toLowerCase();

/**
 * @param {PlanEntry[]} entries
 * @returns {Counts}
 */
export function countOutcomes(entries) {
  const counts = { total: entries.length, mapped: 0, preserved: 0, excluded: 0, quarantined: 0 };
  for (const entry of entries) if (OUTCOMES.includes(entry.outcome)) counts[entry.outcome]++;
  return counts;
}

/**
 * @param {PlanEntry[]} entries
 * @returns {Record<string, number>} excluded files per reason code
 */
export function excludedReasons(entries) {
  /** @type {Record<string, number>} */
  const reasons = {};
  for (const entry of entries) if (entry.outcome === 'excluded') reasons[entry.reason ?? 'unspecified'] = (reasons[entry.reason ?? 'unspecified'] ?? 0) + 1;
  return reasons;
}

/**
 * @param {string} destination
 * @returns {boolean} true for a path inside a writable zone that cannot leave it
 */
export function isSafeDestination(destination) {
  if (typeof destination !== 'string' || destination.includes('\\') || destination.includes(':') || destination.startsWith('/')) return false;
  const segments = destination.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return WRITABLE_ZONES.includes(segments[0]) && segments.length > 1;
}

/**
 * @param {unknown} given what an adapter returned
 * @param {string} adapter adapter id, for messages
 * @param {Set<string>} files every source file
 * @returns {PlanEntry}
 */
function normalize(given, adapter, files) {
  const entry = /** @type {PlanEntry} */ ({ ...(/** @type {object} */ (given)) });
  const bad = (/** @type {string} */ why) => new Error(`adapter ${adapter} returned a bad plan entry for ${entry.source}: ${why}`);
  if (typeof entry.source !== 'string' || !files.has(entry.source)) throw bad('the source path is not a file of the source vault');
  if (!OUTCOMES.includes(entry.outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
  if (!KINDS.includes(entry.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  if (entry.outcome === 'excluded') {
    if (typeof entry.reason !== 'string' || entry.reason === '') throw bad('an excluded file needs a reason');
    return { source: entry.source, outcome: 'excluded', destination: null, reason: entry.reason, kind: 'file', transforms: [] };
  }
  if (!isSafeDestination(/** @type {string} */ (entry.destination))) throw bad(`unsafe destination ${JSON.stringify(entry.destination)}`);
  entry.transforms = Array.isArray(entry.transforms) ? [...entry.transforms] : [];
  entry.reason ??= null;
  return entry;
}

/**
 * @param {string} name
 * @param {Set<string>} taken destinations in use, each through `foldName`
 * @returns {string} `name`, or `stem-2.ext`, `stem-3.ext`, ... the first one not in use
 */
function uniqueName(name, taken) {
  if (!taken.has(foldName(name))) return name;
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  const split = dot > slash + 1 ? dot : name.length;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, split)}-${n}${name.slice(split)}`;
    if (!taken.has(foldName(candidate))) return candidate;
  }
}

/** @param {string} path @returns {boolean} true unless a folder on the path starts with a dot (Obsidian does not index those) */
const indexed = (path) => !path.split('/').slice(0, -1).some((s) => s.startsWith('.'));

/**
 * What link rewriting needs: where every moved file goes, and how links resolve in the source and in the Instance.
 * @param {PlanEntry[]} entries a plan's entries, destinations settled
 * @param {string[]} reserved paths the new Instance holds before the import
 */
export function linkContext(entries, reserved) {
  /** @type {Map<string, string>} */
  const pathMap = new Map();
  // An archive copy shares its source path with the chained log: only the chained log is a move.
  for (const entry of entries) if (entry.destination !== null && !isArchive(entry)) pathMap.set(entry.source, entry.destination);
  return {
    pathMap,
    source: makeResolver([...new Set(entries.map((e) => e.source))].filter(indexed)),
    target: makeResolver([...pathMap.values(), ...reserved].filter(indexed)),
  };
}

/**
 * Build the plan.
 * @param {object} input
 * @param {string} input.root absolute source path
 * @param {import('./detect.js').Adapter} input.adapter
 * @param {string[]} input.files every source file (links are not files)
 * @param {string[]} [input.links] every symbolic link and junction of the source: none is followed
 * @param {string[]} input.reserved paths the new Instance already holds (the template, the manifest)
 * @returns {Promise<Plan>}
 */
export async function buildPlan({ root, adapter, files, links = [], reserved }) {
  const present = new Set(files);
  /** @type {Map<string, PlanEntry>} */
  const bySource = new Map();
  for (const given of await adapter.plan(root, { files })) {
    const entry = normalize(given, adapter.id, present);
    if (bySource.has(entry.source)) throw new Error(`adapter ${adapter.id} planned ${entry.source} twice`);
    bySource.set(entry.source, entry);
  }
  // A file the adapter did not mention is never dropped: it is kept verbatim.
  for (const file of files) if (!bySource.has(file)) bySource.set(file, preserved(adapter.id, file));
  // A link is never followed and never copied as its target's content; it is listed, not silent.
  for (const link of links) bySource.set(link, excluded(link, LINK_REASON));
  const entries = [...bySource.values()].sort(byPlanOrder);
  const keep = entries.filter((e) => e.outcome !== 'excluded');
  const abs = (/** @type {string} */ source) => join(root, ...source.split('/'));

  // Facts of every file that is read: hashes, and a secret scan of the content and of the name
  // before anything is copied.
  for (const entry of keep) {
    const bytes = await readFile(abs(entry.source));
    entry.size = bytes.length;
    entry.mtime = (await stat(abs(entry.source))).mtime.toISOString();
    entry.byte_sha256 = hashBytes(bytes);
    entry.sha256 = hashContent(bytes);
    const secrets = [
      ...scanBytes(bytes).map(({ line, pattern }) => ({ line, pattern })),
      ...secretNamePatterns(entry.source).map((pattern) => ({ pattern, field: 'name' })),
    ];
    if (secrets.length > 0) entry.secrets = secrets;
  }

  // Secret-like content is quarantined, reported without its value; a raw source and its sidecar go together.
  const bySourcePath = new Map(entries.map((e) => [e.source, e]));
  /** @type {Map<string, PlanEntry>} */
  const sidecarOf = new Map();
  for (const entry of entries) if (entry.kind === 'sidecar' && entry.sidecar_for !== undefined) sidecarOf.set(entry.sidecar_for, entry);
  const quarantine = (/** @type {PlanEntry} */ entry, /** @type {string} */ reason) => {
    entry.outcome = 'quarantined';
    entry.reason = reason;
    entry.destination = `${QUARANTINE_DIR}/${safePath(entry.source)}`;
    entry.kind = 'file';
    entry.transforms = [];
    delete entry.type;
    delete entry.sidecar_for;
    delete entry.sidecar_seed;
  };
  for (const entry of keep.filter((e) => e.secrets !== undefined)) {
    const partner = entry.kind === 'sidecar' ? bySourcePath.get(/** @type {string} */ (entry.sidecar_for)) : sidecarOf.get(entry.source);
    quarantine(entry, 'secret');
    if (partner !== undefined && partner.outcome !== 'quarantined') quarantine(partner, 'secret-companion');
  }

  // An old log is chained into the Instance log; its original bytes are also kept, whole, beside it.
  for (const entry of keep.filter(isChainedLog)) {
    const { size, mtime, sha256, byte_sha256: byteHash } = entry;
    const copy = { ...preserved(adapter.id, entry.source, ARCHIVE_REASON), size, mtime, sha256, byte_sha256: byteHash };
    entries.push(copy);
    keep.push(copy);
  }
  entries.sort(byPlanOrder);
  keep.sort(byPlanOrder);

  // What the frontmatter and sidecar mappings will do, so the dry run shows it. A note whose
  // frontmatter cannot be mapped is kept verbatim instead.
  const { schema } = await loadSchema(TEMPLATE_DIR);
  if (schema === null) throw new Error('the bundled schema is invalid');
  for (const entry of keep) {
    if (entry.outcome === 'quarantined') continue;
    if (entry.kind === 'note' && entry.transforms.includes('frontmatter')) {
      const read = await readSafeText(abs(entry.source));
      try {
        if (read.status !== 'ok') throw new Error('not readable as UTF-8 text');
        const mapped = mapFrontmatter(read.text, { schema, type: /** @type {string} */ (entry.type), modified: /** @type {string} */ (entry.mtime).slice(0, 10), source: entry.source });
        entry.legacy_keys = mapped.legacy;
        entry.defaults = mapped.defaults;
      } catch {
        Object.assign(entry, { outcome: 'preserved', destination: importedPath(adapter.id, entry.source), reason: 'frontmatter-unmappable', kind: 'file', transforms: [] });
        delete entry.type;
      }
    } else if (entry.kind === 'raw-source' && entry.sidecar_seed !== undefined) {
      entry.defaults = mapSidecar(entry.sidecar_seed, { sha256: /** @type {string} */ (entry.sha256), mtime: /** @type {string} */ (entry.mtime), source: entry.source }, adapter.id).defaults;
    } else if (entry.kind === 'sidecar') {
      const raw = /** @type {PlanEntry} */ (bySourcePath.get(/** @type {string} */ (entry.sidecar_for)));
      const old = asObject(JSON.parse(await readFile(abs(entry.source), 'utf8')));
      if (old === null || raw.outcome !== 'mapped') throw new Error(`adapter ${adapter.id}: ${entry.source} is not the sidecar of a mapped raw source`);
      entry.defaults = mapSidecar(old, { sha256: /** @type {string} */ (raw.sha256), mtime: /** @type {string} */ (raw.mtime), source: raw.source }, adapter.id).defaults;
    }
  }

  // Names that would collide get a deterministic suffix, in source-path order; a sidecar follows its raw source.
  const taken = new Set(reserved.map(foldName));
  /** @type {Collision[]} */
  const collisions = [];
  const take = (/** @type {string} */ destination) => {
    if (taken.has(foldName(destination))) throw new Error(`adapter ${adapter.id}: the sidecar destination ${destination} is already taken`);
    taken.add(foldName(destination));
  };
  for (const entry of keep.filter((e) => e.kind !== 'sidecar')) {
    const wanted = /** @type {string} */ (entry.destination);
    entry.destination = uniqueName(wanted, taken);
    taken.add(foldName(entry.destination));
    if (entry.destination !== wanted) collisions.push({ source: entry.source, wanted, destination: entry.destination });
    if (entry.kind === 'raw-source' && entry.sidecar_seed !== undefined) take(`${entry.destination}${SIDECAR_SUFFIX}`);
  }
  for (const entry of keep.filter((e) => e.kind === 'sidecar')) {
    const raw = /** @type {PlanEntry} */ (bySourcePath.get(/** @type {string} */ (entry.sidecar_for)));
    entry.destination = `${raw.destination}${SIDECAR_SUFFIX}`;
    take(entry.destination);
  }

  // Links: rewrite only what a move broke, list what cannot be resolved.
  const { pathMap, source, target } = linkContext(entries, reserved);
  /** @type {import('./rewrite-links.js').UnresolvedLink[]} */
  const unresolved = [];
  for (const entry of keep) {
    // A chained old log keeps its entries as written, and an archive copy keeps its bytes: neither is rewritten.
    const eligible = (entry.outcome === 'mapped' || entry.outcome === 'preserved') && (entry.kind === 'note' || entry.kind === 'file') && !isArchive(entry) && !isChainedLog(entry);
    if (!eligible || !entry.source.toLowerCase().endsWith('.md')) continue;
    const read = await readSafeText(abs(entry.source));
    if (read.status !== 'ok') continue;
    const result = rewriteLinks(read.text, { from: entry.source, destination: /** @type {string} */ (entry.destination), source, target, pathMap });
    unresolved.push(...result.unresolved);
    if (result.changed > 0) {
      entry.transforms.unshift('links');
      entry.links_rewritten = result.changed;
    }
  }

  const ordered = entries.map((e) => finalEntry(e));
  return {
    adapter: adapter.id,
    entries: ordered,
    counts: countOutcomes(ordered),
    excluded_reasons: excludedReasons(ordered),
    collisions,
    unresolved_links: unresolved,
  };
}

/** Monthly log file of the Instance, with its month captured. */
const LOG_MONTH = new RegExp(`^${LOG_DIR}/(\\d{4}-\\d{2})\\.md$`);

/**
 * What `--apply` would refuse about the old logs: the Instance log is append-only, so the import
 * entry (dated `today`) cannot follow a monthly file that is newer than today.
 * @param {Plan} plan
 * @param {string} today `YYYY-MM-DD`
 * @returns {string[]} the months of chained old logs that are later than the month of `today`, oldest first
 */
export function futureLogMonths(plan, today) {
  const months = plan.entries.filter(isChainedLog).map((e) => LOG_MONTH.exec(/** @type {string} */ (e.destination))?.[1]);
  return [...new Set(months)].filter((m) => m !== undefined && m > today.slice(0, 7)).sort();
}

/**
 * The plan as a report or a manifest may show it: a source path whose name matches a secret pattern
 * appears in its redacted form, so the name never leaves the engine. Destinations are already safe.
 * @param {Plan} plan
 * @returns {Plan}
 */
export function publicPlan(plan) {
  return {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, source: displayPath(e.source), ...(e.sidecar_for === undefined ? {} : { sidecar_for: displayPath(e.sidecar_for) }) })),
    collisions: plan.collisions.map((c) => ({ ...c, source: displayPath(c.source) })),
    unresolved_links: plan.unresolved_links.map((l) => ({ ...l, from: displayPath(l.from) })),
  };
}

/**
 * The inverse of `publicPlan`, for a plan read back from a manifest: each redacted source path is
 * replaced by the real path it stands for in the files of the source, found by redacting those again.
 * @param {Plan} plan a plan as `publicPlan` made it
 * @param {string[]} files every file and link of the source, listed now
 * @returns {Plan}
 */
export function restoreSources(plan, files) {
  const real = new Map(files.map((f) => [displayPath(f), f]));
  const back = (/** @type {string} */ path) => real.get(path) ?? path;
  return {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, source: back(e.source), ...(e.sidecar_for === undefined ? {} : { sidecar_for: back(e.sidecar_for) }) })),
    collisions: plan.collisions.map((c) => ({ ...c, source: back(c.source) })),
    unresolved_links: plan.unresolved_links.map((l) => ({ ...l, from: back(l.from) })),
  };
}

/** @param {PlanEntry} e @returns {PlanEntry} the entry with its keys in a fixed order, so the manifest is stable */
function finalEntry(e) {
  const keys = ['source', 'outcome', 'destination', 'reason', 'kind', 'transforms', 'type', 'sidecar_for', 'sidecar_seed', 'size', 'mtime', 'sha256', 'byte_sha256', 'secrets', 'legacy_keys', 'defaults', 'links_rewritten'];
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const key of keys) if (/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (e))[key] !== undefined) out[key] = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (e))[key];
  return /** @type {PlanEntry} */ (out);
}
