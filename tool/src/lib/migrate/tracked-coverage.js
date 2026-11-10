/**
 * The old tree's tracked paths against the manifest (ADR 0013): every path that Git tracks must be a
 * manifest source, or its content is lost in the swap. On a case-insensitive filesystem the name on disk
 * can differ in case from the name Git tracks (the file was created with one case and committed with
 * another). Such a file is covered by its manifest source and reported as information, never as a loss.
 * A tracked name that is also on disk under its exact name is a different file: it is never covered by
 * a case-only match, on any filesystem.
 */
import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { trackedPaths } from './git-index.js';
import { checkResult, finding } from '../report.js';

export { trackedPaths };

/**
 * The comparison key of a path: Unicode NFC, lower case.
 * @param {string} path
 * @returns {string}
 */
export const foldPath = (path) => path.normalize('NFC').toLowerCase();

/**
 * Compare the tracked paths with the manifest sources. A tracked path that matches a source only in case is
 * returned as a candidate: the caller decides whether its exact name is on disk.
 * @param {string[]} tracked
 * @param {string[]} sources the manifest sources
 * @returns {{ exact: number, folded: { tracked: string, source: string }[], missing: string[] }}
 */
export function compareTracked(tracked, sources) {
  const exact = new Set(sources);
  /** @type {Map<string, string>} */
  const byFolded = new Map();
  for (const source of sources) if (!byFolded.has(foldPath(source))) byFolded.set(foldPath(source), source);
  let exactCount = 0;
  /** @type {{ tracked: string, source: string }[]} */
  const folded = [];
  /** @type {string[]} */
  const missing = [];
  for (const path of tracked) {
    if (exact.has(path)) {
      exactCount += 1;
      continue;
    }
    const source = byFolded.get(foldPath(path));
    if (source === undefined) missing.push(path);
    else folded.push({ tracked: path, source });
  }
  return { exact: exactCount, folded, missing };
}

/**
 * Whether a path is on disk under exactly this name. The folder listing answers it on every filesystem: a
 * case-insensitive lookup would find `VirtIO.md` for `VIRTIO.md`, the listing does not.
 * @param {string} repo working tree root
 * @param {string} path tracked path, forward slashes
 * @param {Map<string, Set<string>>} listings folder listings already read
 * @returns {Promise<boolean>}
 */
async function onDiskExactly(repo, path, listings) {
  const folder = posix.dirname(path);
  let names = listings.get(folder);
  if (names === undefined) {
    // A folder that does not exist holds no file; any other failure to read it is an error, never "not on disk".
    names = new Set(await readdir(join(repo, ...folder.split('/'))).catch((error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
      throw error;
    }));
    listings.set(folder, names);
  }
  return names.has(posix.basename(path));
}

/**
 * The `tracked-coverage` check of a migration.
 * @param {string} repo working tree root
 * @param {string[]} sources the sources of the manifest entries
 * @returns {Promise<{ check: import('../report.js').CheckResult, covered: boolean, reason: string | null, summary: object | null }>}
 */
export async function trackedCoverage(repo, sources) {
  let tracked;
  try {
    tracked = await trackedPaths(repo);
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    const check = checkResult('tracked-coverage', [finding('.', 'git-unreadable', 'error', `the Git entry cannot be read, so the tracked paths cannot be checked: ${message}`)]);
    return { check, covered: false, reason: 'git-unreadable', summary: null };
  }
  if (tracked === null) {
    const check = checkResult('tracked-coverage', [finding('.', 'not-a-repository', 'info', 'the folder has no Git entry here, so its tracked paths were not compared')]);
    return { check, covered: true, reason: null, summary: null };
  }
  const { exact, folded, missing } = compareTracked(tracked, sources);
  /** @type {Map<string, Set<string>>} */
  const listings = new Map();
  const caseOnly = [];
  const uncovered = [...missing];
  for (const candidate of folded) {
    if (await onDiskExactly(repo, candidate.tracked, listings)) uncovered.push(candidate.tracked);
    else caseOnly.push(candidate);
  }
  uncovered.sort();
  const findings = [
    ...caseOnly.map((c) => finding(c.tracked, 'case-only', 'info', `tracked as ${c.tracked}, on disk as ${c.source}: covered by that manifest source`)),
    ...uncovered.map((path) =>
      finding(path, 'tracked-not-covered', 'error', 'a tracked file has no manifest source, so the swap would lose it: restore it or commit its deletion, then migrate again'),
    ),
  ];
  const check = checkResult('tracked-coverage', findings);
  const covered = check.status === 'pass';
  return {
    check,
    covered,
    reason: covered ? null : 'tracked-not-covered',
    summary: { tracked: tracked.length, exact, case_only: caseOnly.length, uncovered: uncovered.length },
  };
}
