import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The `npm run clip`, `pipeline` and `ingest` commands start their tools through a guard
// that compares the script path with the module URL. It must hold on every platform,
// or the command silently does nothing.
const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools');

describe('command line entrypoints', () => {
  it.each([
    ['clipper/clipper.js', 'Usage: node tools/clipper/clipper.js'],
    ['pipeline.js', 'Usage: node tools/pipeline.js'],
    ['rag/cli.js', 'node tools/rag/cli.js sync'],
  ])('%s prints its usage', (script, expected) => {
    const result = spawnSync(process.execPath, [path.join(tools, script), '--help'], { encoding: 'utf8' });
    expect(result.stdout + result.stderr).toContain(expected);
  });
});
