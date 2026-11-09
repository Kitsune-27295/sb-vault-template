/**
 * `attach --permissions`, `detach --permissions` and `attach --check --permissions`: read the user
 * settings and the state file of the Claude Code directory, plan the merge or the removal, write
 * only on `--apply`, and print the shared report. The pure edits are in `attach-permissions.js`.
 */
import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { identityOf, invocation } from './attach-paths.js';
import { repairCommand } from './attach.js';
import {
  DEFAULT_STYLE, LISTS, SETTINGS_FILE, STATE_FILE, countEntries, emptyEntries, entriesFor, isEmptyState,
  mergeEntries, parseObject, recordedFor, removeEntries, serialize, splitByPresence, unionEntries, withRecord,
} from './attach-permissions.js';
import { backupNote, emit } from './attach-print.js';
import { requireInstance } from './instance.js';
import { canonicalSlash, slash } from './paths.js';
import { buildReport, checkResult, finding } from './report.js';
import { readSafeText } from './safe-read.js';
import { backupOnce, writeTarget } from './safe-write.js';

/**
 * @typedef {object} JsonFile
 * @property {string} file
 * @property {boolean} existed
 * @property {Record<string, any>} data `{}` when the file does not exist
 * @property {import('./attach-permissions.js').Style} style
 * @property {boolean} lossless re-serializing `data` gives back the file's content
 */

/**
 * Read a JSON object file without following links.
 * @param {string} file
 * @returns {Promise<JsonFile>}
 * @throws {UsageError} when the file must not be edited
 */
async function loadJson(file) {
  const refuse = (/** @type {string} */ why) => new UsageError(`refusing ${slash(file)}: ${why}; nothing was written`);
  const read = await readSafeText(file);
  if (read.status === 'missing') return { file, existed: false, data: {}, style: DEFAULT_STYLE, lossless: true };
  if (read.status === 'refused') throw refuse(`it ${read.reason}`);
  try {
    return { file, existed: true, ...parseObject(read.text) };
  } catch (error) {
    throw refuse(`it ${/** @type {Error} */ (error).message}`);
  }
}

/** @param {import('./attach-permissions.js').Entries} entries @returns {string[]} one line per entry */
const entryLines = (entries) => LISTS.flatMap((list) => entries[list].map((entry) => `  ${list}: ${entry}`));

/**
 * The refusal for a JSON file whose rewrite would change more than the entries: nothing is written,
 * and the entries to change by hand are listed.
 * @param {string} file
 * @param {'add' | 'remove'} verb
 * @param {import('./attach-permissions.js').Entries} entries
 * @returns {UsageError}
 */
function lossyRefusal(file, verb, entries) {
  return new UsageError(
    `refusing ${slash(file)}: rewriting it would not be lossless (a duplicate key, integer-like keys that JSON reorders, or a number that does not round-trip, such as 1.0 or 12345678901234567890); nothing was written; ${verb} these entries by hand under "permissions":\n${entryLines(entries).join('\n')}`,
  );
}

/**
 * The error for a write that failed after earlier files were written.
 * @param {string[]} written
 * @param {string[]} notWritten
 * @param {Error} error
 * @returns {UsageError}
 */
function partialFailure(written, notWritten, error) {
  const names = (/** @type {string[]} */ list) => (list.length === 0 ? 'none' : list.join(', '));
  return new UsageError(`writing ${notWritten[0]} failed (${error.message}); written: ${names(written)}; not written: ${names(notWritten)}; fix the cause and run the same command again`);
}

/**
 * @param {import('../cli.js').CommandContext} ctx
 * @param {object} input
 * @param {'attach' | 'detach' | 'check'} input.mode
 * @param {string} input.home home directory
 * @param {string} input.instanceArg the Instance path as given
 * @param {string | undefined} input.homeOption the `--home` value as given, repeated in repair commands
 * @returns {Promise<number>} exit code
 */
