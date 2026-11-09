import { UsageError } from '../lib/errors.js';
import { resolveUserPath } from '../lib/paths.js';
import { identityForPath } from '../lib/attach-paths.js';
import { parseTargets, requireClaudeOnly, resolveHome } from '../lib/attach.js';
import { runPermissions } from '../lib/attach-permissions-run.js';
import { runEdit } from '../lib/attach-run.js';

export const name = 'detach';
export const summary = 'Remove the managed pointer block of an Instance from the global file of Claude Code, Codex, Gemini CLI and Antigravity, or Copilot, or with --permissions the entries recorded in the Claude Code settings (dry run by default)';
export const usage = '<instance> --target <claude|codex|gemini|copilot|all>[,...] [--apply] [--permissions] [--home <dir>]';
export const options = {
  target: { type: /** @type {'string'} */ ('string') },
  apply: { type: /** @type {'boolean'} */ ('boolean') },
  permissions: { type: /** @type {'boolean'} */ ('boolean') },
  home: { type: /** @type {'string'} */ ('string') },
};

/**
 * The Instance folder need not exist: its block must stay removable after the folder is deleted.
 * @param {import('../cli.js').CommandContext} ctx
 */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('detach needs exactly one argument: <instance>');
  const targets = parseTargets(ctx.values.target);
  if (ctx.values.permissions === true) requireClaudeOnly(targets);
  const home = await resolveHome(ctx.values.home);
  if (ctx.values.permissions === true) return runPermissions(ctx, { mode: 'detach', home, instanceArg: ctx.args[0], homeOption: ctx.values.home });
  const identity = identityForPath(ctx.args[0]);
  return runEdit(ctx, { vault: resolveUserPath(ctx.args[0]), home, key: identity.key, targets, block: null });
}
