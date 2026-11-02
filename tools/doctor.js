#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import activeProfile from './profiles/active.js';

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
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  record('Runtime', 'Node.js Version (>= 22)', nodeMajor >= 22, `Current: v${process.versions.node}`);

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
