import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { TEMPLATE_DIR } from './paths.js';
import { ZONES } from './zones.js';

/** Vault-relative path of the single schema definition. */
export const SCHEMA_PATH = `${ZONES.system}/schema/note-schema.yaml`;

/** Vault-relative folder holding one generated template per note type. */
export const TEMPLATES_DIR = `${ZONES.system}/templates`;

const FIELD_KINDS = ['note-type', 'string', 'date', 'enum', 'string-list'];

/**
 * @typedef {object} FieldDefinition
 * @property {'note-type' | 'string' | 'date' | 'enum' | 'string-list'} kind
 * @property {string[]} [values] allowed values of an `enum`
 * @property {number} [min_items] minimum length of a `string-list`
 * @property {unknown} [template] value a generated template puts in the field
 *
 * @typedef {object} TypeDefinition
 * @property {string} summary
 * @property {string[]} required fields this type requires on top of `common_required`
 *
 * @typedef {object} Schema
 * @property {number} schema_version
 * @property {string[]} common_required
 * @property {Record<string, TypeDefinition>} types
 * @property {Record<string, FieldDefinition>} fields
 */

/**
 * Read the schema of a vault. A vault with a System-zone schema is checked against
 * it; a vault without one is checked against the schema bundled in the framework
 * template, which is the same file `init` copies into a new Instance.
 * @param {string} vault absolute vault path
 * @returns {Promise<{ schema: Schema | null, problems: string[], fromVault: boolean }>}
 */
export async function loadSchema(vault) {
  let text;
  let fromVault = true;
  try {
    text = await readFile(join(vault, SCHEMA_PATH), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    fromVault = false;
    text = await readFile(join(TEMPLATE_DIR, SCHEMA_PATH), 'utf8');
  }
  let raw;
  try {
    raw = parse(text);
  } catch (error) {
    const first = /** @type {Error} */ (error).message.split('\n')[0];
    return { schema: null, problems: [`not valid YAML (${first})`], fromVault };
  }
  const problems = validateDefinition(raw);
  return { schema: problems.length > 0 ? null : /** @type {Schema} */ (raw), problems, fromVault };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string[]} */
function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
}

/**
 * Check a parsed schema for internal consistency.
 * @param {unknown} raw
 * @returns {string[]} problems; empty when the schema is usable
 */
export function validateDefinition(raw) {
  if (!isRecord(raw)) return ['schema must be a YAML mapping'];
  const problems = [];
  if (!Number.isInteger(raw.schema_version)) problems.push('schema_version must be an integer');
  const fields = raw.fields;
  const types = raw.types;
  if (!isRecord(fields) || Object.keys(fields).length === 0) problems.push('fields must be a non-empty mapping');
  if (!isRecord(types) || Object.keys(types).length === 0) problems.push('types must be a non-empty mapping');
  if (!isStringArray(raw.common_required)) problems.push('common_required must be a list of field names');
  if (problems.length > 0) return problems;

  for (const [name, def] of Object.entries(fields)) {
    if (!isRecord(def) || !FIELD_KINDS.includes(def.kind)) {
      problems.push(`field ${name}: kind must be one of ${FIELD_KINDS.join(', ')}`);
    } else if (def.kind === 'enum' && (!isStringArray(def.values) || def.values.length === 0)) {
      problems.push(`field ${name}: an enum needs a non-empty values list`);
    }
  }
  const noteTypeFields = Object.entries(fields).filter(([, d]) => isRecord(d) && d.kind === 'note-type');
  if (noteTypeFields.length !== 1 || noteTypeFields[0][0] !== 'type') {
    problems.push('exactly one field of kind note-type is allowed and it must be named "type"');
  }

  const requiredEverywhere = new Set(raw.common_required);
  for (const name of requiredEverywhere) {
    if (!Object.hasOwn(fields, name)) problems.push(`common_required names unknown field ${name}`);
  }
  if (!requiredEverywhere.has('type')) problems.push('common_required must include type');
  for (const [name, def] of Object.entries(types)) {
    if (!isRecord(def) || !isStringArray(def.required ?? [])) {
      problems.push(`type ${name}: required must be a list of field names`);
      continue;
    }
    for (const field of def.required ?? []) {
      requiredEverywhere.add(field);
      if (!Object.hasOwn(fields, field)) problems.push(`type ${name} requires unknown field ${field}`);
    }
  }
  for (const name of requiredEverywhere) {
    const def = fields[name];
    if (isRecord(def) && def.kind !== 'note-type' && def.template === undefined) {
      problems.push(`field ${name} is required by some type but has no template value`);
    }
  }
  return problems;
}

/** @param {unknown} value */
function isEmpty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** @param {string} text YYYY-MM-DD */
function isIsoDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Problem found in one value.
 * @param {Schema} schema
 * @param {string} name
 * @param {unknown} value present, non-empty
 * @returns {string | null} message, or null when valid
 */
function checkValue(schema, name, value) {
  const def = schema.fields[name];
  switch (def.kind) {
    case 'note-type':
      if (typeof value !== 'string' || !Object.hasOwn(schema.types, value)) {
        return `${name}: ${JSON.stringify(value)} is not a known note type (${Object.keys(schema.types).join(', ')})`;
      }
      return null;
    case 'string':
      return typeof value === 'string' ? null : `${name}: must be text`;
    case 'date':
      return typeof value === 'string' && isIsoDate(value) ? null : `${name}: ${JSON.stringify(value)} is not an ISO date (YYYY-MM-DD)`;
    case 'enum':
      return typeof value === 'string' && /** @type {string[]} */ (def.values).includes(value)
        ? null
        : `${name}: ${JSON.stringify(value)} is not one of ${/** @type {string[]} */ (def.values).join(', ')}`;
    case 'string-list': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
        return `${name}: must be a list of non-empty text items`;
      }
      const min = def.min_items ?? 0;
      return value.length >= min ? null : `${name}: needs at least ${min} item(s)`;
    }
  }
  return null;
}

/**
 * @typedef {object} NoteProblem
 * @property {'missing-required-field' | 'invalid-value' | 'unknown-type'} rule
 * @property {string} message names the field
 */

/**
 * Validate the frontmatter of one note against the schema.
 * @param {Schema} schema
 * @param {Record<string, unknown>} data parsed frontmatter
 * @returns {NoteProblem[]}
 */
export function validateNote(schema, data) {
  /** @type {NoteProblem[]} */
  const problems = [];
  const type = data.type;
  const typeKnown = typeof type === 'string' && Object.hasOwn(schema.types, type);
  if (!isEmpty(type) && !typeKnown) {
    problems.push({ rule: 'unknown-type', message: /** @type {string} */ (checkValue(schema, 'type', type)) });
  }
  const required = [...schema.common_required, ...(typeKnown ? schema.types[type].required : [])];
  for (const name of new Set(required)) {
    if (isEmpty(data[name])) problems.push({ rule: 'missing-required-field', message: `${name}: required field is missing` });
  }
  for (const [name, value] of Object.entries(data)) {
    if (!Object.hasOwn(schema.fields, name) || isEmpty(value) || (name === 'type' && !typeKnown)) continue;
    const message = checkValue(schema, name, value);
    if (message !== null) problems.push({ rule: 'invalid-value', message });
  }
  return problems;
}
