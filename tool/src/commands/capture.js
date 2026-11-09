import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLogWritable, captureDropFolder, captureFile, DROP_DIR } from '../lib/capture.js';
import { isDerivedFresh, writeDerived } from '../lib/derived.js';
import { UsageError } from '../lib/errors.js';
import { requireInstance } from '../lib/instance.js';
import { buildReport, checkResult, exitCodeFor, finding, formatHuman, formatJson } from '../lib/report.js';
import { toReportFindings } from '../lib/secrets.js';

export const name = 'capture';
export const summary = 'Seal a local file (or the inbox drop folder) into the raw sources, scanning for secrets';
export const usage = '<vault> (--file <path> | --inbox) [--origin <text>] [--supersedes <source-id>]';
export const options = {
  file: { type: /** @type {'string'} */ ('string') },
  inbox: { type: /** @type {'boolean'} */ ('boolean') },
  origin: { type: /** @type {'string'} */ ('string') },
  supersedes: { type: /** @type {'string'} */ ('string') },
};

/**
 * @param {string} path
 * @param {string} what for the error message
 * @param {'directory' | 'file'} kind
 */
async function assertKind(path, what, kind) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new UsageError(`${what} not found: ${path}`);
  }
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new UsageError(`${what} is not a ${kind}: ${path}`);
  }
}

/** @param {import('../cli.js').CommandContext} ctx */
export async function run(ctx) {
  if (ctx.args.length !== 1) throw new UsageError('capture needs exactly one argument: <vault>');
  const { file, inbox, origin, supersedes } = ctx.values;
  if ((file === undefined) === (inbox !== true)) {
    throw new UsageError('capture needs exactly one of --file <path> or --inbox');
  }
  if (supersedes !== undefined) {
    if (supersedes.trim() === '') throw new UsageError('--supersedes must not be empty');
    if (file === undefined) throw new UsageError('--supersedes needs --file <path>; it cannot be combined with --inbox');
  }
  if (origin !== undefined && origin.trim() === '') throw new UsageError('--origin must not be empty');
  const vault = await requireInstance(ctx.args[0]);
  if (file !== undefined) await assertKind(resolve(file), 'file', 'file');
  await assertLogWritable(vault);
  // Capture changes the inputs of derived state (sources, inbox, log); keep fresh state fresh.
  const wasFresh = await isDerivedFresh(vault);

  /** @type {import('../lib/capture.js').CaptureResult[]} */
  let results;
  if (file !== undefined) {
    const result = await captureFile({ vault, file: resolve(file), origin, supersedes: supersedes?.trim() });
    if (result.status === 'duplicate') {
      throw new UsageError(`already captured as ${result.path}; nothing was written`);
    }
    results = [result];
  } else {
    results = await captureDropFolder({ vault, origin });
  }
  if (wasFresh) await writeDerived(vault);

  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  for (const r of results) {
    if (r.status === 'quarantined') {
      findings.push(...toReportFindings(r.findings.map((f) => ({ ...f, path: r.path }))));
    } else if (r.status === 'duplicate') {
      findings.push(
        finding(`${DROP_DIR}/${r.originalName}`, 'already-captured', 'warning', `already captured as ${r.path}; the file was left in the drop folder`),
      );
    }
  }
  const report = buildReport({
    frameworkVersion: ctx.version,
    vault,
    checks: [checkResult('capture', findings)],
  });
  const captures = results.map((r) => ({
    status: r.status,
    source_id: r.sourceId,
    original_name: r.originalName,
    path: r.path,
    ...(r.supersedes === undefined ? {} : { supersedes: r.supersedes }),
  }));
  if (ctx.json) {
    ctx.print(formatJson({ ...report, captures }));
  } else {
    const lines = results.map((r) => `${r.status}: ${r.originalName} -> ${r.path}`);
    if (results.length === 0) lines.push(`nothing to seal in ${DROP_DIR}`);
    ctx.print(`${lines.join('\n')}\n\n${formatHuman(report)}`);
  }
  return exitCodeFor(report);
}
