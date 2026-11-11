import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { VaultDatabase } from "../../core/db/database.js";
import { ContextAssembler } from "../../core/rag/context-assembler.js";
import { parseNoteContent, computeSha256 } from "../../core/parser/frontmatter.js";
import { walkDirectory, migrateVault } from "../migrator/migrator.js";
import { lintVault, isContentNoteFile } from "../linter/linter.js";
import { VaultWatcher } from "../watcher/watcher.js";
import { runSecretScanCheck } from "../linter/checks/secret-scan.js";
import { clipSource } from "./clipper.js";
import { connectWorkspaceToVault } from "../bridge/bridge.js";
import { ingestPendingSources, updateHotMemoryAndIndex } from "../../core/memory/context-memory.js";
import { GitHubWatchtower } from "../watchtower/github-watcher.js";
import { parseWatchlistContent, updateWatchlistNote } from "../watchtower/watchlist-parser.js";
import { upgradeVault } from "../upgrader/upgrader.js";
import { resolveCaptureDir } from "../../core/vault-layout.js";
import { planLayoutMigration, applyLayoutMigration, assertSafeToApply } from "../migrator/layout-migrator.js";
import { ENGINE_VERSION } from "../../core/version.js";
function printUsage() {
    console.log(`
Second Brain Engine CLI (sb / sbk) — v${ENGINE_VERSION}

Usage:
  sb init <targetPath> [--name <title>]               Bootstrap a clean Second Brain vault
  sb index [vaultPath]                                Rebuild .vault/index.db
  sb watch [vaultPath]                                Watch vault and sync index in real-time
  sb search <query> [--type <t>] [--limit <n>]        Hybrid FTS5 BM25 & graph search
  sb page <uid-or-title> [--vault <path>] [--section] Inspect note metadata, provenance and content
  sb related <uid-or-title> [--vault <path>]          Query 1-hop & 2-hop connected graph neighbors
  sb clip <url-or-file> [--vault <path>] [--json]     Clip web source / file to inbox with sidecar
  sb ingest [<source-id>] [--vault <path>]            Ingest pending inbox drops into curated zettels
  sb sync-repos [--vault <path>] [--ingest] [--json]  Sync watched GitHub documentation repos
  sb watch-repo <github-url> [--vault <path>]         Add a GitHub repository to Watchlist_Repos.md
  sb connect-workspace <targetDir> --vault <path>     Wire an external workspace to Second Brain
  sb context <uid> [--tier <tier>] [--mermaid]        Assemble 3-Tier RAG prompt dossier
  sb lint [vaultPath] [--check <id>] [--json]         Audit links, orphans & schema rules
  sb doctor [vaultPath] [--check <id>] [--json]       Comprehensive 14+ invariant health audit
  sb stats [vaultPath] [--json]                       Display vault knowledge graph metrics
  sb capture <vaultPath> --file <path> [--supersedes] Seal source file with SHA-256 sidecar
  sb scan-secrets [vaultPath] [--json]                Scan files for exposed tokens & keys
  sb templates [vaultPath]                            List or render canonical note templates
  sb migrate <sourceDir> <targetDir> [--dry-run]      Non-destructive DOCX & MD migration
  sb upgrade [vaultPath] [--apply] [--json]           Upgrade vault to latest turnkey framework v${ENGINE_VERSION}
  sb migrate-layout <vaultPath> [--apply] [--force]   Move a numeric-zone vault to the template layout (dry run by default;
                                                      --apply needs a clean git tree unless --force)
`);
}
export function copyDirectoryRecursive(src, dest) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
        const srcPath = join(src, entry);
        const destPath = join(dest, entry);
        const st = statSync(srcPath);
        if (st.isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath);
        }
        else {
            copyFileSync(srcPath, destPath);
        }
    }
}
export function extractVaultPathFromArgs(args) {
    let vaultPath = process.cwd();
    const cleanArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--vault" && args[i + 1]) {
            vaultPath = resolve(process.cwd(), args[i + 1]);
            i++; // skip next arg
        }
        else {
            cleanArgs.push(args[i]);
        }
    }
    return { vaultPath, cleanArgs };
}
export async function runCli(rawArgs) {
    const { vaultPath: parsedVault, cleanArgs } = extractVaultPathFromArgs(rawArgs);
    const command = cleanArgs[0];
    if (!command || command === "--help" || command === "-h") {
        printUsage();
        return;
    }
    const isJson = cleanArgs.includes("--json");
    const positionalPath = cleanArgs[1] && !cleanArgs[1].startsWith("--") ? resolve(process.cwd(), cleanArgs[1]) : null;
    const vaultPath = positionalPath && ["index", "watch", "lint", "doctor", "stats", "scan-secrets", "templates", "capture", "upgrade", "migrate-layout"].includes(command)
        ? positionalPath
        : parsedVault;
    const dbPath = join(vaultPath, ".vault", "index.db");
    switch (command) {
        case "index": {
            console.log(`[sb:index] Indexing vault at ${vaultPath}...`);
            const db = new VaultDatabase(dbPath);
            const files = walkDirectory(vaultPath)
                .filter((f) => f.endsWith(".md"))
                .filter((f) => isContentNoteFile(f.slice(vaultPath.length + 1)));
            let count = 0;
            for (const file of files) {
                try {
                    const content = readFileSync(file, "utf8");
                    const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
                    const parsed = parseNoteContent(content, basename(file, ".md"));
                    db.upsertNode(parsed, rel);
                    count++;
                }
                catch (err) {
                    console.error(`Failed to index ${file}:`, err);
                }
            }
            const broken = db.refreshBrokenLinks();
            updateHotMemoryAndIndex(vaultPath, db);
            console.log(`[sb:index] Indexed ${count} notes successfully. Broken links detected: ${broken}.`);
            db.close();
            break;
        }
        case "search": {
            const query = cleanArgs[1];
            if (!query || query.startsWith("--")) {
                console.error("Error: Search query required. Example: sb search 'quantum'");
                process.exit(1);
            }
            let typeFilter;
            const typeIndex = cleanArgs.indexOf("--type");
            if (typeIndex !== -1 && cleanArgs[typeIndex + 1]) {
                typeFilter = cleanArgs[typeIndex + 1];
            }
            let limit = 20;
            const limitIndex = cleanArgs.findIndex((a) => a === "--limit" || a === "-k");
            if (limitIndex !== -1 && cleanArgs[limitIndex + 1]) {
                limit = parseInt(cleanArgs[limitIndex + 1], 10) || 20;
            }
            const db = new VaultDatabase(dbPath);
            const results = db.searchNodesFts(query, limit, typeFilter);
            if (isJson) {
                console.log(JSON.stringify(results, null, 2));
            }
            else {
                console.log(`Found ${results.length} match(es) for "${query}":\n`);
                for (const r of results) {
                    console.log(`* [${r.uid}] ${r.title} (${r.type})`);
                    if (r.snippet)
                        console.log(`  Snippet: ${r.snippet}`);
                    console.log(`  Degree score: ${r.degreeScore}\n`);
                }
            }
            db.close();
            break;
        }
        case "page": {
            const target = cleanArgs[1];
            if (!target || target.startsWith("--")) {
                console.error("Error: Note UID or title required. Example: sb page ZET-0001");
                process.exit(1);
            }
            let sectionHeading;
            const secIdx = cleanArgs.indexOf("--section");
            if (secIdx !== -1 && cleanArgs[secIdx + 1]) {
                sectionHeading = cleanArgs[secIdx + 1].toLowerCase();
            }
            const db = new VaultDatabase(dbPath);
            let node = db.getNode(target);
            if (!node) {
                const all = db.getAllNodes();
                node = all.find((n) => n.title.toLowerCase() === target.toLowerCase() || basename(n.file_path, ".md").toLowerCase() === target.toLowerCase());
            }
            if (!node) {
                console.error(`Error: Note "${target}" not found in vault at ${vaultPath}`);
                db.close();
                process.exit(1);
            }
            const fullPath = join(vaultPath, node.file_path);
            const content = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
            const parsed = parseNoteContent(content, node.uid);
            let outputContent = parsed.markdownBody;
            if (sectionHeading) {
                const lines = parsed.markdownBody.split(/\r?\n/);
                let inSection = false;
                const sectionLines = [];
                for (const line of lines) {
                    const match = line.match(/^#{1,6}\s+(.*)$/);
                    if (match) {
                        if (match[1].toLowerCase().includes(sectionHeading)) {
                            inSection = true;
                            sectionLines.push(line);
                            continue;
                        }
                        else if (inSection) {
                            break;
                        }
                    }
                    if (inSection)
                        sectionLines.push(line);
                }
                outputContent = sectionLines.join("\n").trim() || `(Section "${sectionHeading}" not found in note)`;
            }
            const pageData = {
                uid: node.uid,
                title: node.title,
                type: node.type,
                status: node.status,
                epistemic_confidence: node.epistemic_confidence,
                para_category: node.para_category,
                file_path: node.file_path,
                sources: parsed.frontmatter.sources || [],
                relations: parsed.frontmatter.relations || [],
                wikiLinks: parsed.wikiLinks,
                content: outputContent
            };
            if (isJson) {
                console.log(JSON.stringify(pageData, null, 2));
            }
            else {
                console.log(`\n=== [${node.uid}] ${node.title} ===`);
                console.log(`Type: ${node.type} | Status: ${node.status} | Epistemic Confidence: ${node.epistemic_confidence}`);
                console.log(`File: ${node.file_path}`);
                if (parsed.frontmatter.sources?.length) {
                    console.log(`Sources: ${parsed.frontmatter.sources.join(", ")}`);
                }
                console.log("\n--- Content ---");
                console.log(outputContent);
            }
            db.close();
            break;
        }
        case "related": {
            const target = cleanArgs[1];
            if (!target || target.startsWith("--")) {
                console.error("Error: Note UID or title required. Example: sb related ZET-0001");
                process.exit(1);
            }
            const db = new VaultDatabase(dbPath);
            let focalUid = target;
            const node = db.getNode(target);
            if (!node) {
                const all = db.getAllNodes();
                const found = all.find((n) => n.title.toLowerCase() === target.toLowerCase() || basename(n.file_path, ".md").toLowerCase() === target.toLowerCase());
                if (found)
                    focalUid = found.uid;
            }
            const neighborhood = db.getNodeNeighbors(focalUid, 2);
            if (isJson) {
                console.log(JSON.stringify(neighborhood, null, 2));
            }
            else {
                console.log(`\nRelated Notes for [${focalUid}]:`);
                console.log(`Connected nodes in 2-hop radius: ${neighborhood.nodes.length} (Edges: ${neighborhood.edges.length})\n`);
                for (const n of neighborhood.nodes) {
                    if (n.uid === focalUid)
                        continue;
                    console.log(`* [${n.uid}] ${n.title} (${n.type}) — Confidence: ${n.epistemic_confidence}`);
                }
            }
            db.close();
            break;
        }
        case "clip": {
            const urlOrFile = cleanArgs[1];
            if (!urlOrFile || urlOrFile.startsWith("--")) {
                console.error("Usage: sb clip <url-or-file> [--vault <path>] [--json]");
                process.exit(1);
            }
            const result = await clipSource({
                vaultPath,
                urlOrFile,
                json: isJson
            });
            if (isJson) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                if (result.status === "captured") {
                    console.log(`captured ${result.id} ${result.url}`);
                }
                else if (result.status === "exists") {
                    console.log(`exists ${result.id} ${result.url}`);
                }
                else {
                    console.log(`failed ${result.url}: ${result.reason}`);
                    process.exit(1);
                }
            }
            break;
        }
        case "ingest": {
            const targetId = cleanArgs[1] && !cleanArgs[1].startsWith("--") ? cleanArgs[1] : undefined;
            const result = ingestPendingSources(vaultPath, targetId);
            if (isJson) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                console.log(`\nSecond Brain Source Ingest: ${vaultPath}`);
                console.log(`Processed: ${result.processedCount} | Skipped: ${result.skippedCount}`);
                for (const n of result.createdNotes) {
                    console.log(`* Created note: ${n}`);
                }
                console.log(`\nLog Chain: ${result.logEntry}`);
            }
            break;
        }
        case "sync-repos": {
            const autoIngest = cleanArgs.includes("--ingest");
            const dryRun = cleanArgs.includes("--dry-run");
            const watchtower = new GitHubWatchtower(vaultPath);
            const report = await watchtower.syncWatchedRepos({
                vaultPath,
                autoIngest,
                dryRun,
                json: isJson
            });
            if (isJson) {
                console.log(JSON.stringify(report, null, 2));
            }
            else {
                console.log(`\nSecond Brain Watchtower Sync: ${vaultPath}`);
                console.log(`Watched Repositories: ${report.totalRepos}`);
                console.log(`Updated Files: ${report.updatedFiles.length}`);
                for (const f of report.updatedFiles) {
                    console.log(`* [${f.status}] ${f.repo}: ${f.path}`);
                }
                if (report.errors.length > 0) {
                    console.log(`\nErrors encountered:`);
                    for (const e of report.errors)
                        console.log(`! ${e}`);
                }
            }
            break;
        }
        case "watch-repo": {
            const repoUrl = cleanArgs[1];
            if (!repoUrl || repoUrl.startsWith("--")) {
                console.error("Usage: sb watch-repo <github-url> [--vault <path>]");
                process.exit(1);
            }
            const watchlistPath = join(vaultPath, "00_System", "Watchlist_Repos.md");
            mkdirSync(join(vaultPath, "00_System"), { recursive: true });
            const current = existsSync(watchlistPath) ? readFileSync(watchlistPath, "utf8") : "";
            const entries = parseWatchlistContent(current);
            if (entries.some((e) => e.url.toLowerCase() === repoUrl.toLowerCase())) {
                console.log(`Repository already in watchlist: ${repoUrl}`);
            }
            else {
                entries.push({
                    url: repoUrl,
                    owner: "",
                    repo: "",
                    autoIngest: true
                });
                updateWatchlistNote(watchlistPath, entries);
                console.log(`Added ${repoUrl} to ${watchlistPath}`);
            }
            break;
        }
        case "connect-workspace": {
            const targetWorkspace = cleanArgs[1];
            if (!targetWorkspace || targetWorkspace.startsWith("--")) {
                console.error("Usage: sb connect-workspace <targetProjectDir> --vault <vaultPath>");
                process.exit(1);
            }
            const res = connectWorkspaceToVault({
                targetWorkspacePath: targetWorkspace,
                vaultPath
            });
            console.log(`\nSuccessfully wired workspace at ${targetWorkspace} to Second Brain vault!`);
            console.log(`* Deep Research Skill: ${res.skillPath}`);
            console.log(`* Companion Search Rule: ${res.rulePath}`);
            console.log(`* Antigravity MCP Config: ${res.antigravityMcpPath}`);
            console.log(`* Claude Code / Cursor Config: ${res.claudeMcpPath}\n`);
            break;
        }
        case "context": {
            const uid = cleanArgs[1];
            if (!uid || uid.startsWith("--")) {
                console.error("Error: Target UID required. Example: sb context ZET-0001");
                process.exit(1);
            }
            let tier = "standard";
            const tierIndex = cleanArgs.indexOf("--tier");
            if (tierIndex !== -1 && cleanArgs[tierIndex + 1]) {
                tier = cleanArgs[tierIndex + 1];
            }
            const includeMermaid = cleanArgs.includes("--mermaid");
            const db = new VaultDatabase(dbPath);
            const assembler = new ContextAssembler(db);
            try {
                const dossier = assembler.assembleContext(uid, {
                    tier,
                    includeMermaidGraph: includeMermaid,
                    vaultBasePath: vaultPath
                });
                if (isJson) {
                    console.log(JSON.stringify(dossier, null, 2));
                }
                else {
                    console.log(dossier.renderedDossier);
                }
            }
            catch (err) {
                console.error("Context assembly error:", err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
            finally {
                db.close();
            }
            break;
        }
        case "lint":
        case "doctor": {
            const checkIdx = cleanArgs.indexOf("--check");
            const checkFilter = checkIdx !== -1 && cleanArgs[checkIdx + 1] ? [cleanArgs[checkIdx + 1]] : undefined;
            const report = lintVault(vaultPath, undefined, { checks: checkFilter });
            if (isJson) {
                console.log(JSON.stringify(report, null, 2));
            }
            else {
                console.log(`\nSecond Brain Doctor & Lint Audit: ${vaultPath}`);
                console.log(`Total Notes: ${report.totalNotes} | Errors: ${report.errorCount} | Warnings: ${report.warningCount} | Infos: ${report.infoCount}\n`);
                for (const f of report.findings) {
                    const badge = f.severity === "error" ? "[ERROR]" : f.severity === "warning" ? "[WARN]" : "[INFO]";
                    const lineStr = f.line ? `:${f.line}` : "";
                    console.log(`${badge} [${f.rule}] ${f.file}${lineStr} — ${f.message}`);
                }
                if (report.isClean) {
                    console.log("\nVault passed all invariant checks cleanly!");
                }
                else {
                    console.log(`\nVault audit found ${report.errorCount} error(s). Please review findings.`);
                    process.exit(1);
                }
            }
            break;
        }
        case "stats": {
            const db = new VaultDatabase(dbPath);
            const allNodes = db.getAllNodes();
            const centrality = db.calculateDegreeCentrality();
            const typeDistribution = {};
            for (const n of allNodes) {
                typeDistribution[n.type] = (typeDistribution[n.type] || 0) + 1;
            }
            let totalDegree = 0;
            let maxDegree = 0;
            let mostConnectedUid = "none";
            for (const [uid, deg] of centrality.entries()) {
                totalDegree += deg;
                if (deg > maxDegree) {
                    maxDegree = deg;
                    mostConnectedUid = uid;
                }
            }
            const metrics = {
                totalNotes: allNodes.length,
                typeDistribution,
                totalGraphEdges: totalDegree / 2,
                averageDegree: allNodes.length > 0 ? (totalDegree / allNodes.length).toFixed(2) : 0,
                mostConnectedNode: { uid: mostConnectedUid, degree: maxDegree }
            };
            if (isJson) {
                console.log(JSON.stringify(metrics, null, 2));
            }
            else {
                console.log(`\nVault Knowledge Graph Statistics:`);
                console.log(`* Total Notes: ${metrics.totalNotes}`);
                console.log(`* Edge Count: ${metrics.totalGraphEdges}`);
                console.log(`* Average Degree Centrality: ${metrics.averageDegree}`);
                console.log(`* Most Connected Node: ${metrics.mostConnectedNode.uid} (${metrics.mostConnectedNode.degree} links)`);
                console.log(`* Node Distribution by Type:`);
                for (const [t, c] of Object.entries(metrics.typeDistribution)) {
                    console.log(`    - ${t}: ${c}`);
                }
            }
            db.close();
            break;
        }
        case "scan-secrets": {
            const findings = runSecretScanCheck(vaultPath);
            if (isJson) {
                console.log(JSON.stringify(findings, null, 2));
            }
            else {
                console.log(`\nSecret Scan Results: ${findings.length} issue(s) detected.`);
                for (const f of findings) {
                    console.log(`[ALERT] ${f.file}:${f.line} — ${f.message}`);
                }
                if (findings.length > 0)
                    process.exit(1);
            }
            break;
        }
        case "capture": {
            const fileIdx = cleanArgs.indexOf("--file");
            if (fileIdx === -1 || !cleanArgs[fileIdx + 1]) {
                console.error("Error: --file <path> is required for capture.");
                process.exit(1);
            }
            const srcFilePath = resolve(cleanArgs[fileIdx + 1]);
            if (!existsSync(srcFilePath)) {
                console.error(`Error: File not found at ${srcFilePath}`);
                process.exit(1);
            }
            const supersedesIdx = cleanArgs.indexOf("--supersedes");
            const supersedesId = supersedesIdx !== -1 ? cleanArgs[supersedesIdx + 1] : undefined;
            const fileContent = readFileSync(srcFilePath);
            const sha256 = computeSha256(fileContent.toString("utf8"));
            const fileName = basename(srcFilePath);
            const sourceId = `SRC-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9]/g, "-").toUpperCase()}`;
            const destDir = resolveCaptureDir(vaultPath);
            mkdirSync(destDir, { recursive: true });
            const destPath = join(destDir, fileName);
            copyFileSync(srcFilePath, destPath);
            const sidecarData = {
                source_id: sourceId,
                sha256,
                original_file: fileName,
                captured_at: new Date().toISOString(),
                supersedes: supersedesId
            };
            writeFileSync(`${destPath}.meta.json`, JSON.stringify(sidecarData, null, 2), "utf8");
            console.log(`[sb:capture] Sealed ${fileName} into ${destPath}`);
            console.log(`SHA-256: ${sha256} | Sidecar created with Source ID: ${sourceId}`);
            break;
        }
        case "templates": {
            const tplDir = join(vaultPath, "00_System", "Templates");
            if (!existsSync(tplDir)) {
                console.log(`Templates directory not found at ${tplDir}`);
                break;
            }
            const tplFiles = readdirSync(tplDir).filter((f) => f.endsWith(".md"));
            console.log(`\nAvailable Note Templates in ${tplDir}:`);
            for (const t of tplFiles) {
                console.log(`* ${t}`);
            }
            break;
        }
        case "migrate": {
            const source = cleanArgs[1];
            const target = cleanArgs[2];
            if (!source || !target || source.startsWith("--") || target.startsWith("--")) {
                console.error("Usage: sb migrate <sourceDir> <targetDir> [--dry-run]");
                process.exit(1);
            }
            const dryRun = cleanArgs.includes("--dry-run");
            console.log(`[sb:migrate] Migrating from ${source} to ${target} (dryRun: ${dryRun})...`);
            const report = migrateVault(resolve(source), resolve(target), { dryRun });
            console.log(`Migrated: ${report.migratedCount}, Failed: ${report.failedCount}, Total files scanned: ${report.totalProcessed}`);
            break;
        }
        case "watch": {
            console.log(`[sb:watch] Starting real-time watcher on ${vaultPath}...`);
            const db = new VaultDatabase(dbPath);
            const watcher = new VaultWatcher(vaultPath, db, {
                onUpdate: (rel, uid) => console.log(`[Updated] ${rel} -> ${uid}`),
                onDelete: (rel) => console.log(`[Deleted] ${rel}`)
            });
            watcher.start();
            console.log("[sb:watch] Press Ctrl+C to stop.");
            break;
        }
        case "init": {
            const target = resolve(process.cwd(), cleanArgs[1] && !cleanArgs[1].startsWith("--") ? cleanArgs[1] : ".");
            console.log(`[sb:init] Bootstrapping clean Second Brain vault at ${target}...`);
            const templatePath = resolve(process.cwd(), "vault-template");
            if (existsSync(templatePath)) {
                copyDirectoryRecursive(templatePath, target);
            }
            else {
                const dirs = [
                    "00_System/Templates",
                    "00_System/Config",
                    "00_System/Automation",
                    "01_Inbox/_drop",
                    "01_Inbox/_quarantine",
                    "02_Zettelkasten/01_Literature_Notes",
                    "02_Zettelkasten/02_Permanent_Notes",
                    "02_Zettelkasten/03_Concept_Notes",
                    "02_Zettelkasten/04_MOCs",
                    "03_PARA/01_Projects",
                    "03_PARA/02_Areas",
                    "03_PARA/03_Resources",
                    "03_PARA/04_Archives",
                    "04_Synthesis_Outputs"
                ];
                for (const d of dirs) {
                    mkdirSync(join(target, d), { recursive: true });
                }
            }
            mkdirSync(join(target, ".vault"), { recursive: true });
            const antigravityMcpConfig = {
                mcpServers: {
                    "second-brain": {
                        command: "node",
                        args: ["./node_modules/second-brain-framework/dist/modules/mcp/server.js"],
                        env: {
                            VAULT_PATH: target
                        }
                    }
                }
            };
            mkdirSync(join(target, ".agents"), { recursive: true });
            writeFileSync(join(target, ".agents", "mcp_config.json"), JSON.stringify(antigravityMcpConfig, null, 2), "utf8");
            writeFileSync(join(target, ".mcp.json"), JSON.stringify(antigravityMcpConfig, null, 2), "utf8");
            console.log(`[sb:init] Initialized Second Brain vault at ${target}.`);
            break;
        }
        case "upgrade": {
            const isApply = cleanArgs.includes("--apply");
            console.log(`[sb:upgrade] ${isApply ? "Applying" : "Previewing"} framework upgrade on ${vaultPath}...`);
            const result = await upgradeVault(vaultPath, { apply: isApply });
            if (isJson) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                console.log(`\nFramework Upgrade Summary for: ${result.vaultPath}`);
                console.log(`* Current Version: ${result.currentVersion}`);
                console.log(`* Target Version:  ${result.targetVersion}`);
                console.log(`* System Layout:   ${result.systemDir}`);
                console.log(`* Mode:            ${result.applied ? "APPLIED" : "DRY-RUN (Pass --apply to execute)"}`);
                console.log(`\nPlanned/Applied Changes (${result.changes.length}):`);
                for (const c of result.changes) {
                    console.log(`  [${c.action.toUpperCase()}] ${c.path} — ${c.description}`);
                }
                if (!result.applied) {
                    console.log(`\nTo execute these changes, re-run with: sb upgrade "${vaultPath}" --apply`);
                }
                else {
                    console.log(`\nUpgrade completed successfully! Next steps:\n  cd "${vaultPath}" && npm install && npm run setup`);
                }
            }
            break;
        }
        case "migrate-layout": {
            const isApply = cleanArgs.includes("--apply");
            const plan = planLayoutMigration(vaultPath);
            if (plan.collisions.length > 0) {
                console.error(`Layout collisions (${plan.collisions.length}); nothing was changed:`);
                for (const c of plan.collisions.slice(0, 20))
                    console.error(`  ${c.to} <- ${c.from.join(" | ")}`);
                process.exit(1);
            }
            let report = null;
            if (isApply) {
                try {
                    assertSafeToApply(vaultPath, cleanArgs.includes("--force"));
                    report = applyLayoutMigration(vaultPath, plan);
                }
                catch (err) {
                    console.error(`Layout migration refused: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }
            }
            if (isJson) {
                console.log(JSON.stringify({ applied: isApply, counts: plan.counts, report, items: isApply ? undefined : plan.items }, null, 2));
            }
            else {
                console.log(`\nLayout migration for: ${vaultPath}`);
                console.log(`* Mode: ${isApply ? "APPLIED" : "DRY-RUN (pass --apply to execute)"}`);
                console.log(`* move: ${plan.counts.move} | convert: ${plan.counts.convert} | remove: ${plan.counts.remove} | keep: ${plan.counts.keep}`);
                if (!isApply) {
                    const removed = {};
                    for (const i of plan.items.filter((x) => x.action === "remove")) {
                        const group = i.from.split("/").slice(0, 2).join("/");
                        removed[group] = (removed[group] ?? 0) + 1;
                    }
                    console.log(`\nTo be removed (${plan.counts.remove}), by folder:`);
                    for (const [group, n] of Object.entries(removed).sort((a, b) => b[1] - a[1]).slice(0, 25))
                        console.log(`  ${String(n).padStart(5)}  ${group}`);
                }
                const kept = plan.items.filter((i) => i.action === "keep");
                if (kept.length > 0) {
                    console.log(`\nKept (not known to the migration, ${kept.length}):`);
                    for (const k of kept.slice(0, 20))
                        console.log(`  ${k.from}`);
                }
                if (report) {
                    console.log(`\nVerification: ${report.mismatches.length === 0 ? "every moved file is byte-identical and every converted body is unchanged" : `${report.mismatches.length} MISMATCH(ES)`}`);
                    for (const m of report.mismatches.slice(0, 20))
                        console.log(`  ${m}`);
                    if (report.warnings.length > 0) {
                        console.log(`\nWarnings (${report.warnings.length}):`);
                        for (const w of report.warnings.slice(0, 20))
                            console.log(`  ${w}`);
                    }
                }
            }
            if (report && report.mismatches.length > 0)
                process.exit(1);
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}
if (process.argv[1] && (process.argv[1].endsWith("sb.js") || process.argv[1].endsWith("cli/index.js") || process.argv[1].endsWith("cli\\index.js"))) {
    runCli(process.argv.slice(2)).catch((err) => {
        console.error("CLI Execution failed:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map