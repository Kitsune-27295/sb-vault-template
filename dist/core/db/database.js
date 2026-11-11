import DatabaseConstructor from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
// Bump when the table layout changes: an index written by another version is dropped and rebuilt.
const SCHEMA_VERSION = 2;
// A wikilink may name a note by its vault-relative path (`[[50-ops/hot]]`), which is how
// Obsidian resolves folder-qualified links; the path without `.md` is a valid target too.
// Obsidian also matches link targets without regard to letter case, so the comparisons lower-case.
const pathWithoutExtension = (column) => `CASE WHEN lower(${column}) LIKE '%.md' THEN substr(${column}, 1, length(${column}) - 3) ELSE ${column} END`;
const NOTE_PATH_NO_EXT = pathWithoutExtension("file_path");
export class VaultDatabase {
    db;
    constructor(dbPath = ":memory:") {
        if (dbPath !== ":memory:") {
            mkdirSync(dirname(dbPath), { recursive: true });
        }
        this.db = new DatabaseConstructor(dbPath);
        this.configurePragmas();
        this.initSchema();
    }
    configurePragmas() {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("foreign_keys = ON");
    }
    initSchema() {
        // The index is a rebuildable cache. Version 2 keys each full-text row by the node's rowid, so
        // a note can be re-indexed without scanning the whole FTS table; an older cache is discarded.
        if (this.db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION) {
            this.db.exec(`
        DROP TABLE IF EXISTS context_chunks;
        DROP TABLE IF EXISTS node_edges;
        DROP TABLE IF EXISTS nodes_fts;
        DROP TABLE IF EXISTS note_paths;
        DROP TABLE IF EXISTS nodes;
      `);
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        uid TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        epistemic_confidence REAL NOT NULL DEFAULT 0.5,
        para_category TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        raw_yaml TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS node_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_uid TEXT NOT NULL,
        target_uid TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        context_snippet TEXT,
        is_broken_link INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(source_uid) REFERENCES nodes(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON node_edges(source_uid);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON node_edges(target_uid);

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        uid,
        title,
        aliases,
        tags,
        summary,
        markdown_body,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS context_chunks (
        chunk_id TEXT PRIMARY KEY,
        node_uid TEXT NOT NULL,
        tier TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        rendered_context TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(node_uid) REFERENCES nodes(uid) ON DELETE CASCADE
      );

      -- Every note's vault-relative path (lower-cased, without .md). Notes are keyed by file
      -- name, so two files with the same name share one node row; their paths stay distinct here.
      CREATE TABLE IF NOT EXISTS note_paths (
        path_key TEXT PRIMARY KEY
      );
    `);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    upsertNode(parsed, filePath) {
        const fm = parsed.frontmatter;
        const now = new Date().toISOString();
        const determinePara = (type) => {
            if (type === "project")
                return "projects";
            if (type === "area")
                return "areas";
            if (type === "resource")
                return "resources";
            if (type === "archive")
                return "archives";
            return null;
        };
        const runTransaction = this.db.transaction(() => {
            this.db
                .prepare("INSERT OR IGNORE INTO note_paths (path_key) VALUES (?)")
                .run(filePath.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase());
            // 1. Upsert into nodes
            const stmtNode = this.db.prepare(`
        INSERT INTO nodes (
          uid, type, title, status, epistemic_confidence,
          para_category, file_path, content_hash, raw_yaml, updated_at
        ) VALUES (
          @uid, @type, @title, @status, @epistemic_confidence,
          @para_category, @file_path, @content_hash, @raw_yaml, @updated_at
        )
        ON CONFLICT(uid) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          status = excluded.status,
          epistemic_confidence = excluded.epistemic_confidence,
          para_category = excluded.para_category,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          raw_yaml = excluded.raw_yaml,
          updated_at = excluded.updated_at
      `);
            stmtNode.run({
                uid: fm.uid,
                type: fm.type,
                title: fm.title,
                status: fm.status,
                epistemic_confidence: fm.epistemic_confidence ?? 0.5,
                para_category: determinePara(fm.type),
                file_path: filePath,
                content_hash: parsed.contentHash,
                raw_yaml: parsed.rawYaml,
                updated_at: now
            });
            // 2. Refresh FTS5, keyed by the node's rowid (deleting `WHERE uid = ?` scans the whole table)
            const nodeRow = this.db.prepare("SELECT rowid AS id FROM nodes WHERE uid = ?").get(fm.uid);
            this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(nodeRow.id);
            const stmtFts = this.db.prepare(`
        INSERT INTO nodes_fts (rowid, uid, title, aliases, tags, summary, markdown_body)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            stmtFts.run(nodeRow.id, fm.uid, fm.title, (fm.aliases || []).join(" "), (fm.tags || []).join(" "), fm.summary || "", parsed.markdownBody);
            // 3. Clear existing outgoing edges for this node
            this.db.prepare("DELETE FROM node_edges WHERE source_uid = ?").run(fm.uid);
            // 4. Insert explicit relations from frontmatter
            const stmtEdge = this.db.prepare(`
        INSERT INTO node_edges (
          source_uid, target_uid, relation_type, weight, context_snippet, is_broken_link
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
            for (const rel of fm.relations || []) {
                stmtEdge.run(fm.uid, rel.to, rel.rel, rel.weight, null, 0);
            }
            // 5. Insert implicit edges from wiki-links
            for (const link of parsed.wikiLinks) {
                // avoid duplicating if already specified in relations
                const alreadyExists = (fm.relations || []).some((r) => r.to === link.target);
                if (!alreadyExists) {
                    stmtEdge.run(fm.uid, link.target, "related_to", 1.0, link.alias ? `alias: ${link.alias}` : null, 0);
                }
            }
        });
        runTransaction();
    }
    refreshBrokenLinks() {
        const stmt = this.db.prepare(`
      UPDATE node_edges
      SET is_broken_link = CASE
        WHEN lower(target_uid) NOT IN (SELECT lower(uid) FROM nodes)
         AND lower(target_uid) NOT IN (SELECT lower(${NOTE_PATH_NO_EXT}) FROM nodes)
         AND lower(target_uid) NOT IN (SELECT path_key FROM note_paths) THEN 1
        ELSE 0
      END
    `);
        const result = stmt.run();
        return result.changes;
    }
    getNode(uid) {
        return this.db.prepare("SELECT * FROM nodes WHERE uid = ?").get(uid);
    }
    getAllNodes() {
        return this.db.prepare("SELECT * FROM nodes ORDER BY uid ASC").all();
    }
    searchNodesFts(query, limit = 20, typeFilter) {
        // Sanitize query for FTS5 syntax
        const cleanTokens = query
            .replace(/[^\w\s-]/g, " ")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (cleanTokens.length === 0)
            return [];
        const ftsQuery = cleanTokens.map((t) => `"${t}"*`).join(" OR ");
        let sql = `
      SELECT
        n.uid,
        n.title,
        n.type,
        f.summary,
        snippet(nodes_fts, 5, '<b>', '</b>', '...', 24) AS snippet,
        bm25(nodes_fts) AS rank
      FROM nodes_fts f
      JOIN nodes n ON n.uid = f.uid
      WHERE nodes_fts MATCH ?
    `;
        const params = [ftsQuery];
        if (typeFilter) {
            sql += " AND n.type = ?";
            params.push(typeFilter);
        }
        sql += " ORDER BY rank LIMIT ?";
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        // Calculate degree centrality boost
        const centralityMap = this.calculateDegreeCentrality();
        for (const row of rows) {
            row.degreeScore = centralityMap.get(row.uid) || 0;
        }
        return rows;
    }
    calculateDegreeCentrality() {
        const rows = this.db.prepare(`
      SELECT uid,
        (SELECT COUNT(*) FROM node_edges WHERE source_uid = n.uid) +
        (SELECT COUNT(*) FROM node_edges WHERE target_uid = n.uid) AS degree
      FROM nodes n
    `).all();
        const map = new Map();
        for (const r of rows) {
            map.set(r.uid, r.degree);
        }
        return map;
    }
    getNodeNeighbors(uid, maxDepth = 1) {
        const visitedUids = new Set([uid]);
        const edgesList = [];
        let currentFrontier = [uid];
        for (let depth = 0; depth < maxDepth; depth++) {
            if (currentFrontier.length === 0)
                break;
            const placeholders = currentFrontier.map(() => "?").join(",");
            const query = `
        SELECT * FROM node_edges
        WHERE source_uid IN (${placeholders}) OR target_uid IN (${placeholders})
      `;
            const params = [...currentFrontier, ...currentFrontier];
            const edges = this.db.prepare(query).all(...params);
            const nextFrontier = [];
            for (const e of edges) {
                // avoid duplicate edge references
                if (!edgesList.some((existing) => existing.source_uid === e.source_uid && existing.target_uid === e.target_uid)) {
                    edgesList.push(e);
                }
                if (!visitedUids.has(e.source_uid)) {
                    visitedUids.add(e.source_uid);
                    nextFrontier.push(e.source_uid);
                }
                if (!visitedUids.has(e.target_uid)) {
                    visitedUids.add(e.target_uid);
                    nextFrontier.push(e.target_uid);
                }
            }
            currentFrontier = nextFrontier;
        }
        const allUids = Array.from(visitedUids);
        const placeholders = allUids.map(() => "?").join(",");
        const nodes = this.db.prepare(`
      SELECT * FROM nodes WHERE uid IN (${placeholders})
    `).all(...allUids);
        return {
            focalUid: uid,
            nodes,
            edges: edgesList
        };
    }
    getBrokenLinks() {
        this.refreshBrokenLinks();
        return this.db.prepare(`
      SELECT * FROM node_edges WHERE is_broken_link = 1 ORDER BY source_uid ASC
    `).all();
    }
    getOrphanNodes() {
        // Build the link sets once (O(nodes + edges)). A per-note `lower(target_uid) = ...` subquery
        // cannot use the index on target_uid and would rescan every edge for every note.
        const sources = new Set(this.db.prepare("SELECT DISTINCT source_uid AS k FROM node_edges").all().map((r) => r.k));
        const targets = new Set(this.db.prepare("SELECT DISTINCT lower(target_uid) AS k FROM node_edges").all().map((r) => r.k));
        const nodes = this.db.prepare("SELECT * FROM nodes ORDER BY uid ASC").all();
        return nodes.filter((n) => {
            if (sources.has(n.uid))
                return false;
            if (targets.has(n.uid.toLowerCase()))
                return false;
            return !targets.has(n.file_path.replace(/\.md$/i, "").toLowerCase());
        });
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=database.js.map