/**
 * The import engine: detect, plan, execute, verify (ADR 0011). The source is only ever read. The
 * Instance is built in a temporary sibling folder of the target, verified there, and only then
 * renamed into place, so a failure leaves no target at all.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertEmptyOrMissing, createInstance } from '../create-instance.js';
import { UsageError } from '../errors.js';
import { byCodeUnit, listFiles } from '../files.js';
import { requireDirectory, requireInstance } from '../instance.js';
import { appendEntry } from '../log.js';
import { resolveUserPath, TEMPLATE_DIR } from '../paths.js';
import { buildReport, checkResult, finding } from '../report.js';
import { runChecks } from '../run-checks.js';
import { moveFolderInto } from '../safe-write.js';
import { loadSchema } from '../schema.js';
import { writeDerived } from '../derived.js';
import { MANIFEST_PATH } from '../zones.js';
import { chooseAdapter, loadAdapters } from './detect.js';
import { executePlan } from './execute.js';
import { buildManifest, readManifest, writeManifest } from './manifest.js';
import { assertSafePathArgument, assertSeparate } from './path-args.js';
import { buildPlan, countOutcomes, futureLogMonths, publicPlan, restoreSources } from './plan.js';
import { checkPlan, verifyTarget } from './verify.js';

/**
 * @typedef {object} ImportResult
 * @property {'dry-run' | 'apply' | 'verify'} mode
 * @property {boolean} applied whether the Instance was written
 * @property {boolean} [detectOnly] the vault was recognized as a framework that has no adapter yet; nothing was planned
 * @property {string} target absolute target path
 * @property {import('./detect.js').Detection} detection
 * @property {import('./plan.js').Plan} plan
 * @property {import('../report.js').CheckResult[]} checks
 * @property {import('../report.js').Finding[]} todo doctor findings the import could not fix (empty before `--apply`)
 */

/**
 * Everything in a folder, hidden and placeholder files included (an import accounts for every one),
 * and the symbolic links and junctions, which are listed but never followed.
 * @param {string} root
 * @returns {Promise<{ files: string[], links: string[], all: string[] }>} `all` is both, in code unit order
 */
async function listEverything(root) {
  /** @type {string[]} */
  const links = [];
  const files = await listFiles(root, { includeIgnored: true, onLink: (path) => links.push(path) });
  return { files, links, all: [...files, ...links].sort(byCodeUnit) };
}

/**
 * @param {import('../report.js').CheckResult[]} results doctor results
 * @returns {import('../report.js').Finding[]} the findings, each rule prefixed with its check id
 */
function doctorFindings(results) {
  return results.flatMap((check) => check.findings.map((f) => finding(f.path, `${check.id}:${f.rule}`, f.severity, f.message, f.line)));
}

/**
 * The checks of a result, in report order; a part that was not run is left out.
 * @param {{ detect: import('../report.js').Finding[], plan: import('../report.js').Finding[], verify?: import('../report.js').Finding[], doctor?: import('../report.js').Finding[] }} parts
 * @returns {import('../report.js').CheckResult[]}
 */
function importChecks({ detect, plan, verify, doctor }) {
  return [
    checkResult('import-detect', detect),
    checkResult('import-plan', plan),
    ...(verify === undefined ? [] : [checkResult('import-verify', verify)]),
    ...(doctor === undefined ? [] : [checkResult('import-doctor', doctor)]),
  ];
}

/** @returns {Promise<{ schema: import('../schema.js').Schema, reserved: string[] }>} the bundled schema and the paths a new Instance holds before the import */
async function bundled() {
  const { schema } = await loadSchema(TEMPLATE_DIR);
  if (schema === null) throw new Error('the bundled schema is invalid');
  return { schema, reserved: [...(await listEverything(TEMPLATE_DIR)).files, MANIFEST_PATH] };
}

/**
 * @param {object} input
 * @param {string} input.source source folder as given
 * @param {string} input.target target folder as given
 * @param {string} input.from adapter id or `auto`
 * @param {boolean} input.apply write the Instance (default: a dry run)
 * @param {boolean} input.verify only re-verify an Instance this command made
 * @param {string} input.version framework version
 * @param {string} input.today `YYYY-MM-DD`, the date of the log entry and of the lock
 * @returns {Promise<ImportResult>}
 * @throws {UsageError} for a refusal; nothing was written
 */
