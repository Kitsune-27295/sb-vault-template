/**
 * The pure part of `attach --permissions`: the three Claude Code permission entries of an
 * Instance, how they are merged into (and removed from) the parsed user settings, how the
 * file's indentation and line endings are kept, and the small state record of what was added.
 * Nothing here touches the file system; `attach-permissions-run.js` does the reading and writing.
 */
import { assertSafePath } from './attach-paths.js';
import { UsageError } from './errors.js';

/** The user-level settings file, inside the Claude Code directory. */
export const SETTINGS_FILE = 'settings.json';

/** The state file that records, per Instance, exactly which entries `attach --permissions` added. */
export const STATE_FILE = 'sbk-attach.json';

/** The `permissions` lists this option writes, in the order they are shown. */
export const LISTS = Object.freeze(['additionalDirectories', 'allow', 'deny']);

/** @typedef {{ additionalDirectories: string[], allow: string[], deny: string[] }} Entries */

/** @returns {Entries} */
export const emptyEntries = () => ({ additionalDirectories: [], allow: [], deny: [] });

/** @param {Entries} entries @returns {number} */
export const countEntries = (entries) => LISTS.reduce((n, list) => n + entries[list].length, 0);

/**
 * The `Edit` deny rule for an Instance, in the documented path syntax: `//` starts a path from the
 * filesystem root and a Windows drive `C:/x` is written `/c/x`, so `C:/<home>/vault` becomes
 * `Edit(//c/<home>/vault/**)` and `/<home>/vault` becomes `Edit(//<home>/vault/**)`.
 * @param {string} instancePath absolute path with forward slashes
 * @returns {string}
 */
export function denyRule(instancePath) {
  const path = instancePath.replace(/\/+$/, '');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(path);
  return drive === null ? `Edit(//${path.replace(/^\/+/, '')}/**)` : `Edit(//${drive[1].toLowerCase()}/${drive[2]}/**)`;
}

/**
 * The entries for one Instance. The allow rule is the read-only call the block tells the agent to
 * make, with the same quoted paths: `"<node>" "<cli>" find "<instance>" <terms>`. The paths go
 * through the same validation as the block.
 * @param {{ instancePath: string, node: string, cli: string }} input paths with forward slashes
 * @returns {Entries}
 * @throws {UsageError} when a path cannot sit inside a rule, or is a UNC path a deny rule cannot express
 */
export function entriesFor({ instancePath, node, cli }) {
  if (instancePath.startsWith('//')) {
    throw new UsageError(`${instancePath} is a UNC path; a deny rule cannot express it, so --permissions refuses it (the block itself is allowed); nothing was written`);
  }
  assertSafePath(instancePath, 'Instance path');
  assertSafePath(cli, 'CLI path');
  assertSafePath(node, 'Node executable path');
  return {
    additionalDirectories: [instancePath],
    allow: [`Bash("${node}" "${cli}" find "${instancePath}" *)`],
    deny: [denyRule(instancePath)],
  };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @typedef {object} Style
 * @property {string} indent
 * @property {string} eol
 * @property {boolean} finalNewline
 * @property {boolean} bom
 */

/** @type {Style} */
export const DEFAULT_STYLE = Object.freeze({ indent: '  ', eol: '\n', finalNewline: true, bom: false });

/**
 * The JSON text without insignificant whitespace; strings are re-encoded the one canonical way, so
 * that two spellings of the same string (an escaped and a literal accented letter, `\/` and `/`) compare equal.
 * @param {string} json valid JSON text
 * @returns {string}
 */
function compact(json) {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let end = i + 1;
      while (json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      out += JSON.stringify(JSON.parse(json.slice(i, end + 1)));
      i = end;
    } else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      out += c;
    }
  }
  return out;
}

/**
 * Whether re-serializing the parsed object gives back the file's content. It does not for a duplicate
 * key (one is lost), integer-like keys (JSON puts them first), or a number that does not round-trip
 * (`1.0`, `1E3`, `12345678901234567890`). Whitespace and string escapes are not content.
 * @param {string} json the file's JSON text, without a byte order mark
 * @param {Record<string, any>} data what `JSON.parse` made of it
 * @returns {boolean}
 */
export const isLossless = (json, data) => compact(json) === JSON.stringify(data);

/**
 * Parse a JSON file that must hold an object, and record how it is laid out.
 * @param {string} text
 * @returns {{ data: Record<string, any>, style: Style, lossless: boolean }}
 * @throws {Error} with a message ending the sentence "<file> ..." when it is not valid JSON or not an object
 */
export function parseObject(text) {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`is not valid JSON (${/** @type {Error} */ (error).message})`);
  }
  if (!isObject(data)) throw new Error('does not hold a JSON object at its top level');
  const indent = /^[ \t]+(?=\S)/m.exec(body)?.[0] ?? DEFAULT_STYLE.indent;
  return { data, lossless: isLossless(body, data), style: { indent, eol: body.includes('\r\n') ? '\r\n' : '\n', finalNewline: body.endsWith('\n'), bom } };
}

/**
 * @param {Record<string, any>} data
 * @param {Style} style
 * @returns {string} the JSON text in the given layout
 */
