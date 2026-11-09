import { UsageError } from '../lib/errors.js';
import { guardRefs } from '../lib/publish-guard.js';
import { buildReport, checkResult, exitCodeFor, formatHuman, formatJson } from '../lib/report.js';

export const name = 'publish-guard';
export const summary = 'Refuse a publication push to the default branch, stable or a v* tag (maintainers)';
export const usage = '--default-branch <name> [--target-branch <name>] [--promote --confirm <phrase>] [--move-stable --confirm-stable <phrase> --stable-to <commit> --release-commits <commit>,...] <ref>...';
export const options = {
  'default-branch': { type: 'string' },
  'target-branch': { type: 'string' },
  promote: { type: 'boolean' },
  confirm: { type: 'string' },
  'move-stable': { type: 'boolean' },
  'confirm-stable': { type: 'string' },
  'stable-to': { type: 'string' },
  'release-commits': { type: 'string' },
};

/** @param {import('../cli.js').CommandContext} ctx */
export function run(ctx) {
  const defaultBranch = ctx.values['default-branch'];
  if (typeof defaultBranch !== 'string' || defaultBranch.trim() === '') throw new UsageError('publish-guard needs --default-branch <name>, the default branch of the target repository');
  if (ctx.args.length === 0) throw new UsageError('publish-guard needs at least one destination ref');
  const targetBranch = ctx.values['target-branch'];
  if (targetBranch !== undefined && targetBranch.trim() === '') throw new UsageError('--target-branch needs a branch name');
  const findings = guardRefs(ctx.args, { defaultBranch, promote: ctx.values.promote === true, confirm: ctx.values.confirm, targetBranch,
    moveStable: ctx.values['move-stable'] === true,
    confirmStable: ctx.values['confirm-stable'],
    stableTo: ctx.values['stable-to'],
    releaseCommits: (ctx.values['release-commits'] ?? '').split(',').filter((sha) => sha !== ''),
  });
  const report = buildReport({ frameworkVersion: ctx.version, vault: process.cwd(), checks: [checkResult('publish-guard', findings)] });
  ctx.print(ctx.json ? formatJson(report) : formatHuman(report));
  return exitCodeFor(report);
}
