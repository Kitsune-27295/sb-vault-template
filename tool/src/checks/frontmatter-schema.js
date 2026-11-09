import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listFiles } from '../lib/files.js';
import { readFrontmatter } from '../lib/frontmatter.js';
import { normalizeNewlines, stripBom } from '../lib/markdown.js';
import { finding } from '../lib/report.js';
import { loadSchema, SCHEMA_PATH, TEMPLATES_DIR, validateNote } from '../lib/schema.js';
import { instantiateTemplate, renderTemplate } from '../lib/templates.js';
import { GENERATED_MARKER, isHeldBack, ZONES } from '../lib/zones.js';

export const id = 'frontmatter-schema';

/** Zones whose notes are validated: agent-written knowledge, proposals and operations. */
const NOTE_ZONES = [ZONES.proposals, ZONES.compiled, ZONES.ops];

/** Zones where every Markdown note must carry frontmatter. Operations notes (hot memory, dashboards' README) are free text. */
const FRONTMATTER_REQUIRED_ZONES = [ZONES.proposals, ZONES.compiled];

/**
 * @param {string} text file content
 * @returns {boolean} true for a file `sbk index` generated: its first line is the generated marker
 */
function isGenerated(text) {
  return stripBom(text).split(/\r?\n/, 1)[0].trim() === GENERATED_MARKER;
}

/**
 * Every note in the proposals, compiled and operations zones that carries
 * frontmatter satisfies the schema in `90-system/schema/`; the shipped templates
 * are the schema's own rendering. A Markdown note with no frontmatter block in
 * the proposals or compiled zone is an error (`frontmatter-missing`), except a
 * generated file (it opens with the generated marker). Operations notes may be
 * free text. Raw sources, human notes and sidecars are not checked.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  const error = (/** @type {string} */ path, /** @type {string} */ rule, /** @type {string} */ message) =>
    findings.push(finding(path, rule, 'error', message));

  const { schema, problems, fromVault } = await loadSchema(vault);
  if (schema === null) {
    for (const problem of problems) error(SCHEMA_PATH, 'schema-invalid', problem);
    return findings;
  }

  for (const zone of NOTE_ZONES) {
    const folder = join(vault, zone);
    for (const file of (await listFiles(folder)).filter((f) => f.toLowerCase().endsWith('.md'))) {
      const path = `${zone}/${file}`;
      if (isHeldBack(path)) continue;
      const text = await readFile(join(folder, ...file.split('/')), 'utf8');
      const frontmatter = readFrontmatter(text);
      if (!frontmatter.present) {
        if (FRONTMATTER_REQUIRED_ZONES.includes(zone) && !isGenerated(text)) {
          error(path, 'frontmatter-missing', 'a note in this zone must start with a frontmatter block (copy a template from 90-system/templates/)');
        }
        continue;
      }
      if ('error' in frontmatter) {
        error(path, 'frontmatter-invalid', frontmatter.error);
        continue;
      }
      for (const problem of validateNote(schema, frontmatter.data)) error(path, problem.rule, problem.message);
    }
  }

  // Templates are only checked in a vault that carries its own System zone;
  // without one the bundled schema is used and there is nothing to compare.
  if (fromVault) {
    for (const type of Object.keys(schema.types)) {
      const rendered = renderTemplate(schema, type);
      const instance = readFrontmatter(instantiateTemplate(rendered, { title: 'Template check', date: '2000-01-01' }));
      const templateProblems = 'data' in instance ? validateNote(schema, instance.data) : [{ message: 'no frontmatter' }];
      for (const problem of templateProblems) {
        error(SCHEMA_PATH, 'template-invalid', `a note made from the ${type} template would fail: ${problem.message}`);
      }
      const templatePath = `${TEMPLATES_DIR}/${type}.md`;
      let onDisk;
      try {
        onDisk = await readFile(join(vault, templatePath), 'utf8');
      } catch (cause) {
        if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'ENOENT') throw cause;
        error(templatePath, 'template-missing', `the schema declares type ${type} but it has no template`);
        continue;
      }
      if (normalizeNewlines(onDisk) !== rendered) {
        error(templatePath, 'template-stale', `differs from what the schema generates; run sbk templates <vault>`);
      }
    }
  }
  return findings;
}
