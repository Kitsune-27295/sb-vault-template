#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openVaultDatabase, syncVault, searchDocuments } from './search.js';
import { assembleContext } from './context-assembler.js';
import { runRagBenchmark } from './eval.js';
import profile from '../profiles/active.js';

function parseArgs(args) {
  const parsed = {
    command: args[0] || 'help',
    query: '',
    flags: {},
  };

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.flags[key] = next;
        i += 2;
      } else {
        parsed.flags[key] = true;
        i += 1;
      }
    } else {
      if (!parsed.query) {
        parsed.query = arg;
      } else {
        parsed.query += ` ${arg}`;
      }
      i++;
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
${profile.cli.title} (profile: ${profile.id})

Usage:
  node tools/rag/cli.js sync
    Incrementally syncs all markdown files into .scratch/vault_index.db

  node tools/rag/cli.js search "<query>" [options]
    Options:
      --zone <${profile.cli.zones}>
${profile.cli.franchises ? `      --franchise <${profile.cli.franchises}>
` : ''}      --ptype <${profile.cli.ptypes}>
      --limit <number> (default: 10)

  node tools/rag/cli.js context "<query>" [options]
    Options:
      ${profile.cli.anchorFlag}
      --budget <tokens> (default: 2500)
      --out <path_to_output.md>

  node tools/rag/cli.js eval [options]
    Options:
      --queries <path_to_queries.yaml> (default: eval/queries.yaml)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  const vaultDir = process.cwd();
  const db = openVaultDatabase();

  try {
    switch (parsed.command) {
      case 'sync': {
        console.log(`[RAG SYNC] Synchronizing vault at ${vaultDir}...`);
        const stats = syncVault(vaultDir, db);
        console.log(`[RAG SYNC] Done! Total files: ${stats.total}, Newly indexed: ${stats.indexed}, Skipped: ${stats.skipped}, Pruned/Deleted: ${stats.deleted || 0}`);
        break;
      }

      case 'search': {
        if (!parsed.query) {
          console.error('[RAG SEARCH ERROR] Please provide a search query.');
          process.exitCode = 1;
          return;
        }

        const options = {
          zone: parsed.flags.zone,
          franchise: parsed.flags.franchise,
          ptype: parsed.flags.ptype,
          limit: parsed.flags.limit ? parseInt(parsed.flags.limit, 10) : 10,
        };

        const results = searchDocuments(db, parsed.query, options);
        console.log(`\nFound ${results.length} results for: "${parsed.query}"\n`);
        for (let i = 0; i < results.length; i++) {
          const doc = results[i];
          console.log(`[${i + 1}] ${doc.title} (${doc.zone} / ${doc.franchise || 'General'} / ${doc.ptype})`);
          console.log(`    Path: ${doc.rel_path}`);
          console.log(`    Rank: ${doc.rank.toFixed(4)} | Characters: ${doc.char_count}`);
          if (doc.snippet) {
            console.log(`    Snippet: ${doc.snippet.replace(/<b>|<\/b>/g, '**')}`);
          }
          console.log();
        }
        break;
      }

      case 'context': {
        if (!parsed.query && !parsed.flags.scene) {
          console.error('[RAG CONTEXT ERROR] Please provide a query prompt or --scene file.');
          process.exitCode = 1;
          return;
        }

        const budgetTokens = parsed.flags.budget ? parseInt(parsed.flags.budget, 10) : 2500;
        const result = assembleContext({
          query: parsed.query || '',
          scenePath: parsed.flags.scene,
          budgetTokens,
          db,
        });

        if (parsed.flags.out) {
          const outPath = path.resolve(vaultDir, parsed.flags.out);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, result.contextText, 'utf-8');
          console.log(`[RAG CONTEXT] Output saved to ${outPath} (~${result.tokenEstimate} tokens, Tiers: ${result.packedTiers.join(', ')})`);
        } else {
          console.log(result.contextText);
          console.log(`\n<!-- Estimated tokens: ${result.tokenEstimate} | Packed Tiers: [${result.packedTiers.join(', ')}] | Sources: ${result.sources.length} -->`);
        }
        break;
      }

      case 'eval': {
        const queriesPath = parsed.flags.queries
          ? path.resolve(vaultDir, parsed.flags.queries)
          : path.join(vaultDir, 'eval', 'queries.yaml');

        console.log(`\n📊 [RAG EVAL] Running retrieval evaluation against: ${queriesPath}...\n`);
        const benchmark = runRagBenchmark(db, queriesPath);

        console.log(`Results across ${benchmark.queriesCount} queries:`);
        for (const res of benchmark.results) {
          const statusIcon = res.firstHitRank > 0 && res.firstHitRank <= 3 ? '✓' : res.firstHitRank > 0 ? '~' : '✗';
          console.log(`  ${statusIcon} Query: "${res.query}"`);
          console.log(`    Rank: ${res.firstHitRank > 0 ? `#${res.firstHitRank}` : 'NOT FOUND'} | Recall@5: ${(res.recallAt5 * 100).toFixed(1)}%`);
        }

        console.log(`\nBenchmark Summary:`);
        console.log(`  Mean Reciprocal Rank (MRR): ${benchmark.mrr.toFixed(4)}`);
        console.log(`  Average Recall@5:           ${(benchmark.avgRecallAt5 * 100).toFixed(1)}%\n`);
        break;
      }

      case 'help':
      default:
        printUsage();
        break;
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('[RAG CLI ERROR]', err);
  process.exit(1);
});

