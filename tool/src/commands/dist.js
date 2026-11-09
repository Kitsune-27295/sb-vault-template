import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UsageError } from '../lib/errors.js';
import { assertEmptyOrMissing } from '../lib/create-instance.js';
import { compareTree, manifestOf, planDist } from '../lib/dist.js';
import { assertSafePathArgument } from '../lib/migrate/path-args.js';
import { FRAMEWORK_ROOT, resolveUserPath } from '../lib/paths.js';
import { buildReport, checkResult, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';
import { writeAtomic } from '../lib/safe-write.js';

export const name = 'dist';
export const summary = 'Build the publish tree of the template repository, or compare a folder with it (maintainers)';
export const usage = '<output-dir> [--source-commit <sha>] | --check <dir> [--root <repo>]';
export const options = { check: { type: 'string' }, 'source-commit': { type: 'string' }, root: { type: 'string' } };

/**
 * @param {string} root absolute repository root
 * @returns {Promise<string>} the version in the root's `package.json`
 */
async function versionOf(root) {
  try {
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    if (typeof version === 'string') return version;
  } catch {
    // fall through to the usage error
  }
  throw new UsageError(`no package.json with a version in ${root}`);
}

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  const check = ctx.values.check;
  if (check === undefined ? ctx.args.length !== 1 : ctx.args.length !== 0) {
    throw new UsageError('dist needs one argument, <output-dir>, or --check <dir> with no argument');
  }
  const commit = ctx.values['source-commit'];
  if (commit !== undefined && !/^[0-9a-f]{7,64}$/.test(commit)) throw new UsageError('--source-commit must be a lowercase hexadecimal commit id of 7 to 64 characters');
  if (check !== undefined && commit !== undefined) throw new UsageError('--source-commit applies to a build, not to --check');

  // Paths are hostile input: refuse a control character or a device path before anything is read or written.
  if (ctx.values.root !== undefined) assertSafePathArgument(ctx.values.root, 'root');
  if (check !== undefined) assertSafePathArgument(check, 'check');
  else assertSafePathArgument(ctx.args[0], 'output');
  const root = ctx.values.root === undefined ? FRAMEWORK_ROOT : resolveUserPath(ctx.values.root);
  const version = await versionOf(root);
  const plan = await planDist(root);
  const sourceCommit = commit ?? null;
  const manifest = manifestOf(plan, { version, sourceCommit });

  const checks = [checkResult('dist-sources', plan.sourceFindings), checkResult('dist-secret-scan', plan.secretFindings), checkResult('dist-personal-paths', plan.pathFindings)];
  const ok = checks.every((c) => c.status === 'pass');
  /** @type {string | null} */
  let written = null;

  if (check !== undefined) {
    const folder = resolveUserPath(check);
    checks.push(checkResult('dist-compare', ok ? await compareTree(folder, plan) : []));
  } else {
    const out = resolveUserPath(ctx.args[0]);
    await assertEmptyOrMissing(out);
    if (ok) {
      for (const file of plan.files) {
        const target = join(out, 'tree', ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: 'wx' });
      }
      // The manifest is written beside the tree and inside it (at its root), so that a vault workflow that
      // checks the template out can verify `tool/` and `template/` against it (ADR 0013). It does not list itself.
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(join(out, 'tree', 'manifest.json'), manifestText, { flag: 'wx' });
      await writeAtomic(join(out, 'manifest.json'), manifestText);
      written = out;
    }
  }

  const report = {
    ...buildReport({ frameworkVersion: ctx.version, vault: root, checks }),
    dist: { built: ok, written, manifest: ok ? manifest : null },
  };
  const note = ok ? '' : 'Nothing was written: fix the errors above and run it again.\n';
  ctx.print(ctx.json ? formatJson(report) : `${formatHuman(report)}${note}`);
  return exitCodeFor(report);
}
