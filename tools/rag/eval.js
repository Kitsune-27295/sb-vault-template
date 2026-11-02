import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { searchDocuments } from './search.js';

/**
 * Runs retrieval evaluation benchmark against golden queries.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} queriesPath
 * @returns {{ queriesCount: number, avgRecallAt5: number, mrr: number, results: Array<any> }}
 */
export function runRagBenchmark(db, queriesPath) {
  if (!fs.existsSync(queriesPath)) {
    throw new Error(`Queries file not found at: ${queriesPath}`);
  }

  const raw = fs.readFileSync(queriesPath, 'utf8');
  const testSet = yamlLoad(raw);

  if (!Array.isArray(testSet)) {
    throw new Error('Benchmark queries must be an array of query definitions');
  }

  let totalReciprocalRank = 0;
  let totalRecallAt5 = 0;
  const detailedResults = [];

  for (const item of testSet) {
    const query = item.query;
    const expected = item.expect || [];
    const hits = searchDocuments(db, query, { limit: 10 });

    let firstHitRank = 0;
    const foundExpectedAt5 = new Set();

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const hitIdentifiers = [
        hit.title || '',
        path.basename(hit.rel_path || '', '.md'),
        hit.rel_path || '',
      ];

      for (const exp of expected) {
        const matches = hitIdentifiers.some(id => id.toLowerCase().includes(exp.toLowerCase()));
        if (matches) {
          if (firstHitRank === 0) firstHitRank = i + 1;
          if (i < 5) foundExpectedAt5.add(exp.toLowerCase());
          break;
        }
      }
    }

    const rr = firstHitRank > 0 ? 1 / firstHitRank : 0;
    const recallAt5 = expected.length > 0 ? foundExpectedAt5.size / expected.length : 0;

    totalReciprocalRank += rr;
    totalRecallAt5 += recallAt5;

    detailedResults.push({
      query,
      expected,
      firstHitRank,
      reciprocalRank: rr,
      recallAt5,
      retrievedCount: hits.length,
    });
  }

  const mrr = testSet.length > 0 ? totalReciprocalRank / testSet.length : 0;
  const avgRecallAt5 = testSet.length > 0 ? totalRecallAt5 / testSet.length : 0;

  return {
    queriesCount: testSet.length,
    avgRecallAt5,
    mrr,
    results: detailedResults,
  };
}