export async function runImport({ source: sourceArg, target: targetArg, from, apply, verify, version, today }) {
  assertSafePathArgument(sourceArg, 'source');
  assertSafePathArgument(targetArg, 'target');
  const root = await requireDirectory(sourceArg, 'source');
  const target = resolveUserPath(targetArg);
  assertSeparate(root, target);
  const { files, links, all } = await listEverything(root);

  if (verify) {
    await requireInstance(target);
    const read = await readManifest(target);
    const plan = restoreSources(read.plan, all);
    const { schema, reserved } = await bundled();
    const doctor = doctorFindings(await runChecks(target, today));
    const detect = [finding('.', 'adapter', 'info', `recorded adapter: ${plan.adapter}`)];
    const checks = importChecks({ detect, plan: checkPlan(plan, all), verify: await verifyTarget({ root, target, plan, reserved, schema }), doctor });
    return { mode: 'verify', applied: false, target, detection: { ...read.detection, candidates: [] }, plan, checks, todo: doctor.filter((f) => f.severity !== 'info') };
  }

  await assertEmptyOrMissing(target);
  const { adapter, detection } = await chooseAdapter(root, files, from, await loadAdapters());
  const mode = apply ? 'apply' : 'dry-run';
  if (adapter.detectOnly === true) {
    const advice = `detected ${adapter.id}, no adapter yet: use --from generic`;
    if (apply) {
      throw new UsageError(`${advice}; --apply refused because ${adapter.applyRefusal ?? 'this framework has no adapter'}. Nothing was written`);
    }
    const none = { adapter: adapter.id, entries: [], counts: countOutcomes([]), excluded_reasons: {}, collisions: [], unresolved_links: [] };
    const detect = [
      finding('.', 'adapter', 'info', `${adapter.id} (confidence ${detection.confidence}): ${detection.evidence.join('; ')}`),
      finding('.', 'no-adapter', 'info', advice),
    ];
    return { mode, applied: false, detectOnly: true, target, detection, plan: none, checks: [checkResult('import-detect', detect)], todo: [] };
  }

  const { schema, reserved } = await bundled();
  const plan = await buildPlan({ root, adapter, files, links, reserved });
  // Everything `--apply` would refuse is refused here too, in both modes, before anything is written.
  const future = futureLogMonths(plan, today);
  if (future.length > 0) {
    throw new UsageError(
      `the old log has entries for ${future.join(', ')}, later than the run date ${today}, and the Instance log is append-only: ` +
        `run again with --today set to a date in or after ${future.at(-1)}. Nothing was written`,
      'log-after-today',
    );
  }
  const planFindings = checkPlan(plan, all);
  const detect = [finding('.', 'adapter', 'info', `${adapter.id} (confidence ${detection.confidence}): ${detection.evidence.join('; ')}`)];
  if (!apply || planFindings.some((f) => f.severity === 'error')) {
    return { mode, applied: false, target, detection, plan, checks: importChecks({ detect, plan: planFindings }), todo: [] };
  }

  // Build beside the target, verify, then rename into place; any failure removes the folder.
  const staging = join(dirname(target), `.sbk-import-${randomBytes(6).toString('hex')}`);
  let moved = false;
  /** @type {import('../report.js').Finding[]} */
  let verified = [];
  try {
    await createInstance({ target: staging, template: TEMPLATE_DIR, version, createdAt: `${today}T00:00:00.000Z` });
    await executePlan({ root, target: staging, plan, reserved, schema });
    await writeManifest(staging, buildManifest({ version, plan, detection }));
    const c = plan.counts;
    await appendEntry({
      vault: staging,
      action: 'import',
      title: adapter.id,
      body: `Imported ${c.total} entries: ${c.mapped} mapped, ${c.preserved} preserved, ${c.excluded} excluded, ${c.quarantined} quarantined.\nManifest ${MANIFEST_PATH}`,
      date: today,
    });
    await writeDerived(staging);
    verified = await verifyTarget({ root, target: staging, plan, reserved, schema });
    if (!verified.some((f) => f.severity === 'error')) {
      await moveFolderInto(staging, target);
      moved = true;
    }
  } catch (error) {
    throw new UsageError(
      `the import failed (${/** @type {Error} */ (error).message}); the source was not touched and nothing was left at ${basename(target)}`,
      'import-failed',
    );
  } finally {
    if (!moved) await rm(staging, { recursive: true, force: true });
  }
  if (!moved) {
    return { mode, applied: false, target, detection, plan, checks: importChecks({ detect, plan: planFindings, verify: verified }), todo: [] };
  }

  const doctor = doctorFindings(await runChecks(target, today));
  return { mode, applied: true, target, detection, plan, checks: importChecks({ detect, plan: planFindings, verify: verified, doctor }), todo: doctor.filter((f) => f.severity !== 'info') };
}

/**
 * @param {ImportResult} result
 * @param {string} version framework version
 * @returns {import('../report.js').Report & { import: object }} the JSON report: the usual one plus an `import` field
 */
export function importReport(result, version) {
  const plan = publicPlan(result.plan);
  return {
    ...buildReport({ frameworkVersion: version, vault: result.target, checks: result.checks }),
    import: {
      mode: result.mode,
      applied: result.applied,
      detect_only: result.detectOnly === true,
      adapter: plan.adapter,
      detection: result.detection,
      counts: plan.counts,
      excluded_reasons: plan.excluded_reasons,
      collisions: plan.collisions,
      unresolved_links: plan.unresolved_links,
      manifest: result.applied ? MANIFEST_PATH : null,
      todo: result.todo.map((f) => ({ path: f.path, rule: f.rule, severity: f.severity, message: f.message })),
      entries: plan.entries.map(({ mtime: _mtime, ...entry }) => entry),
    },
  };
}
