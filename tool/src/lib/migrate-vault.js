/**
 * `migrate-vault` (ADR 0013): bring a Git working tree to this framework in place. A foreign vault
 * is imported into a scratch sibling of the working tree with the import engine, verified there with
 * the strict verifier, and only then swapped in: every entry of the root except `.git` and `.github`
 * is replaced by the Instance's entries. An Instance already on this framework gets the `upgrade`
 * logic. The folder given is only read until the swap; `.git` and `.github` are never touched.
 *
 * Every run ends in one stable `status` with a `reason` code (see `OUTCOMES`): a caller such as the
 * bridge workflow decides from them, never from the bare exit code.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UsageError } from './errors.js';
import { exists, listFiles } from './files.js';
import { requireDirectory } from './instance.js';
import { assertSafePathArgument, isInside } from './migrate/path-args.js';
import { chooseAdapter, loadAdapters } from './migrate/detect.js';
import { importReport, runImport } from './migrate/engine.js';
import { resolveUserPath } from './paths.js';
import { buildReport, checkResult, finding } from './report.js';
import { moveEntry } from './safe-write.js';
import { resolveTemplate } from './system-files.js';
import { upgradeCheck, upgradeInstance } from './upgrade-vault.js';
import { LOCK_PATH } from './zones.js';

/** Root entries of the working tree that a migration never touches. */
export const KEPT_ENTRIES = Object.freeze(['.git', '.github']);

/** Root files that stay when the Instance has none of its own: the Git settings of the repository, never deleted. */
const KEPT_IF_ABSENT = Object.freeze(['.gitignore', '.gitattributes']);

/**
 * The status of every run. `migrated` and `upgraded` changed the tree; `planned` is a dry run that
 * would change it; `current` has nothing to change. `not-migratable` is the ONE clean "not for this
 * tool" ending (the folder is not a vault the tool knows); `refused` and `failed` are never clean.
 * @typedef {'migrated' | 'upgraded' | 'planned' | 'current' | 'not-migratable' | 'refused' | 'failed'} Status
 */

/** The reason codes that end a run without a result, with the status each one means. */
const REASON_STATUS = Object.freeze({
  'unrecognized-folder': 'not-migratable',
  'detect-only': 'not-migratable',
  'log-after-today': 'refused',
  'report-inside-tree': 'refused',
  'not-a-working-tree': 'refused',
  usage: 'refused',
  'import-failed': 'failed',
  'swap-failed': 'failed',
});

/** The rollback instructions every report carries. */
export const ROLLBACK_TEXT =
  'Every old file stays in the Git history. To undo a migration that was committed, revert that commit (git revert); to discard one that was not committed, restore the tree from Git.';

/**
 * @typedef {object} MigrateResult
 * @property {'foreign' | 'instance'} kind
 * @property {'dry-run' | 'apply'} mode
 * @property {boolean} applied whether the working tree was changed
 * @property {Status} status
 * @property {string | null} reason a reason code when the status is `failed`, otherwise null
 * @property {string} repo absolute path of the working tree
 * @property {import('./report.js').CheckResult[]} checks
 * @property {object} detail the kind-specific part of the report
 */

/**
 * @param {unknown} error
 * @returns {{ status: Status, reason: string, message: string }} how a refusal is classified; an error without a code is a plain `refused`
 */