export async function runPermissions(ctx, { mode, home, instanceArg, homeOption }) {
  const apply = ctx.values.apply === true;
  const dir = join(home, '.claude');
  const settingsPath = join(dir, SETTINGS_FILE);
  const statePath = join(dir, STATE_FILE);
  const settingsFile = slash(settingsPath);
  const stateFile = slash(statePath);
  const vault = mode === 'attach' ? await requireInstance(instanceArg) : instanceArg;
  const identity = identityOf(canonicalSlash(vault));
  const { key } = identity;
  // The entries this framework generates for the Instance now; the paths are validated here, once.
  const expected = entriesFor({ instancePath: identity.path, ...invocation() });
  const report = (/** @type {string} */ id, /** @type {import('./report.js').Finding[]} */ findings) =>
    buildReport({ frameworkVersion: ctx.version, vault: identity.path, checks: [checkResult(id, findings)] });
  const command = (/** @type {'attach' | 'detach'} */ verb) => repairCommand({ verb, instance: identity.path, target: 'claude', homeOption, permissions: true });

  const dirInfo = await lstat(dir).catch(() => null);
  if (dirInfo === null) {
    const message = `Claude Code is not installed here (no .claude directory under ${slash(home)}); skipped, nothing was written`;
    return emit(ctx, report('attach-target', [finding(slash(dir), 'tool-not-installed', 'info', message)]), {
      extra: { attach: { target: 'claude', file: settingsFile, action: 'skipped', applied: false } },
      human: `${message}\n`,
    });
  }
  if (!dirInfo.isDirectory()) throw new UsageError(`refusing ${slash(dir)}: it is not a directory; nothing was written`);

  const state = await loadJson(statePath);
  const recorded = recordedFor(state.data, key);

  if (mode === 'check') {
    const settings = await loadJson(settingsPath).catch((/** @type {UsageError} */ error) => error);
    if (settings instanceof UsageError) {
      const message = `${settings.message.replace('; nothing was written', '')}; fix the file by hand, then run: ${command('attach')}`;
      return emit(ctx, report('attach-permissions', [finding(settingsFile, 'settings-unreadable', 'error', message)]));
    }
    const findings = [];
    for (const list of LISTS) {
      for (const entry of expected[list]) {
        const present = Array.isArray(settings.data.permissions?.[list]) && settings.data.permissions[list].includes(entry);
        findings.push(present
          ? finding(settingsFile, 'permission-present', 'info', `permissions.${list} holds ${entry}`)
          : finding(settingsFile, 'permission-missing', 'error', `permissions.${list} lacks ${entry}; to add it run: ${command('attach')}`));
      }
    }
    return emit(ctx, report('attach-permissions', findings));
  }

  const settings = await loadJson(settingsPath);
  const target = { apply, key, settings, state, recorded, settingsFile, stateFile, report };
  return mode === 'attach' ? attachPermissions(ctx, { ...target, expected }) : detachPermissions(ctx, { ...target, expected });
}

/**
 * The merge: append what is absent, record exactly that. The record is written before the settings,
 * so a failure in between leaves a record that is a superset of what the settings hold; detach
 * removes only what both hold.
 */
async function attachPermissions(ctx, { apply, key, settings, state, recorded, expected, settingsFile, stateFile, report }) {
  const added = mergeEntries(settings.data, expected, settingsFile);
  const changes = countEntries(added) > 0;
  if (changes && !settings.lossless) throw lossyRefusal(settingsFile, 'add', added);
  const next = withRecord(state.data, key, unionEntries(recorded, added));
  const stateChanged = changes && JSON.stringify(next) !== JSON.stringify(state.data);
  if (stateChanged && !state.lossless) throw new UsageError(`refusing ${stateFile}: rewriting it would not be lossless; remove or repair the file by hand; nothing was written`);
  let backup = null;
  if (apply && changes) {
    const order = stateChanged ? [stateFile, settingsFile] : [settingsFile];
    /** @type {string[]} */
    const written = [];
    try {
      if (stateChanged) {
        await writeTarget(state.file, state.existed, serialize(next, state.style));
        written.push(stateFile);
      }
      backup = await writeTarget(settings.file, settings.existed, serialize(settings.data, settings.style));
    } catch (error) {
      throw partialFailure(written, order.filter((file) => !written.includes(file)), /** @type {Error} */ (error));
    }
  }
  const applied = apply && changes;
  const action = changes ? 'add' : 'unchanged';
  const result = report('attach-permissions', [finding(settingsFile, `permissions-${action}`, 'info', changes ? `${action} ${countEntries(added)} entries for "${key}"${apply ? '' : ' (dry run)'}` : `every entry for "${key}" is already present`)]);
  const lines = [changes ? `${applied ? 'added' : 'dry run, would add'} ${countEntries(added)} permission entries for "${key}" in ${settingsFile}` : `unchanged: ${settingsFile} already holds every permission entry for "${key}"`];
  if (changes) lines.push('', ...entryLines(added), '');
  if (applied) lines.push(backupNote(settings.existed, backup), `recorded in: ${stateFile}`);
  else if (changes) lines.push('nothing was written; run again with --apply to write it');
  return emit(ctx, result, {
    extra: { attach: { target: 'claude', file: settingsFile, state: stateFile, action, applied, backup, permissions: added } },
    human: `${lines.join('\n')}\n`,
  });
}

