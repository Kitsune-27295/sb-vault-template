import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { DatabaseSync } from 'node:sqlite';
import activeProfile from '../profiles/active.js';

/**
 * Initializes the SQLite database schema with documents and FTS5 full-text tables.
 * @param {DatabaseSync} db
 */
export function initDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      zone TEXT NOT NULL,
      franchise TEXT,
      ptype TEXT,
      tags TEXT,
      aliases TEXT,
      content TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      char_count INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title,
      aliases,
      tags,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

/**
 * Parses markdown frontmatter and content.
 * @param {string} rawContent
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
export function parseMarkdown(rawContent) {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: rawContent };
  }

  try {
    const frontmatter = yamlLoad(match[1]) || {};
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: rawContent };
  }
}

/**
 * Determines zone, franchise, and ptype from file path and frontmatter, using the
 * layout rules of the active profile (`tools/profiles/`).
 * @param {string} relPath
 * @param {Record<string, any>} fm
 * @param {{classify: Function}} [profile]
 */
export function classifyDocument(relPath, fm, profile = activeProfile) {
  return profile.classify(relPath, fm);
}

/**
 * Indexes a single document into SQLite and FTS5.
 * @param {DatabaseSync} db
 * @param {{ relPath: string, content: string, mtime?: number }} doc
 */
export function indexDocument(db, doc, profile = activeProfile) {
  const normalizedPath = doc.relPath.replace(/\\/g, '/');
  const { frontmatter, body } = parseMarkdown(doc.content);
  const { zone, franchise, ptype } = classifyDocument(normalizedPath, frontmatter, profile);

  const fallbackTitle = path.basename(normalizedPath, path.extname(normalizedPath)).replace(/_/g, ' ');
  const title = frontmatter.title || fallbackTitle;

  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.join(' ')
    : typeof frontmatter.tags === 'string'
      ? frontmatter.tags
      : '';

  const aliases = Array.isArray(frontmatter.aliases)
    ? frontmatter.aliases.join(' ')
    : typeof frontmatter.aliases === 'string'
      ? frontmatter.aliases
      : '';

  const mtime = doc.mtime || Date.now();
  const charCount = doc.content.length;

  // Check if document already exists
  const existing = db.prepare('SELECT id FROM documents WHERE rel_path = ?').get(normalizedPath);

  if (existing) {
    const docId = existing.id;
    db.prepare(`
      UPDATE documents
      SET title = ?, zone = ?, franchise = ?, ptype = ?, tags = ?, aliases = ?, content = ?, mtime = ?, char_count = ?
      WHERE id = ?
    `).run(title, zone, franchise, ptype, tags, aliases, body, mtime, charCount, docId);

    // Update FTS: delete old rowid and reinsert
    db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(docId);
    db.prepare(`
      INSERT INTO documents_fts (rowid, title, aliases, tags, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, title, aliases, tags, body);
  } else {
    const res = db.prepare(`
      INSERT INTO documents (rel_path, title, zone, franchise, ptype, tags, aliases, content, mtime, char_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(normalizedPath, title, zone, franchise, ptype, tags, aliases, body, mtime, charCount);

    const docId = res.lastInsertRowid;
    db.prepare(`
      INSERT INTO documents_fts (rowid, title, aliases, tags, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, title, aliases, tags, body);
  }
}

/**
 * Sanitizes a search query string for safe FTS5 matching.
 * @param {string} query
 * @returns {string}
 */
export function sanitizeFtsQuery(query) {
  if (!query || typeof query !== 'string') return '';
  // Extract alphanumeric tokens
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return '';
  // Combine tokens with OR for broad retrieval with BM25 ranking
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

/**
 * Executes a full-text search using BM25 ranking.
 * @param {DatabaseSync} db
 * @param {string} query
 * @param {{ zone?: string, franchise?: string, ptype?: string, limit?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function searchDocuments(db, query, options = {}) {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const { zone, franchise, ptype, limit = 20 } = options;

  let sql = `
    SELECT
      d.id,
      d.rel_path,
      d.title,
      d.zone,
      d.franchise,
      d.ptype,
      d.tags,
      d.aliases,
      d.char_count,
      bm25(documents_fts, 5.0, 3.0, 2.0, 1.0) AS rank,
      snippet(documents_fts, 3, '<b>', '</b>', '...', 16) AS snippet,
      d.content
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    WHERE documents_fts MATCH ?
  `;

  const params = [ftsQuery];

  if (zone) {
    sql += ' AND d.zone = ?';
    params.push(zone);
  }
  if (franchise) {
    sql += ' AND d.franchise = ?';
    params.push(franchise);
  }
  if (ptype) {
    sql += ' AND d.ptype = ?';
    params.push(ptype);
  }

  sql += ' ORDER BY rank ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Incrementally indexes all markdown files in the specified vault directory.
 * @param {string} vaultDir
 * @param {DatabaseSync} db
 * @returns {{ indexed: number, skipped: number, total: number }}
 */
export function syncVault(vaultDir, db, profile = activeProfile) {
  const ignoreDirs = new Set(['.git', '.scratch', 'node_modules', '.gemini', '.obsidian', '.vscode', '.claude', '.agents']);
  // Code and template skeletons live in the root tools/ folder; a folder named tools deeper in the vault is content.
  const isIgnored = (name, dir) => ignoreDirs.has(name) || name.startsWith('.') || (name === 'tools' && dir === vaultDir);
  const filesToIndex = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnored(entry.name, currentDir)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        filesToIndex.push(path.join(currentDir, entry.name));
      }
    }
  }

  walk(vaultDir);

  let indexed = 0;
  let skipped = 0;
  let deleted = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    const visitedPaths = new Set();
    const getStmt = db.prepare('SELECT mtime FROM documents WHERE rel_path = ?');

    for (const absPath of filesToIndex) {
      const relPath = path.relative(vaultDir, absPath).replace(/\\/g, '/');

      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch (err) {
        // The file vanished between the directory walk and the read (for example a
        // concurrent test fixture being removed): skip it instead of failing the sync.
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      visitedPaths.add(relPath);
      const existing = getStmt.get(relPath);

      if (existing && existing.mtime >= stat.mtimeMs) {
        skipped++;
        continue;
      }

      const content = fs.readFileSync(absPath, 'utf-8');
      indexDocument(db, {
        relPath,
        content,
        mtime: stat.mtimeMs,
      }, profile);
      indexed++;
    }

    // Prune removed files from documents and documents_fts
    const allRows = db.prepare('SELECT id, rel_path FROM documents').all();
    const deleteDocStmt = db.prepare('DELETE FROM documents WHERE id = ?');
    const deleteFtsStmt = db.prepare('DELETE FROM documents_fts WHERE rowid = ?');

    for (const row of allRows) {
      if (!visitedPaths.has(row.rel_path)) {
        deleteDocStmt.run(row.id);
        deleteFtsStmt.run(row.id);
        deleted++;
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { indexed, skipped, deleted, total: filesToIndex.length };
}

/**
 * Opens or initializes the SQLite database at the target path.
 * @param {string} [dbPath]
 * @returns {DatabaseSync}
 */
export function openVaultDatabase(dbPath) {
  const targetPath = dbPath || path.join(process.cwd(), '.scratch', 'vault_index.db');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new DatabaseSync(targetPath);
  initDatabase(db);
  return db;
}
