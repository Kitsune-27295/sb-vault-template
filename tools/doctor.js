#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import activeProfile from './profiles/active.js';

// The lowest version of the lowest supported line; package.json `engines` and the docs say the same.
export const NODE_MINIMUM = '22.13';

// `node:sqlite` needs `--experimental-sqlite` before these minors of each line
// (nodejs.org/api/sqlite.html: "v23.4.0, v22.13.0: no longer behind --experimental-sqlite").
const UNFLAGGED_FROM_MINOR = { 22: 13, 23: 4 };

/**
 * @param {string} version A Node version such as `process.versions.node`.
 * @returns {boolean} True when `node:sqlite` works without a flag. Any later major qualifies.
 */
export function meetsNodeMinimum(version) {
  const [major, minor] = version.split('.').map(Number);
  if (major in UNFLAGGED_FROM_MINOR) return minor >= UNFLAGGED_FROM_MINOR[major];
  return major > 23;
}

export async function runDoctorChecks(projectRoot = process.cwd(), profile = activeProfile) {
  const results = {
    passed: true,
    checks: [],
  };

  function record(category, name, passed, details = '') {
    results.checks.push({ category, name, passed, details });
    if (!passed) results.passed = false;
  }

  // 1. Runtime & SQLite
  record('Runtime', `Node.js Version (>= ${NODE_MINIMUM})`, meetsNodeMinimum(process.versions.node), `Current: v${process.versions.node}`);

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE test (id INTEGER);');
    db.close();
    record('Runtime', 'Native SQLite (node:sqlite DatabaseSync)', true, 'Functional');
  } catch (err) {
    record('Runtime', 'Native SQLite (node:sqlite DatabaseSync)', false, err.message);
  }

  // 2. Layout checks of the active profile
  profile.doctor(projectRoot, record);

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  console.log(`\n🏥 [VAULT DOCTOR] Inspecting vault environment: ${root}\n`);
  runDoctorChecks(root).then(results => {
    let lastCat = '';
    for (const check of results.checks) {
      if (check.category !== lastCat) {
        console.log(`\n--- ${check.category} ---`);
        lastCat = check.category;
      }
      const icon = check.passed ? '✓' : '✗';
      console.log(`  ${icon} ${check.name.padEnd(45)} ${check.details}`);
    }

    console.log(`\nDiagnostic Summary: ${results.passed ? 'ALL CHECKS PASSED (HEALTHY)' : 'CRITICAL FINDINGS DETECTED'}\n`);
    process.exit(results.passed ? 0 : 1);
  });
}
