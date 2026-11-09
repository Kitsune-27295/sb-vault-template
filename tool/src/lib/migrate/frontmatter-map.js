/**
 * Frontmatter of an imported note, mapped onto the Instance schema without losing a key or a value
 * (ADR 0011). A key the schema does not know becomes `legacy_<key>`, and so does a value the schema
 * rejects; both keep the original text because the original YAML node is moved, not re-typed. A
 * required field the note lacks is filled with a documented default and named in `imported_defaults`.
 */
import { Document, YAMLMap, isMap, parseDocument } from 'yaml';
import { normalizeNewlines, splitFrontmatter, stripBom } from '../markdown.js';
import { validateNote } from '../schema.js';

/** Keys Obsidian itself reads: kept as they are, not renamed. */
const OBSIDIAN_KEYS = new Set(['tags', 'aliases', 'cssclasses']);

/** Prefix of a key that did not fit the schema. */
export const LEGACY_PREFIX = 'legacy_';

/**
 * Status words other frameworks use, each with one clear meaning in the Instance's `status` values.
 * A word that is not listed is not guessed: the schema field takes the default and the original stays.
 */
const STATUS_WORDS = new Map([
  ...['wip', 'in-progress', 'todo', 'proposed', 'idea'].map((w) => [w, 'draft']),
  ...['accepted', 'current', 'done', 'approved', 'published', 'open', 'live'].map((w) => [w, 'active']),
  ...['replaced'].map((w) => [w, 'superseded']),
  ...['closed', 'deprecated', 'obsolete', 'rejected', 'cancelled'].map((w) => [w, 'archived']),
]);

/** @param {unknown} value @returns {boolean} true for a non-empty ISO date string */
const isDateText = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/**
 * @typedef {object} MappedNote
 * @property {string} text the note: LF line endings, no byte order mark
 * @property {string[]} legacy names of the `legacy_` keys written
 * @property {string[]} defaults required fields filled with a default
 */

/**
 * @param {string} text the note as read (LF or CRLF, with or without a byte order mark)
 * @param {object} input
 * @param {import('../schema.js').Schema} input.schema the Instance schema
 * @param {string} input.type the note type to write
 * @param {string} input.modified `YYYY-MM-DD` the source file was last changed, the default for `created`
 * @param {string} input.source source path, recorded as `imported_from` and used as the title when nothing better exists
 * @returns {MappedNote}
 * @throws {Error} when the frontmatter is not valid YAML or a required field has no default
 */
export function mapFrontmatter(text, { schema, type, modified, source }) {
  if (!Object.hasOwn(schema.types, type)) throw new Error(`the schema has no note type "${type}"`);
  const split = splitFrontmatter(normalizeNewlines(stripBom(text)));
  const hasBlock = split.present && split.end !== -1;
  const body = split.lines.slice(hasBlock ? split.bodyStart : 0).join('\n');
  const input = hasBlock ? parseDocument(split.lines.slice(1, split.end).join('\n')) : new Document({});
  if (input.errors.length > 0) throw new Error(`the frontmatter of ${source} is not valid YAML`);
  const items = isMap(input.contents) ? input.contents.items : [];
  const data = /** @type {Record<string, unknown>} */ (input.toJS() ?? {});
  const nodeOf = (/** @type {string} */ key) => items.find((p) => String(/** @type {any} */ (p.key)?.value ?? p.key) === key)?.value;

  /** @type {Record<string, unknown>} values the schema fields take */
  const fields = {};
  for (const [key, value] of Object.entries(data)) if (Object.hasOwn(schema.fields, key)) fields[key] = value;
  fields.type = type;
  /** @type {Set<string>} */
  const legacyOf = new Set(); // schema fields whose original value moves to a legacy key
  if (data.type !== undefined && data.type !== type) legacyOf.add('type');
  /** @type {string[]} */
  const defaults = [];

  const heading = body.split('\n').find((line) => /^# +\S/.test(line))?.replace(/^# +/, '').trim();
  const stem = (source.split('/').pop() ?? source).replace(/\.[^.]*$/, '');
  /** @type {Record<string, () => unknown>} */
  const defaultOf = {
    title: () => heading ?? stem,
    created: () => modified,
    updated: () => (isDateText(fields.created) ? fields.created : modified),
    status: () => 'active',
    // A procedure nobody scheduled: due on the last date it was known to be current, so it shows up for review.
    review_by: () => (isDateText(fields.updated) ? fields.updated : isDateText(fields.created) ? fields.created : modified),
  };

  for (let round = 0; round < 4; round++) {
    const problems = validateNote(schema, fields);
    if (problems.length === 0) break;
    for (const problem of problems) {
      const name = problem.message.split(':')[0];
      if (problem.rule === 'invalid-value') {
        legacyOf.add(name);
        const word = typeof fields[name] === 'string' ? STATUS_WORDS.get(fields[name].trim().toLowerCase()) : undefined;
        if (name === 'status' && word !== undefined) {
          fields.status = word;
          continue;
        }
        delete fields[name];
      }
      if (!Object.hasOwn(defaultOf, name)) {
        if (problem.rule === 'invalid-value') continue; // an optional field: only its legacy copy remains
        throw new Error(`${source} cannot be mapped: required field "${name}" is missing and has no default`);
      }
      fields[name] = defaultOf[name]();
      defaults.push(name);
    }
  }

  const out = new Document({});
  const outMap = /** @type {YAMLMap} */ (out.contents);
  const names = new Set([...Object.keys(data), 'imported_from', 'imported_defaults']);
  /** @type {string[]} */
  const legacy = [];
  const add = (/** @type {string} */ key, /** @type {unknown} */ value) => outMap.items.push(out.createPair(key, value));
  const legacyName = (/** @type {string} */ key) => {
    let name = `${LEGACY_PREFIX}${key}`;
    for (let n = 2; names.has(name); n++) name = `${LEGACY_PREFIX}${key}_${n}`;
    names.add(name);
    legacy.push(name);
    return name;
  };

  const first = ['type', 'title', 'created', 'updated', 'status'];
  const schemaKeys = Object.keys(data).filter((k) => Object.hasOwn(schema.fields, k));
  const filledIn = defaults.filter((k) => !first.includes(k) && !schemaKeys.includes(k)); // a default for a field the note did not have
  for (const key of [...first, ...schemaKeys.filter((k) => !first.includes(k)), ...new Set(filledIn)]) {
    if (fields[key] === undefined) continue;
    // The original node keeps its own formatting when the value was not changed.
    add(key, !legacyOf.has(key) && key !== 'type' && data[key] === fields[key] ? (nodeOf(key) ?? fields[key]) : fields[key]);
  }
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(schema.fields, key)) {
      if (legacyOf.has(key)) add(legacyName(key), nodeOf(key));
    } else if (OBSIDIAN_KEYS.has(key) || key.startsWith(LEGACY_PREFIX)) {
      add(key, nodeOf(key));
    } else {
      add(legacyName(key), nodeOf(key));
    }
  }
  add('imported_from', source);
  if (defaults.length > 0) add('imported_defaults', [...new Set(defaults)]);

  const lead = hasBlock ? '' : '\n';
  return { text: `---\n${out.toString({ lineWidth: 0 })}---\n${lead}${body}`, legacy, defaults: [...new Set(defaults)] };
}
