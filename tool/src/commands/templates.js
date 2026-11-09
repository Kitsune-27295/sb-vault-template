import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from '../lib/errors.js';
import { requireDirectory } from '../lib/instance.js';
import { TEMPLATE_DIR } from '../lib/paths.js';
import { buildReport, checkResult, formatHuman, formatJson } from '../lib/report.js';
import { loadSchema, SCHEMA_PATH, TEMPLATES_DIR } from '../lib/schema.js';
import { renderTemplate } from '../lib/templates.js';

export const name = 'templates';
export const summary = 'Regenerate the note templates in 90-system/templates/ from the schema';
export const usage = '[vault]';

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length > 1) throw new UsageError('templates takes at most one argument: [vault]');
  // The framework's own template folder by default; an Instance, or any folder that holds a schema, otherwise.
  const root = ctx.args.length === 1 ? await requireDirectory(ctx.args[0], 'vault') : TEMPLATE_DIR;
  try {
    if (!(await stat(join(root, ...SCHEMA_PATH.split('/')))).isFile()) throw new Error('not a file');
  } catch {
    throw new UsageError(`no schema at ${SCHEMA_PATH} in ${root}; nothing was written`);
  }
  const { schema, problems } = await loadSchema(root);
  if (schema === null) {
    throw new UsageError(`the schema is not valid; nothing was written:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  await mkdir(join(root, ...TEMPLATES_DIR.split('/')), { recursive: true });
  const written = [];
  for (const type of Object.keys(schema.types)) {
    const path = `${TEMPLATES_DIR}/${type}.md`;
    await writeFile(join(root, ...path.split('/')), renderTemplate(schema, type));
    written.push(path);
  }
  const report = buildReport({ frameworkVersion: ctx.version, vault: root, checks: [checkResult('templates', [])] });
  ctx.print(ctx.json ? formatJson(report) : `${written.map((p) => `wrote ${p}`).join('\n')}\n\n${formatHuman(report)}`);
  return 0;
}
