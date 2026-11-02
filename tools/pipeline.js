import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clipUrlOrHtml } from './clipper/clipper.js';
import activeProfile from './profiles/active.js';

/**
 * End-to-End Orchestrator:
 * Takes a single URL, clips it where the active profile files captures, then runs the profile's next step
 * (narr: ingest into Modular Dossiers; other profiles: refresh the search index).
 */
export async function runEndToEndPipeline({
  url,
  html = null,
  franchise = null,
  vaultRoot = process.cwd(),
  dryRun = false,
  profile = activeProfile,
}) {
  console.log(`[PIPELINE] Starting end-to-end processing for: ${url || 'HTML input'}`);

  // 1. Engine 1: Clip URL
  const clipResult = await clipUrlOrHtml({
    url,
    html,
    franchise,
    vaultRoot,
    dryRun,
    profile,
  });

  console.log(`[PIPELINE] Engine 1 complete: ${clipResult.status.toUpperCase()} -> ${clipResult.slug} (${clipResult.franchise})`);

  if (dryRun) {
    return {
      clipResult,
      ingestResult: null,
    };
  }

  // 2. Engine 2: the profile's next step
  const ingestResult = await profile.afterClip(clipResult, { vaultRoot });

  return {
    clipResult,
    ingestResult,
  };
}

// CLI entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let url = '';
  let franchise = null;
  let htmlPath = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node tools/pipeline.js <url> [--franchise <name>] [--html-file <path>] [--dry-run]');
      process.exit(0);
    } else if (args[i] === '--franchise' || args[i] === '-f') {
      franchise = args[++i];
    } else if (args[i] === '--html-file') {
      htmlPath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (!url && !args[i].startsWith('-')) {
      url = args[i];
    }
  }

  if (!url && !htmlPath) {
    console.log('Usage: node tools/pipeline.js <url> [--franchise <name>] [--html-file <path>] [--dry-run]');
    process.exit(1);
  }

  let htmlContent = null;
  if (htmlPath) {
    const fs = await import('node:fs');
    htmlContent = fs.readFileSync(htmlPath, 'utf8');
  }

  runEndToEndPipeline({ url, html: htmlContent, franchise, dryRun })
    .then(res => {
      console.log(`\n[SUCCESS] Pipeline successfully completed.`);
      console.log(`Source MD:   ${res.clipResult.mdPath}`);
      console.log(`Source JSON: ${res.clipResult.jsonPath}`);
      res.ingestResult?.dossiersAffected?.forEach(d => {
        console.log(`Dossier (${d.status.toUpperCase()}): ${d.filePath}`);
      });
    })
    .catch(err => {
      console.error('\n[PIPELINE FATAL ERROR]', err.message);
      process.exit(1);
    });
}
