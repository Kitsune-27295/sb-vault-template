/**
 * Verification: an independent re-read that recomputes instead of trusting. It lists the source
 * again, reads the target from disk, and for every entry re-derives the bytes the target must hold
 * from the SOURCE and the plan, with the same pure transform functions execution used
 * (`derive.js`), then compares (ADR 0011). A manifest that omits a hash, or a target edited after the
 * import, fails.
 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashBytes, hashContent } from '../hashing.js';
import { extractLinks, makeResolver } from '../links.js';
import { listVaultFiles } from '../paths.js';
import { LOG_DIR, readLog, verifyLog } from '../log.js';
import { finding } from '../report.js';
import { readSafeText } from '../safe-read.js';
import { displayPath as show } from '../secret-names.js';
import { readSidecar, sidecarPathFor } from '../sidecar.js';
import { MANIFEST_PATH } from '../zones.js';
import { makeDeriver } from './derive.js';
import { ARCHIVE_REASON, countOutcomes, foldName, isSafeDestination } from './plan.js';

/**
 * Plan-level invariants, against a fresh listing of the source: every file and link has exactly one
 * entry (an archived log has one more, kept whole), the counts add up, and no two entries share a destination.
 * @param {import('./plan.js').Plan} plan
 * @param {string[]} files every file and link of the source, listed now
 * @returns {import('../report.js').Finding[]}
 */
export function checkPlan(plan, files) {
  /** @type {import('../report.js').Finding[]} */
  const findings = [];
  const error = (/** @type {string} */ path, /** @type {string} */ rule, /** @type {string} */ message) => findings.push(finding(show(path), rule, 'error', message));
  const present = new Set(files);
  const primary = plan.entries.filter((e) => e.reason !== ARCHIVE_REASON);
  const seen = new Set();
  for (const entry of primary) {
    if (seen.has(entry.source)) error(entry.source, 'entry-duplicate', 'has more than one plan entry; a file gets exactly one outcome');
    seen.add(entry.source);
    if (!present.has(entry.source)) error(entry.source, 'entry-extra', 'has a plan entry but is not a file of the source');
  }
  for (const entry of plan.entries.filter((e) => e.reason === ARCHIVE_REASON)) {
    const log = primary.find((e) => e.source === entry.source);
    if (log === undefined || !log.transforms.some((t) => t.startsWith('log-chain'))) error(entry.source, 'archive-orphan', 'is archived as an original log but is not a chained log');
  }
  for (const file of files) {
    if (!seen.has(file)) error(file, 'entry-missing', 'has no plan entry, so it would be dropped without an outcome');
  }
  const counts = countOutcomes(plan.entries);
  const accounted = counts.mapped + counts.preserved + counts.excluded + counts.quarantined;
  if (accounted !== plan.entries.length) {
    error('.', 'counts-mismatch', `mapped + preserved + excluded + quarantined is ${accounted}, but the plan has ${plan.entries.length} entries`);
  }
  for (const key of /** @type {const} */ (['total', 'mapped', 'preserved', 'excluded', 'quarantined'])) {
    if (plan.counts !== undefined && plan.counts[key] !== counts[key]) error('.', 'counts-mismatch', `the recorded ${key} count is ${plan.counts[key]}, the entries give ${counts[key]}`);
  }
  const destinations = new Map();
  for (const entry of plan.entries) {
    if (entry.destination === null) {
      if (entry.outcome !== 'excluded') error(entry.source, 'outcome-invalid', `outcome ${entry.outcome} needs a destination`);
      continue;
    }
    if (entry.outcome === 'excluded' || !isSafeDestination(entry.destination)) error(entry.source, 'destination-unsafe', `destination ${entry.destination} is not a path inside a writable zone`);
    const key = foldName(entry.destination);
    if (destinations.has(key)) error(entry.source, 'destination-collision', `shares the destination ${entry.destination} with ${show(destinations.get(key))}`);
    destinations.set(key, entry.source);
  }
  return findings;
}

/**
 * Compare the target and the source with the plan, from disk.
 * @param {object} input
 * @param {string} input.root absolute source path
 * @param {string} input.target absolute Instance path
 * @param {import('./plan.js').Plan} input.plan
 * @param {string[]} input.reserved paths the Instance holds apart from the import (the template and the manifest)
 * @param {import('../schema.js').Schema} input.schema
 * @returns {Promise<import('../report.js').Finding[]>}
 */