/**
 * The removal: take out only the entries that the record lists AND the framework would generate now,
 * then the record. Any other recorded entry is ignored and reported, never removed.
 */
async function detachPermissions(ctx, { apply, key, settings, state, recorded, expected, settingsFile, stateFile, report }) {
  if (countEntries(recorded) === 0) {
    return emit(ctx, report('attach-permissions', [finding(stateFile, 'permissions-absent', 'info', `no permission entries recorded for "${key}"`)]), {
      extra: { attach: { target: 'claude', file: settingsFile, state: stateFile, action: 'absent', applied: false } },
      human: `nothing to remove: ${stateFile} records no permission entries for "${key}"\n`,
    });
  }
  const { both: removable, onlyA: ignored } = splitByPresence(recorded, expected);
  const removed = settings.existed ? removeEntries(settings.data, removable, settingsFile) : emptyEntries();
  const changes = countEntries(removed) > 0;
  if (changes && !settings.lossless) throw lossyRefusal(settingsFile, 'remove', removed);
  const next = withRecord(state.data, key, emptyEntries());
  if (!state.lossless) throw new UsageError(`refusing ${stateFile}: rewriting it would not be lossless; remove or repair the file by hand; nothing was written`);
  let backup = null;
  if (apply) {
    const order = changes ? [settingsFile, stateFile] : [stateFile];
    /** @type {string[]} */
    const written = [];
    try {
      // The settings first: until their entries are gone the record must stay.
      if (changes) {
        backup = await writeTarget(settings.file, settings.existed, serialize(settings.data, settings.style));
        written.push(settingsFile);
      }
      if (isEmptyState(next)) {
        await backupOnce(state.file);
        await unlink(state.file);
      } else {
        await writeTarget(state.file, true, serialize(next, state.style));
      }
    } catch (error) {
      throw partialFailure(written, order.filter((file) => !written.includes(file)), /** @type {Error} */ (error));
    }
  }
  const warnings = LISTS.flatMap((list) => ignored[list].map((entry) => finding(
    stateFile, 'permissions-record-ignored', 'warning',
    `the record lists ${list}: ${entry}, which is not what this framework generates for "${key}" now; it was not removed from ${settingsFile}, remove it by hand if it is yours`,
  )));
  const result = report('attach-permissions', [finding(settingsFile, 'permissions-remove', 'info', `remove ${countEntries(removed)} entries for "${key}"${apply ? '' : ' (dry run)'}`), ...warnings]);
  const lines = [`${apply ? 'removed' : 'dry run, would remove'} ${countEntries(removed)} permission entries for "${key}" from ${settingsFile}`];
  if (changes) lines.push('', ...entryLines(removed), '');
  if (countEntries(removable) > countEntries(removed)) lines.push('the other recorded entries are already gone from the file', '');
  for (const warning of warnings) lines.push(`warning: ${warning.message}`);
  if (apply) lines.push(changes ? backupNote(settings.existed, backup) : 'no backup: the settings file was not changed', `record removed from: ${stateFile}`);
  else lines.push('nothing was written; run again with --apply to write it');
  return emit(ctx, result, {
    extra: { attach: { target: 'claude', file: settingsFile, state: stateFile, action: 'remove', applied: apply, backup, permissions: removed } },
    human: `${lines.join('\n')}\n`,
  });
}
