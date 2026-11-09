import { stringify } from 'yaml';

/**
 * Render the note template of one type from the schema. The output is a pure
 * function of the schema, so a template can never disagree with it.
 * @param {import('./schema.js').Schema} schema
 * @param {string} typeName a key of `schema.types`
 * @returns {string} Markdown with LF line endings
 */
export function renderTemplate(schema, typeName) {
  const names = [...new Set([...schema.common_required, ...schema.types[typeName].required])];
  /** @type {Record<string, unknown>} */
  const frontmatter = {};
  for (const name of names) {
    frontmatter[name] = schema.fields[name].kind === 'note-type' ? typeName : schema.fields[name].template;
  }
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n# {{title}}\n`;
}

/**
 * Fill in the placeholders Obsidian's core Templates plugin fills in.
 * @param {string} template
 * @param {{ title: string, date: string }} values
 * @returns {string}
 */
export function instantiateTemplate(template, { title, date }) {
  return template.replaceAll('{{title}}', title).replaceAll('{{date}}', date);
}
