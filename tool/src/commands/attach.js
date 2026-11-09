import { UsageError } from '../lib/errors.js';
import { buildBlock } from '../lib/attach-block.js';
import { checkWiring, mergeChecks } from '../lib/attach-check.js';
import { identityForPath, invocation } from '../lib/attach-paths.js';
import { loadTarget, parseTargets, requireClaudeOnly, resolveHome } from '../lib/attach.js';
import { runPermissions } from '../lib/attach-permissions-run.js';
import { emit, runPrint } from '../lib/attach-print.js';
import { runEdit } from '../lib/attach-run.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport } from '../lib/report.js';

export const name = 'attach';
export const summary = 'Add a managed pointer block for an Instance to the global file of Claude Code, Codex, Gemini CLI and Antigravity, or Copilot (dry run by default; --check verifies; --print prints the block; --permissions edits the Claude Code settings)';
export const usage = '<instance> --target <claude|codex|gemini|copilot|cursor|all>[,...] [--apply] [--check] [--print] [--permissions] [--home <dir>]';
export const options = {
  target: { type: /** @type {'string'} */ ('string') },
  apply: { type: /** @type {'boolean'} */ ('boolean') },
  check: { type: /** @type {'boolean'} */ ('boolean') },
  print: { type: /** @type {'boolean'} */ ('boolean') },
  permissions: { type: /** @type {'boolean'} */ ('boolean') },
  home: { type: /** @type {'string'} */ ('string') },
};

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('attach needs exactly one argument: <instance>');
  const { apply, check, print, permissions, home: homeOption } = ctx.values;
  if (apply === true && check === true) throw new UsageError('--check only reads; it cannot be combined with --apply');
  if (print === true && (apply === true || check === true)) throw new UsageError('--print only prints the block; it cannot be combined with --apply or --check');
  if (print === true && permissions === true) throw new UsageError('--print only prints the block; it cannot be combined with --permissions');
  const targets = parseTargets(ctx.values.target, print === true);
  if (permissions === true) requireClaudeOnly(targets);

  const home = print === true ? '' : await resolveHome(homeOption);
  if (permissions === true) return runPermissions(ctx, { mode: check === true ? 'check' : 'attach', home, instanceArg: ctx.args[0], homeOption });

  if (check === true) {
    // The Instance may be gone (that is a finding), so it is not required to exist.
    const identity = identityForPath(ctx.args[0]);
    buildBlock({ identity, ...invocation() }); // the same path validation as the block itself
    const perTarget = await Promise.all(targets.map(async (target) => checkWiring({ loaded: await loadTarget(home, target), identity, homeOption })));
    return emit(ctx, buildReport({ frameworkVersion: ctx.version, vault: identity.path, checks: mergeChecks(perTarget) }));
  }

  const vault = await requireInstance(ctx.args[0]);
  const identity = identityForPath(vault);
  const block = buildBlock({ identity, ...invocation() });
  if (print === true) return runPrint(ctx, { vault, targets, block });
  return runEdit(ctx, { vault, home, key: identity.key, targets, block });
}
