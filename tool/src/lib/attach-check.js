/**
 * Check mode of `attach`: read-only verification of the wiring in a tool's global file. It reports
 * whether the Instance's block is present and current, whether the Instance and the CLI entry it
 * records still exist, and whether any marker is damaged, each with the command that repairs it.
 */
import { stat } from 'node:fs/promises';
import { buildBlock, parseRecorded, sameBlock } from './attach-block.js';
import { invocation } from './attach-paths.js';
import { repairCommand, skipMessage } from './attach.js';
import { requireInstance } from './instance.js';
import { stripEol } from './markdown.js';
import { slash } from './paths.js';
import { checkResult, finding } from './report.js';
import { LOCK_PATH } from './zones.js';

/** @param {string} path @returns {Promise<boolean>} */
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/** @param {string} path @returns {Promise<boolean>} true when the folder is an Instance */
const isInstance = (path) => requireInstance(path).then(() => true, () => false);

/**
 * @param {object} input
 * @param {import('./attach.js').Loaded} input.loaded the target, read
 * @param {import('./attach-paths.js').Identity} input.identity the Instance
 * @param {string | undefined} input.homeOption the `--home` value as given, repeated in repair commands
 * @returns {Promise<import('./report.js').CheckResult[]>}
 */
export async function checkWiring({ loaded, identity, homeOption }) {
  const file = slash(loaded.file);
  const instance = identity.path;
  const attachCommand = repairCommand({ verb: 'attach', instance, target: loaded.target, homeOption });
  const detachCommand = repairCommand({ verb: 'detach', instance, target: loaded.target, homeOption });

  if (loaded.skipped) {
    return [checkResult('attach-target', [finding(slash(loaded.dir), 'tool-not-installed', 'info', skipMessage(loaded))])];
  }
  const target = loaded.refusals.map((r) => finding(file, r.rule, 'error', `${r.message}; fix the file by hand, then run: ${attachCommand}`));
  const checks = [checkResult('attach-target', target)];
  if (loaded.refusals.length > 0) return checks;

  const found = loaded.scan.blocks.get(identity.key);
  const valid = await isInstance(instance);
  const wiring = [];
  const paths = [];
  if (!valid) {
    paths.push(finding(instance, 'instance-missing', 'error', `not an Instance, ${LOCK_PATH} is missing; to remove the wiring run: ${detachCommand}`));
  }
  if (found === undefined) {
    wiring.push(finding(file, 'block-missing', 'error', `no block for "${identity.key}"; to add it run: ${attachCommand}`));
  } else {
    const block = loaded.lines.slice(found.begin, found.end + 1).map(stripEol);
    const recorded = parseRecorded(block);
    if (recorded.cli !== null && !(await isFile(recorded.cli))) {
      paths.push(finding(recorded.cli, 'cli-missing', 'error', `the CLI entry recorded in the block no longer exists (the framework moved?); to repair run: ${attachCommand}`));
    }
    const current = buildBlock({ identity, ...invocation() });
    const same = valid && sameBlock(block, current);
    if (valid && !same) wiring.push(finding(file, 'block-stale', 'error', `the block for "${identity.key}" differs from what attach writes now; to repair run: ${attachCommand}`));
    if (same) wiring.push(finding(file, 'block-current', 'info', `the block for "${identity.key}" is present and current`));
  }
  checks.push(checkResult('attach-block', wiring), checkResult('attach-paths', paths));
  return checks;
}

/**
 * Join the checks of several targets into one result per check id, keeping the order of first appearance.
 * @param {import('./report.js').CheckResult[][]} perTarget the result of `checkWiring` for each target
 * @returns {import('./report.js').CheckResult[]}
 */
export function mergeChecks(perTarget) {
  /** @type {Map<string, import('./report.js').Finding[]>} */
  const byId = new Map();
  for (const check of perTarget.flat()) byId.set(check.id, [...(byId.get(check.id) ?? []), ...check.findings]);
  return [...byId].map(([id, findings]) => checkResult(id, findings));
}