export function classify(error) {
  const code = error instanceof UsageError ? error.code : undefined;
  const reason = code !== undefined && code in REASON_STATUS ? code : 'usage';
  return {
    status: /** @type {Status} */ (REASON_STATUS[/** @type {keyof typeof REASON_STATUS} */ (reason)]),
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Replace every root entry of `repo` except `.git` and `.github` with the entries of `instance`.
 * The old entries are parked in a sibling folder first and put back when anything fails, so a
 * failed swap leaves the tree as it was. A root `.gitignore` or `.gitattributes` the Instance does
 * not provide stays. When an old entry cannot be put back, every other one still is, and the error
 * names the parked folder that holds the old files.
 * @param {string} repo
 * @param {string} instance folder holding the finished Instance, on the same volume
 * @param {string} park absolute path of a folder that does not exist yet
 * @returns {Promise<void>}
 */
async function swapIntoTree(repo, instance, park) {
  const newNames = (await readdir(instance)).filter((n) => !KEPT_ENTRIES.includes(n));
  const oldNames = (await readdir(repo)).filter((n) => !KEPT_ENTRIES.includes(n) && !(KEPT_IF_ABSENT.includes(n) && !newNames.includes(n)));
  await mkdir(park);
  /** @type {string[]} */
  const parked = [];
  /** @type {string[]} */
  const placed = [];
  try {
    for (const name of oldNames) {
      await moveEntry(join(repo, name), join(park, name));
      parked.push(name);
    }
    for (const name of newNames) {
      await moveEntry(join(instance, name), join(repo, name));
      placed.push(name);
    }
  } catch (error) {
    const why = /** @type {Error} */ (error).message;
    /** @type {string[]} */
    const stuck = [];
    for (const name of placed) {
      try {
        await rm(join(repo, name), { recursive: true, force: true });
      } catch {
        stuck.push(name);
      }
    }
    for (const name of [...parked].reverse()) {
      try {
        await moveEntry(join(park, name), join(repo, name));
      } catch {
        stuck.push(name);
      }
    }
    if (stuck.length > 0) {
      throw new UsageError(
        `the swap failed (${why}) and the working tree is NOT fully restored: ${stuck.length} entr${stuck.length === 1 ? 'y' : 'ies'} (${stuck.join(', ')}) could not be put back. ` +
          `The old files are in the folder ${park}: move them back into ${repo} by hand, or restore the tree from Git`,
        'swap-failed',
      );
    }
    await rm(park, { recursive: true, force: true }).catch(() => {});
    throw new UsageError(`the swap failed (${why}); the working tree was restored`, 'swap-failed');
  }
  await rm(park, { recursive: true, force: true }).catch(() => {});
}

/**
 * Check the arguments and the folder; nothing is written.
 * @param {string} repoArg
 * @param {string | undefined} reportArg
 * @returns {Promise<{ repo: string, reportDir: string | undefined }>}
 * @throws {UsageError}
 */
async function checkArguments(repoArg, reportArg) {
  assertSafePathArgument(repoArg, 'repository');
  const repo = await requireDirectory(repoArg, 'repository');
  let reportDir;
  if (reportArg !== undefined) {
    assertSafePathArgument(reportArg, 'report');
    reportDir = resolveUserPath(reportArg);
    if (isInside(repo, reportDir)) {
      throw new UsageError(`the report folder lies inside the working tree: a report is never written into the tree; choose a folder outside it: ${reportDir}`, 'report-inside-tree');
    }
  }
  if (!(await exists(join(repo, '.git')))) {
    throw new UsageError(`not the root of a Git working tree, .git is missing: ${repo}; nothing was written`, 'not-a-working-tree');
  }
  return { repo, reportDir };
}

/**
 * @param {object} input
 * @param {string} input.repo absolute working tree root
 * @param {boolean} input.apply
 * @param {string} input.version
 * @param {string} input.today
 * @returns {Promise<MigrateResult>}
 */
async function migrateForeign({ repo, apply, version, today }) {
  const files = await listFiles(repo, { includeIgnored: true });
  /** @type {import('./migrate/detect.js').Adapter} */
  let adapter;
  try {
    ({ adapter } = await chooseAdapter(repo, files, 'auto', await loadAdapters()));
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(error.message, 'unrecognized-folder');
    throw error;
  }
  if (adapter.id === 'generic' || adapter.detectOnly === true) {
    throw new UsageError(
      `the folder is not an Instance and no vault framework with an adapter recognizes it (best match: ${adapter.id}); nothing was written. ` +
        'Import it into a new folder with `sbk import` instead',
      adapter.id === 'generic' ? 'unrecognized-folder' : 'detect-only',
    );
  }
  const tag = randomBytes(6).toString('hex');
  const scratch = join(dirname(repo), `.sbk-migrate-${tag}`);
  try {
    const result = await runImport({ source: repo, target: scratch, from: adapter.id, apply, verify: false, version, today });
    let applied = false;
    if (result.applied) {
      await swapIntoTree(repo, scratch, join(dirname(repo), `.sbk-migrate-old-${tag}`));
      applied = true;
    }
    const report = importReport(result, version);
    const imp = /** @type {any} */ (report).import;
    const quarantined = imp.entries
      .filter((/** @type {any} */ e) => e.outcome === 'quarantined')
      .map((/** @type {any} */ e) => ({
        source: e.source,
        destination: e.destination,
        patterns: (e.secrets ?? []).map((/** @type {any} */ s) => (s.field === undefined ? { pattern: s.pattern, line: s.line } : { pattern: s.pattern, field: s.field })),
      }));
    // The strict verification decides whether to swap. What the Doctor finds in the migrated tree is a
    // to-do list (ADR 0011, story 28), never a reason to fail: it is left out of the checks.
    const checks = result.checks.filter((c) => c.id !== 'import-doctor');
    const verified = !checks.some((c) => c.status === 'fail');
    /** @type {Status} */
    const status = !verified ? 'failed' : applied ? 'migrated' : 'planned';
    return {
      kind: 'foreign',
      mode: apply ? 'apply' : 'dry-run',
      applied,
      status,
      reason: verified ? null : 'verification-failed',
      repo,
      checks,
      detail: {
        adapter: imp.adapter,
        detection: imp.detection,
        counts: imp.counts,
        excluded_reasons: imp.excluded_reasons,
        quarantined,
        collisions: imp.collisions,
        unresolved_links: imp.unresolved_links.length,
        todo: imp.todo,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * @param {object} input
 * @param {string} input.repoArg working tree root as given
 * @param {boolean} input.apply
 * @param {string} [input.reportArg] report folder as given
 * @param {string} [input.template] template folder, for the upgrade of an Instance
 * @param {string} input.version
 * @param {string} input.today
 * @returns {Promise<{ result: MigrateResult, reportDir: string | undefined }>}
 * @throws {UsageError} for a refusal; nothing was written (`classify` gives its status and reason)
 */
export async function migrateVault({ repoArg, apply, reportArg, template, version, today }) {
  const { repo, reportDir } = await checkArguments(repoArg, reportArg);
  if (await exists(join(repo, ...LOCK_PATH.split('/')))) {
    const upgrade = await upgradeInstance({ vault: repo, template: await resolveTemplate(template), apply, version });
    const check = upgradeCheck(upgrade);
    const changed = upgrade.changes.some((c) => c.action !== 'unchanged');
    /** @type {Status} */
    const status = check.status === 'fail' ? 'failed' : !changed ? 'current' : apply ? 'upgraded' : 'planned';
    return {
      reportDir,
      result: {
        kind: 'instance',
        mode: apply ? 'apply' : 'dry-run',
        applied: apply,
        status,
        reason: check.status === 'fail' ? 'system-file-conflict' : null,
        repo,
        checks: [check],
        detail: { upgrade },
      },
    };
  }
  return { reportDir, result: await migrateForeign({ repo, apply, version, today }) };
}

/**
 * @param {MigrateResult} result
 * @param {string} version
 * @returns {import('./report.js').Report & { migrate: object }} the JSON report: the usual one plus a `migrate` field
 */
export function migrateReport(result, version) {
  const checks = result.checks.length > 0 ? result.checks : [checkResult('migrate', [finding('.', 'nothing', 'info', 'nothing to do')])];
  return {
    ...buildReport({ frameworkVersion: version, vault: result.repo, checks }),
    migrate: {
      status: result.status,
      reason: result.reason,
      kind: result.kind,
      mode: result.mode,
      applied: result.applied,
      kept: [...KEPT_ENTRIES],
      rollback: ROLLBACK_TEXT,
      ...result.detail,
    },
  };
}

/**
 * The JSON report of a run that ended in a refusal, so a caller that asked for JSON still gets a status.
 * @param {unknown} error what `migrateVault` threw
 * @param {string} repoArg the folder as given
 * @param {string} version
 * @returns {import('./report.js').Report & { migrate: object }}
 */
export function refusalReport(error, repoArg, version) {
  const { status, reason, message } = classify(error);
  const checks = [checkResult('migrate', [finding('.', reason, 'error', message)])];
  return {
    ...buildReport({ frameworkVersion: version, vault: repoArg, checks }),
    migrate: { status, reason, message, applied: false, kept: [...KEPT_ENTRIES] },
  };
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * A path or a message as a Markdown code span a hostile file name cannot break out of: control
 * characters and line breaks become `?`, a backtick becomes an apostrophe, and an at sign is followed
 * by a zero-width space, so the text creates no mention, link, image or heading.
 * @param {string} text
 * @returns {string}
 */
export function codeSpan(text) {
  const safe = String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?').replaceAll('`', "'").replaceAll('@', `@${ZERO_WIDTH_SPACE}`);
  return `\`${safe.length > 240 ? `${safe.slice(0, 240)}...` : safe}\``;
}

/** Most to-do items the Markdown report lists; the JSON report holds them all. */
const TODO_LIMIT = 100;

/**
 * @param {ReturnType<typeof migrateReport>} report
 * @returns {string} the Markdown report that becomes a pull request body
 */
export function reportMarkdown(report) {
  const m = /** @type {any} */ (report.migrate);
  const lines = [
    '# Vault migration report',
    '',
    `- Kind: ${m.kind === 'foreign' ? `old vault (adapter ${codeSpan(m.adapter)})` : 'Instance already on this framework (upgrade)'}`,
    `- Mode: ${m.mode}${m.applied ? ', applied' : ', nothing changed in the working tree'}`,
    `- Kept untouched: ${m.kept.map((/** @type {string} */ k) => `\`${k}\``).join(', ')}`,
    '',
  ];
  if (m.kind === 'foreign') {
    const c = m.counts;
    lines.push('## Counts', '', `${c.total} entries: ${c.mapped} mapped, ${c.preserved} preserved verbatim, ${c.excluded} excluded, ${c.quarantined} quarantined.`, '');
    lines.push('## Excluded', '');
    const reasons = Object.entries(m.excluded_reasons);
    lines.push(...(reasons.length === 0 ? ['None.'] : reasons.map(([reason, n]) => `- ${codeSpan(reason)}: ${n}`)), '');
    lines.push('## Quarantined (values are never shown)', '');
    lines.push(
      ...(m.quarantined.length === 0
        ? ['None.']
        : m.quarantined.map((/** @type {any} */ q) => `- ${codeSpan(q.source)} -> ${codeSpan(q.destination)} (${q.patterns.map((/** @type {any} */ p) => p.pattern).join(', ')})`)),
      '',
    );
    lines.push(`Unresolved links: ${m.unresolved_links}.`, '');
    lines.push('## To do after the migration', '');
    if (m.todo.length === 0) lines.push('None.');
    for (const item of m.todo.slice(0, TODO_LIMIT)) lines.push(`- [ ] ${item.severity}: ${codeSpan(item.path)} ${codeSpan(item.rule)} ${codeSpan(item.message)}`);
    if (m.todo.length > TODO_LIMIT) lines.push(`- and ${m.todo.length - TODO_LIMIT} more; the JSON report lists every one.`);
    lines.push('');
  } else {
    const changed = m.upgrade.changes.filter((/** @type {any} */ c) => c.action !== 'unchanged');
    lines.push('## Upgrade', '', `${m.upgrade.from_version} -> ${m.upgrade.to_version}: ${changed.length} System file(s) ${m.applied ? 'changed' : 'would change'}.`, '');
    lines.push(...changed.map((/** @type {any} */ c) => `- ${codeSpan(c.action)}: ${codeSpan(c.path)}`), '');
  }
  const s = report.summary;
  lines.push('## Verification', '', `Status ${codeSpan(m.status)}: ${s.checks} checks, ${s.passed} passed, ${s.failed} failed; ${s.errors} errors, ${s.warnings} warnings.`, '');
  lines.push('## Rollback', '', m.rollback, '');
  return lines.join('\n');
}