export async function verifyTarget({ root, target, plan, reserved, schema }) {
  /** @type {import('../report.js').Finding[]} */
  const findings = [];
  const error = (/** @type {string} */ path, /** @type {string} */ rule, /** @type {string} */ message) => findings.push(finding(path, rule, 'error', message));
  const abs = (/** @type {string} */ base, /** @type {string} */ path) => join(base, ...path.split('/'));
  const derive = makeDeriver({ root, plan, reserved, schema });

  for (const entry of plan.entries) {
    if (entry.destination === null) continue;
    const name = show(entry.source);
    // The derivation runs for every entry, in plan order, so the chain of the old logs stays in step.
    /** @type {Awaited<ReturnType<typeof derive>> | null} */
    let derived = null;
    try {
      derived = await derive(entry);
    } catch (cause) {
      error(entry.destination, 'derive-failed', `the expected content of ${name} cannot be recomputed from the source: ${/** @type {Error} */ (cause).message}`);
    }
    const info = await lstat(abs(target, entry.destination)).catch(() => null);
    if (info === null || !info.isFile()) {
      error(entry.destination, 'destination-missing', `${name} was planned here as ${entry.outcome} but the target has no such file`);
      continue;
    }
    const written = await readFile(abs(target, entry.destination));
    const original = await readFile(abs(root, entry.source)).catch(() => null);
    if (original === null || hashBytes(original) !== entry.byte_sha256) {
      error(name, 'source-changed', 'the source file differs from the plan: it changed during the import, or is gone');
    }
    if (derived !== null && original !== null) {
      if (derived.text === null) {
        if (hashBytes(written) !== hashBytes(original)) error(entry.destination, 'bytes-differ', `the copy of ${name} does not have the source's bytes`);
      } else {
        if (!Buffer.from(derived.text, 'utf8').equals(written)) error(entry.destination, 'bytes-differ', `the written ${name} differs from what the source and the plan give`);
        if (entry.target_sha256 === undefined) error(entry.destination, 'target-hash-missing', `the manifest records no target_sha256 for ${name}, so the written file cannot be compared with what the import recorded`);
        else if (hashBytes(written) !== entry.target_sha256) error(entry.destination, 'bytes-differ', `the written ${name} differs from what the import recorded`);
      }
      if (derived.sidecar !== null) {
        const sidecar = await readFile(abs(target, sidecarPathFor(entry.destination))).catch(() => null);
        if (sidecar === null) error(sidecarPathFor(entry.destination), 'sidecar-invalid', `the sidecar of ${name} is missing`);
        else if (!Buffer.from(derived.sidecar, 'utf8').equals(sidecar)) error(sidecarPathFor(entry.destination), 'bytes-differ', `the sidecar of ${name} differs from what the plan gives`);
      }
    }
    if (entry.kind === 'raw-source' && entry.outcome === 'mapped') {
      const read = await readSidecar(abs(target, sidecarPathFor(entry.destination)));
      if ('problems' in read) error(sidecarPathFor(entry.destination), 'sidecar-invalid', read.problems.join('; '));
      else if (read.sidecar.sha256 !== hashContent(written)) error(entry.destination, 'hash-mismatch', 'the sidecar hash is not the hash of the bytes');
    }
  }

  // A rewritten link resolves in the Instance unless the plan lists it as unresolved.
  const files = await listVaultFiles(target);
  const resolver = makeResolver(files);
  const listed = new Set(plan.unresolved_links.map((l) => `${l.from}\0${l.kind}\0${l.target}`));
  for (const entry of plan.entries) {
    if (entry.destination === null || !entry.transforms.includes('links')) continue;
    const read = await readSafeText(abs(target, entry.destination));
    if (read.status !== 'ok') continue;
    for (const link of extractLinks(read.text)) {
      if (resolver.isBroken(link, entry.destination) && !listed.has(`${entry.source}\0${link.kind}\0${link.target}`)) {
        error(entry.destination, 'link-broken', `line ${link.line}: the link ${link.kind === 'wikilink' ? `[[${link.target}]]` : link.target} does not resolve after the move`);
      }
    }
  }

  // The manifest and the log entry exist and agree with the plan.
  const manifest = await readSafeText(abs(target, MANIFEST_PATH));
  if (manifest.status !== 'ok') {
    error(MANIFEST_PATH, 'manifest-missing', 'the import manifest is missing or unreadable');
  } else {
    try {
      const recorded = JSON.parse(manifest.text);
      const sources = new Set(Array.isArray(recorded.entries) ? recorded.entries.map((/** @type {{ source: string }} */ e) => e.source) : []);
      for (const entry of plan.entries) {
        if (!sources.has(show(entry.source))) error(MANIFEST_PATH, 'manifest-entry-missing', `does not list ${show(entry.source)}`);
      }
    } catch {
      error(MANIFEST_PATH, 'manifest-invalid', 'is not valid JSON');
    }
  }
  const log = await readLog(target);
  for (const problem of verifyLog(log)) {
    if (problem.severity === 'error') error(`${LOG_DIR}/${problem.file}`, problem.rule, problem.message);
  }
  if (!log.files.some((f) => f.entries.some((e) => / import \| /.test(e.header)))) {
    error(LOG_DIR, 'log-entry-missing', 'the log has no import entry');
  }
  return findings;
}
