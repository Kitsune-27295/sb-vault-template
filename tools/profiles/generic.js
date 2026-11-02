import fs from 'node:fs';
import path from 'node:path';

/**
 * Builds an engine profile for a framework whose layout is a list of path prefixes.
 * The `narr` profile has its own module because its routing is not a prefix table.
 *
 * @param {object} config
 * @param {string} config.id
 * @param {Array<{zone: string, path: string, tier: 1|2|3|4|5, ptype: string}>} config.zones
 *   First prefix that matches a relative path wins. A path ending in `/` is a folder.
 * @param {string} config.heading  Title of the context packet.
 * @param {string} config.preface  Quoted note under the title.
 * @param {1|2|3|4|5} config.otherTier  Tier of a markdown file that matches no zone.
 * @param {Partial<Record<1|2|3|4|5, string>>} config.tierTitles  Only the tiers the profile uses.
 * @param {{dir: string, noteType: string}} config.clip  Where captures go and their note type.
 * @param {{dirs?: string[], files?: string[], budgets?: Array<{file: string, maxLines: number}>, relativePaths?: string}} config.doctor
 * @param {{zones: string, ptypes: string}} config.cli
 */
export function makeProfile(config) {
  const { id, zones, clip, doctor: doctorConfig = {} } = config;

  function classify(relPath, fm) {
    const normalized = relPath.replace(/\\/g, '/');
    const match = zones.find(z => normalized.startsWith(z.path));
    return {
      zone: match ? match.zone : 'Other',
      franchise: fm.franchise || null,
      ptype: fm.type || (match ? match.ptype : 'general'),
    };
  }

  function tierOf(doc) {
    const match = zones.find(z => z.zone === doc.zone);
    return match ? match.tier : config.otherTier;
  }

  function routeClip({ vaultRoot, explicitFranchise }) {
    if (explicitFranchise) {
      console.warn(`[CLIPPER] --franchise is ignored by the "${id}" profile.`);
    }
    return {
      group: id,
      sourcesDir: path.join(vaultRoot, ...clip.dir.split('/')),
      scaffold: () => {},
      noteType: clip.noteType,
      frontmatter: [],
      sidecar: {},
    };
  }

  /** Pipeline step after a capture: refresh the search index. */
  async function afterClip(clipResult, { vaultRoot }) {
    const { openVaultDatabase, syncVault } = await import('../rag/search.js');
    const dbPath = path.join(vaultRoot, '.scratch', 'vault_index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openVaultDatabase(dbPath);
    try {
      const stats = syncVault(vaultRoot, db);
      console.log(`[PIPELINE] Index refreshed: ${stats.indexed} indexed, ${stats.skipped} unchanged.`);
      return stats;
    } finally {
      db.close();
    }
  }

  function doctor(projectRoot, record) {
    for (const dir of doctorConfig.dirs || []) {
      const present = fs.existsSync(path.join(projectRoot, dir));
      record('Directory Architecture', `Folder: ${dir}/`, present, present ? 'Present' : 'Missing');
    }
    for (const file of doctorConfig.files || []) {
      const present = fs.existsSync(path.join(projectRoot, file));
      record('Required Files', file, present, present ? 'Present' : 'Missing');
    }
    for (const { file, maxLines } of doctorConfig.budgets || []) {
      const target = path.join(projectRoot, file);
      if (!fs.existsSync(target)) continue;
      const lines = fs.readFileSync(target, 'utf8').split('\n').length;
      record('Budgets', `${file} (<= ${maxLines} lines)`, lines <= maxLines, `Current lines: ${lines}`);
    }
    if (doctorConfig.relativePaths) {
      checkRelativePaths(projectRoot, doctorConfig.relativePaths, record);
    }
  }

  return {
    id,
    classify,
    tierOf,
    context: {
      heading: config.heading,
      preface: config.preface,
      tierTitles: config.tierTitles,
      banners: {},
      anchor: { zone: zones[0].zone, ptype: zones[0].ptype },
    },
    cli: {
      title: config.heading,
      zones: config.cli.zones,
      franchises: null,
      ptypes: config.cli.ptypes,
      anchorFlag: '--scene <path_to_anchor.md>',
    },
    clip: { route: routeClip },
    afterClip,
    doctor,
  };
}

/** The Path column (the last cell) of every table row of `file` must hold a relative path. */
function checkRelativePaths(projectRoot, file, record) {
  const target = path.join(projectRoot, file);
  if (!fs.existsSync(target)) return;
  const tableRows = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(line => /^\|.*\|\s*$/.test(line));
  const rows = tableRows.filter(line => !/^\|[\s|:-]+$/.test(line)); // drop the separator row
  const values = rows
    .slice(1) // header row
    .map(row => row.split('|').filter(cell => cell.trim() !== '').pop() || '')
    .map(cell => (cell.match(/`([^`]*)`/) || [])[1])
    .filter(Boolean);
  const absolute = values.filter(value => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('~'));
  record('Members', `${file} paths are relative`, absolute.length === 0, absolute.length ? `Absolute: ${absolute.join(', ')}` : `${values.length} path(s) checked`);
}
