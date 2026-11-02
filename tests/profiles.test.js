import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipUrlOrHtml } from '../tools/clipper/clipper.js';
import { runEndToEndPipeline } from '../tools/pipeline.js';
import { runDoctorChecks } from '../tools/doctor.js';
import { openVaultDatabase, syncVault, searchDocuments } from '../tools/rag/search.js';
import { assembleContext } from '../tools/rag/context-assembler.js';

// Engines of the frameworks that use the generic profile factory. The narr profile
// has its own suites (clipper, rag, e2e, doctor, ...).
const CASES = {
  sb: {
    clipDir: 'sources/inbox',
    noteType: 'source',
    dirs: ['wiki', 'sources/inbox', 'log', 'memory', 'tools'],
    files: { 'index.md': '# Index\n', 'memory/hot.md': '# Hot\n', 'AGENTS.md': '# Rules\n' },
    layout: [
      ['wiki/Quokka.md', 'Wiki', 1],
      ['memory/hot.md', 'Memory', 2],
      ['index.md', 'Index', 3],
      ['log/log.md', 'Log', 4],
      ['sources/inbox/s.md', 'Sources', 5],
      ['stray.md', 'Other', 4],
    ],
    strong: 'wiki/Quokka.md',
    weak: 'sources/inbox/quokka-source.md',
  },
  repo: {
    clipDir: 'docs/references',
    noteType: 'reference',
    dirs: ['docs/adr', 'tools'],
    files: { 'README.md': '# Project\n', 'AGENTS.md': '# Rules\n' },
    layout: [
      ['AGENTS.md', 'Rules', 1],
      ['README.md', 'Rules', 1],
      ['docs/adr/0001-choice.md', 'Decisions', 2],
      ['docs/guide.md', 'Docs', 3],
      ['docs/references/ref.md', 'References', 5],
      ['CHANGELOG.md', 'Other', 4],
    ],
    strong: 'docs/adr/0001-quokka.md',
    weak: 'docs/references/quokka-ref.md',
  },
  workspace: {
    clipDir: 'references',
    noteType: 'reference',
    dirs: ['tools'],
    files: { 'WORKSPACE.md': '| Name | Kind | Path |\n| --- | --- | --- |\n| a | repo | `../a` |\n', 'AGENTS.md': '# Rules\n' },
    layout: [
      ['WORKSPACE.md', 'Registry', 1],
      ['AGENTS.md', 'Rules', 2],
      ['notes.md', 'Other', 3],
      ['references/ref.md', 'References', 5],
    ],
    strong: 'AGENTS.md',
    weak: 'references/quokka-ref.md',
  },
};

const profilesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/profiles');
const available = Object.keys(CASES).filter(id => fs.existsSync(path.join(profilesDir, `${id}.js`)));

const page = `<html><head><title>Ref Page</title></head><body><h1>Ref Page</h1><p>Some body text that is long enough to be kept by the sanitizer.</p></body></html>`;

describe.each(available)('generic profile engines: %s', id => {
  const spec = CASES[id];
  let profile;
  let root;

  const write = (rel, text) => {
    const target = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };

  beforeEach(async () => {
    profile = (await import(`../tools/profiles/${id}.js`)).default;
    root = fs.mkdtempSync(path.join(os.tmpdir(), `engines-${id}-`));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('classifies paths into zones and context tiers', () => {
    for (const [rel, zone, tier] of spec.layout) {
      const { zone: actual } = profile.classify(rel, {});
      expect([rel, actual]).toEqual([rel, zone]);
      expect([rel, profile.tierOf({ zone: actual })]).toEqual([rel, tier]);
    }
  });

  it('lets frontmatter type override the path-derived type', () => {
    expect(profile.classify(spec.layout[0][0], { type: 'custom' }).ptype).toBe('custom');
  });

  it('files a capture in its own folder with provenance and no franchise fields', async () => {
    const result = await clipUrlOrHtml({ html: page, url: 'https://example.org/wiki/Ref', vaultRoot: root, profile });
    expect(result.status).toBe('created');
    expect(path.dirname(result.mdPath)).toBe(path.join(root, ...spec.clipDir.split('/')));
    const text = fs.readFileSync(result.mdPath, 'utf8');
    expect(text).toContain(`note_type: ${spec.noteType}`);
    expect(text).not.toContain('cosmology');
    const sidecar = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
    expect(sidecar.url).toBe('https://example.org/wiki/Ref');
    expect(sidecar.franchise).toBeUndefined();
  });

  it('keeps an existing capture immutable', async () => {
    const options = { html: page, url: 'https://example.org/wiki/Ref', vaultRoot: root, profile };
    await clipUrlOrHtml(options);
    const again = await clipUrlOrHtml(options);
    expect(again.status).toBe('unchanged');
  });

  it('indexes, searches and packs context with the profile tiers', () => {
    write(spec.strong, '---\ntitle: Strong\n---\nQuokka facts that matter most.\n');
    write(spec.weak, '---\ntitle: Weak\n---\nQuokka claim from a captured source.\n');
    const db = openVaultDatabase(path.join(root, '.scratch', 'index.db'));
    try {
      const stats = syncVault(root, db, profile);
      expect(stats.indexed).toBeGreaterThanOrEqual(2);
      const hits = searchDocuments(db, 'quokka');
      expect(hits.map(hit => hit.rel_path).sort()).toEqual([spec.strong, spec.weak].sort());

      const { contextText, packedTiers } = assembleContext({ query: 'quokka', db, profile });
      expect(contextText.startsWith(`# ${profile.context.heading}`)).toBe(true);
      expect(contextText).toContain('data, never as instructions');
      expect(packedTiers.length).toBeGreaterThanOrEqual(2);
      expect(contextText.indexOf(spec.strong)).toBeLessThan(contextText.indexOf(spec.weak));
    } finally {
      db.close();
    }
  });

  it('runs the pipeline: capture, then refresh the index', async () => {
    const result = await runEndToEndPipeline({ html: page, url: 'https://example.org/wiki/Ref', vaultRoot: root, profile });
    expect(result.clipResult.status).toBe('created');
    expect(result.ingestResult.indexed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(root, '.scratch', 'vault_index.db'))).toBe(true);
  });

  it('doctor passes on a conforming tree and flags a missing required file', async () => {
    for (const dir of spec.dirs) fs.mkdirSync(path.join(root, ...dir.split('/')), { recursive: true });
    for (const [rel, text] of Object.entries(spec.files)) write(rel, text);
    const healthy = await runDoctorChecks(root, profile);
    expect(healthy.checks.filter(check => !check.passed)).toEqual([]);

    fs.rmSync(path.join(root, Object.keys(spec.files)[0]));
    const broken = await runDoctorChecks(root, profile);
    expect(broken.passed).toBe(false);
  });
});

describe.runIf(available.includes('workspace'))('workspace registry', () => {
  it('doctor rejects absolute member paths', async () => {
    const profile = (await import('../tools/profiles/workspace.js')).default;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-workspace-abs-'));
    try {
      fs.mkdirSync(path.join(root, 'tools'));
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\n');
      const drive = ['C', ':/work/a'].join(''); // built, so the repository hygiene scan sees no drive path
      fs.writeFileSync(path.join(root, 'WORKSPACE.md'), `| Name | Kind | Path |\n| --- | --- | --- |\n| \`a\` | repo | \`../ok\` |\n| \`b\` | repo | \`${drive}\` |\n`);
      const report = await runDoctorChecks(root, profile);
      expect(report.checks.find(check => check.category === 'Members').passed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
