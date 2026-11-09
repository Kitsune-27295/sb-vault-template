/**
 * The preview-or-apply flow shared by `attach` and `detach`: plan the edit of every selected
 * global file first, write them only when asked and only when none was refused, and print the
 * result as the shared report. A write that fails part-way is reported target by target.
 */
import { LINE_BUDGET } from './attach-block.js';
import { loadTarget, planEdit, requireEditable, skipMessage, toolInfo } from './attach.js';
import { backupNote, emit } from './attach-print.js';
import { UsageError } from './errors.js';
import { slash } from './paths.js';
import { buildReport, checkResult, finding } from './report.js';
import { writeTarget } from './safe-write.js';

const PAST = { add: 'added', update: 'updated', remove: 'removed' };

/**
 * @param {import('../cli.js').CommandContext} ctx
 * @param {object} input
 * @param {string} input.vault path shown as the report's `vault`
 * @param {string} input.home home directory
 * @param {string} input.key Instance key, naming its block
 * @param {string[]} input.targets target names, from `parseTargets`
 * @param {string[] | null} input.block the block to write, or null to remove the block of `key`
 * @returns {Promise<number>} exit code
 */
export async function runEdit(ctx, { vault, home, key, targets, block }) {
  const apply = ctx.values.apply === true;
  const many = targets.length > 1;
  const loadedAll = await Promise.all(targets.map((target) => loadTarget(home, target)));
  requireEditable(loadedAll.filter((l) => !l.skipped));

  // Plan every file before writing any, so a refusal or an oversize result writes nothing.
  const entries = loadedAll.map((loaded) => {
    if (loaded.skipped) return { loaded, kind: /** @type {const} */ ('skipped') };
    if (block === null && !loaded.scan.blocks.has(key)) return { loaded, kind: /** @type {const} */ ('absent') };
    return { loaded, kind: /** @type {const} */ ('plan'), plan: planEdit(loaded, key, block) };
  });

  const results = [];
  const pending = entries.filter((e) => e.plan !== undefined && e.plan.action !== 'unchanged');
  for (const entry of entries) {
    const changes = pending.includes(entry);
    let backup = null;
    if (apply && changes) {
      try {
        backup = await writeTarget(entry.loaded.file, entry.loaded.existed, /** @type {NonNullable<typeof entry.plan>} */ (entry.plan).text);
      } catch (error) {
        throw partialFailure(entry, pending, /** @type {Error} */ (error));
      }
    }
    results.push({ ...entry, file: slash(entry.loaded.file), applied: apply && changes, backup });
  }

  const targetFindings = [];
  const blockFindings = [];
  for (const { loaded, kind, plan, file } of results) {
    if (kind === 'skipped') targetFindings.push(finding(slash(loaded.dir), 'tool-not-installed', 'info', skipMessage(loaded)));
    else if (kind === 'absent') blockFindings.push(finding(file, 'block-absent', 'info', `no block for "${key}"`));
    else if (plan !== undefined) {
      blockFindings.push(finding(file, `block-${plan.action}`, 'info', `${plan.action} the block for "${key}"${apply ? '' : ' (dry run)'}`));
      if (plan.overBudget) blockFindings.push(finding(file, 'size-budget', 'warning', `the file has ${plan.lines} lines, above the ${LINE_BUDGET} line guidance for always-loaded instructions`));
    }
  }
  const checks = [];
  if (targetFindings.length > 0) checks.push(checkResult('attach-target', targetFindings));
  if (blockFindings.length > 0) checks.push(checkResult('attach-block', blockFindings));
  const report = buildReport({ frameworkVersion: ctx.version, vault, checks });

  const attachments = results.map(({ loaded, kind, plan, file, applied, backup }) => {
    if (plan === undefined) return { target: loaded.target, file, action: kind, applied: false };
    return { target: loaded.target, file, action: plan.action, applied, backup, block: block?.join('\n') ?? null };
  });
  const heads = [];
  const notes = [];
  let pendingWrite = false;
  for (const { loaded, kind, plan, file, applied, backup } of results) {
    const prefix = many ? `${loaded.target}: ` : '';
    if (kind === 'skipped') {
      heads.push(skipMessage(loaded));
      continue;
    }
    if (kind === 'absent') {
      heads.push(`nothing to remove: ${file} has no block for "${key}"`);
    } else if (plan !== undefined) {
      const verb = plan.action === 'unchanged' ? 'unchanged' : applied ? PAST[plan.action] : `dry run, would ${plan.action}`;
      heads.push(`${verb}: the block for "${key}" in ${file}`);
      if (plan.action === 'unchanged') notes.push(`${prefix}the file already holds this exact block`);
      else if (applied) notes.push(`${prefix}${backupNote(loaded.existed, backup)}`);
      else pendingWrite = true;
      if (plan.overBudget) notes.push(`${prefix}warning: the file has ${plan.lines} lines, above the ${LINE_BUDGET} line guidance`);
    }
    const note = toolInfo(loaded.target).note;
    if (note !== undefined) notes.push(`${prefix}note: ${note}`);
  }
  if (pendingWrite) notes.push('nothing was written; run again with --apply to write it');

  const lines = [...heads];
  if (block !== null && results.some((r) => r.plan !== undefined)) lines.push('', block.join('\n'));
  if (notes.length > 0) lines.push('', ...notes);
  return emit(ctx, report, { extra: { ...(many ? {} : { attach: attachments[0] }), attachments }, human: `${lines.join('\n')}\n` });
}

/**
 * The error for a write that failed after earlier targets were written: it says which are which.
 * @param {{ loaded: import('./attach.js').Loaded }} failed the target whose write failed
 * @param {{ loaded: import('./attach.js').Loaded }[]} pending every target with a change to write, in order
 * @param {Error} error
 * @returns {UsageError}
 */
function partialFailure(failed, pending, error) {
  const at = pending.indexOf(/** @type {any} */ (failed));
  const names = (/** @type {typeof pending} */ list) => (list.length === 0 ? 'none' : list.map((e) => slash(e.loaded.file)).join(', '));
  return new UsageError(
    `writing ${slash(failed.loaded.file)} failed (${error.message}); written: ${names(pending.slice(0, at))}; not written: ${names(pending.slice(at))}; fix the cause and run the same command again`,
  );
}