export function serialize(data, style) {
  const text = JSON.stringify(data, null, style.indent).replace(/\n/g, style.eol);
  return (style.bom ? '\uFEFF' : '') + text + (style.finalNewline ? style.eol : '');
}

/**
 * @param {Record<string, any>} data parsed settings
 * @param {string} label shown in messages
 * @returns {Record<string, any> | undefined} the `permissions` object
 * @throws {UsageError} when `permissions` or one of the three lists has the wrong type
 */
function permissionsOf(data, label) {
  const permissions = data.permissions;
  if (permissions === undefined) return undefined;
  if (!isObject(permissions)) throw new UsageError(`refusing ${label}: "permissions" is not an object; nothing was written`);
  for (const list of LISTS) {
    if (permissions[list] !== undefined && !Array.isArray(permissions[list])) {
      throw new UsageError(`refusing ${label}: "permissions.${list}" is not an array; nothing was written`);
    }
  }
  return permissions;
}

/**
 * Append the entries that are absent, creating the object and arrays when needed. Existing entries
 * keep their order and every other key is untouched. `data` is changed in place.
 * @param {Record<string, any>} data parsed settings
 * @param {Entries} entries
 * @param {string} label shown in messages
 * @returns {Entries} the entries that were absent and are now added
 */
export function mergeEntries(data, entries, label) {
  permissionsOf(data, label);
  const added = emptyEntries();
  for (const list of LISTS) {
    for (const entry of entries[list]) {
      if (data.permissions?.[list]?.includes(entry)) continue;
      data.permissions ??= {};
      data.permissions[list] ??= [];
      data.permissions[list].push(entry);
      added[list].push(entry);
    }
  }
  return added;
}

/**
 * Remove exactly the given entries; a list or the `permissions` object that this empties is
 * dropped, anything else is left alone. `data` is changed in place.
 * @param {Record<string, any>} data parsed settings
 * @param {Entries} recorded
 * @param {string} label shown in messages
 * @returns {Entries} the entries that were present and are now removed
 */
export function removeEntries(data, recorded, label) {
  const permissions = permissionsOf(data, label);
  const removed = emptyEntries();
  if (permissions === undefined) return removed;
  for (const list of LISTS) {
    const current = permissions[list];
    if (current === undefined) continue;
    const gone = new Set(recorded[list]);
    removed[list] = recorded[list].filter((entry) => current.includes(entry));
    if (removed[list].length === 0) continue;
    permissions[list] = current.filter((entry) => !gone.has(entry));
    if (permissions[list].length === 0) delete permissions[list];
  }
  if (countEntries(removed) > 0 && Object.keys(permissions).length === 0) delete data.permissions;
  return removed;
}

/**
 * The entries recorded for an Instance, as the state file holds them.
 * @param {Record<string, any>} state parsed state file
 * @param {string} key Instance key
 * @returns {Entries}
 */
export function recordedFor(state, key) {
  const record = Object.hasOwn(state.instances ?? {}, key) ? state.instances[key]?.permissions : undefined;
  const entries = emptyEntries();
  if (!isObject(record)) return entries;
  for (const list of LISTS) entries[list] = Array.isArray(record[list]) ? record[list].filter((e) => typeof e === 'string') : [];
  return entries;
}

/**
 * The state after the Instance's record becomes `entries`; an empty record removes it, and then
 * the Instance entry itself when nothing else is kept there. Other Instances and keys are kept.
 * @param {Record<string, any>} state parsed state file, or `{}` when there is none
 * @param {string} key Instance key
 * @param {Entries} entries
 * @returns {Record<string, any>} a new state object
 */
export function withRecord(state, key, entries) {
  const instances = { ...(isObject(state.instances) ? state.instances : {}) };
  const { permissions: _old, ...others } = isObject(instances[key]) ? instances[key] : {};
  const permissions = Object.fromEntries(LISTS.filter((list) => entries[list].length > 0).map((list) => [list, entries[list]]));
  const record = Object.keys(permissions).length > 0 ? { ...others, permissions } : others;
  if (Object.keys(record).length > 0) instances[key] = record;
  else delete instances[key];
  return { version: 1, ...state, instances };
}

/** @param {Record<string, any>} state @returns {boolean} true when the state holds nothing but the empty frame */
export const isEmptyState = (state) => Object.keys(state.instances ?? {}).length === 0 && Object.keys(state).every((k) => k === 'version' || k === 'instances');

/**
 * @param {Entries} a
 * @param {Entries} b
 * @returns {{ both: Entries, onlyA: Entries }} the entries of `a` that `b` also has, and those it lacks
 */
export function splitByPresence(a, b) {
  const both = emptyEntries();
  const onlyA = emptyEntries();
  for (const list of LISTS) {
    for (const entry of a[list]) (b[list].includes(entry) ? both : onlyA)[list].push(entry);
  }
  return { both, onlyA };
}

/**
 * @param {Entries} a
 * @param {Entries} b
 * @returns {Entries} the entries of `a` followed by those of `b` that `a` lacks
 */
export function unionEntries(a, b) {
  const out = emptyEntries();
  for (const list of LISTS) out[list] = [...a[list], ...b[list].filter((entry) => !a[list].includes(entry))];
  return out;
}
