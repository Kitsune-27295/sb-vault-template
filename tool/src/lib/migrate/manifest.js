import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UsageError } from '../errors.js';
import { readSafeText } from '../safe-read.js';
import { MANIFEST_PATH } from '../zones.js';
import { publicPlan } from './plan.js';

/**
 * The manifest is the plan as it was carried out: every source path, its outcome, destination and
 * hashes, in source-path order. It holds no folder path and no time of its own; each entry keeps the
 * source file's modification time, because the written sidecars and defaults derive from it and
 * `--verify` recomputes them. Importing the same vault twice gives the same manifest. A source name
 * that matches a secret pattern appears redacted (`publicPlan`).
 * @param {object} input
 * @param {string} input.version framework version
 * @param {import('./plan.js').Plan} input.plan after execution
 * @param {{ confidence: number, evidence: string[] }} input.detection
 * @returns {object}
 */
export function buildManifest({ version, plan, detection }) {
  const shown = publicPlan(plan);
  return {
    manifest_version: 1,
    framework_version: version,
    adapter: shown.adapter,
    detection: { confidence: detection.confidence, evidence: detection.evidence },
    counts: shown.counts,
    excluded_reasons: shown.excluded_reasons,
    collisions: shown.collisions,
    unresolved_links: shown.unresolved_links,
    entries: shown.entries,
  };
}

/**
 * @param {string} target absolute Instance path
 * @param {object} manifest
 * @returns {Promise<void>}
 */
export async function writeManifest(target, manifest) {
  const path = join(target, ...MANIFEST_PATH.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

/**
 * Read the manifest of an Instance as the plan to verify it against.
 * @param {string} target absolute Instance path
 * @returns {Promise<{ plan: import('./plan.js').Plan, detection: { adapter: string, confidence: number, evidence: string[] } }>}
 * @throws {UsageError} when there is no readable manifest
 */
export async function readManifest(target) {
  const read = await readSafeText(join(target, ...MANIFEST_PATH.split('/')));
  if (read.status !== 'ok') throw new UsageError(`${MANIFEST_PATH} is missing or unreadable: ${target}; only an Instance made by import has one`);
  let manifest;
  try {
    manifest = JSON.parse(read.text);
  } catch {
    throw new UsageError(`${MANIFEST_PATH} is not valid JSON: ${target}`);
  }
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries) || typeof manifest.adapter !== 'string') {
    throw new UsageError(`${MANIFEST_PATH} is not an import manifest: ${target}`);
  }
  return {
    plan: {
      adapter: manifest.adapter,
      entries: manifest.entries,
      counts: manifest.counts,
      excluded_reasons: manifest.excluded_reasons ?? {},
      collisions: manifest.collisions ?? [],
      unresolved_links: manifest.unresolved_links ?? [],
    },
    detection: { adapter: manifest.adapter, ...(manifest.detection ?? { confidence: 0, evidence: [] }) },
  };
}
