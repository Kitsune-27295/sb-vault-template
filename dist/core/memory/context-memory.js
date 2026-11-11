import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { computeSha256 } from "../parser/frontmatter.js";
import { walkDirectory } from "../../modules/migrator/migrator.js";
export function appendOperationLog(options) {
    const { vaultPath, action, details, operator = "sb" } = options;
    const now = new Date();
    const yearMonth = now.toISOString().slice(0, 7); // e.g. "2026-11"
    const dateStr = now.toISOString().slice(0, 10); // e.g. "2026-11-11"
    // Ops log location: 04_Synthesis_Outputs/Log or 50-ops/log
    const logDir = existsSync(join(vaultPath, "04_Synthesis_Outputs"))
        ? join(vaultPath, "04_Synthesis_Outputs", "Log")
        : join(vaultPath, "50-ops", "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${yearMonth}.md`);
    const prevContent = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const prevChainMatch = prevContent.match(/<!--\s*chain:\s*([a-f0-9]{64})\s*-->/i);
    const prevChain = prevChainMatch ? prevChainMatch[1] : "0000000000000000000000000000000000000000000000000000000000000000";
    const entryText = `## [${dateStr}] ${action} | ${operator}\n${details.trim()}\n`;
    const newChain = computeSha256(`${prevChain}:${entryText}`);
    const formattedEntry = `${entryText}<!-- chain: ${newChain} -->\n\n`;
    appendFileSync(logFile, formattedEntry, "utf8");
    return newChain;
}
export function updateHotMemoryAndIndex(vaultPath, db) {
    const hotPath = existsSync(join(vaultPath, "04_Synthesis_Outputs", "Hot_Memory.md"))
        ? join(vaultPath, "04_Synthesis_Outputs", "Hot_Memory.md")
        : existsSync(join(vaultPath, "50-ops", "hot.md"))
            ? join(vaultPath, "50-ops", "hot.md")
            : join(vaultPath, "04_Synthesis_Outputs", "Hot_Memory.md");
    // Determine drop files count
    const dropDir = existsSync(join(vaultPath, "01_Inbox", "_drop"))
        ? join(vaultPath, "01_Inbox", "_drop")
        : join(vaultPath, "50-ops", "inbox", "_drop");
    const dropCount = existsSync(dropDir)
        ? readdirSync(dropDir).filter((f) => f.endsWith(".md")).length
        : 0;
    // Count active notes & projects
    let projectCount = 0;
    let totalNotes = 0;
    if (existsSync(join(vaultPath, "03_PARA", "01_Projects"))) {
        projectCount = readdirSync(join(vaultPath, "03_PARA", "01_Projects")).filter((f) => f.endsWith(".md")).length;
    }
    const files = existsSync(vaultPath)
        ? walkDirectory(vaultPath).filter((f) => f.endsWith(".md") && !f.includes(".vault") && !f.includes("node_modules"))
        : [];
    totalNotes = files.length;
    const nowStr = new Date().toISOString().slice(0, 10);
    const countsBlock = `<!-- sb:counts:start -->
- Total Knowledge Notes: ${totalNotes}
- Active Projects: ${projectCount}
- Pending Inbox Drops: ${dropCount}
- Last Sync/Ingest: ${nowStr}
<!-- sb:counts:end -->`;
    if (existsSync(hotPath)) {
        const existing = readFileSync(hotPath, "utf8");
        if (existing.includes("<!-- sb:counts:start -->")) {
            const updated = existing.replace(/<!-- sb:counts:start -->[\s\S]*?<!-- sb:counts:end -->/, countsBlock);
            writeFileSync(hotPath, updated, "utf8");
        }
        else {
            writeFileSync(hotPath, `${existing.trim()}\n\n${countsBlock}\n`, "utf8");
        }
    }
    else {
        mkdirSync(dirname(hotPath), { recursive: true });
        writeFileSync(hotPath, `# Hot Memory\n\nOperational memory for active sessions.\n\n${countsBlock}\n\n## Current Focus\n\n- Active session continuity.\n`, "utf8");
    }
}
export function ingestPendingSources(vaultPath, sourceIdFilter) {
    const dropDir = existsSync(join(vaultPath, "01_Inbox", "_drop"))
        ? join(vaultPath, "01_Inbox", "_drop")
        : existsSync(join(vaultPath, "01_Inbox"))
            ? join(vaultPath, "01_Inbox", "_drop")
            : join(vaultPath, "50-ops", "inbox", "_drop");
    const targetZettelDir = existsSync(join(vaultPath, "02_Zettelkasten", "01_Literature_Notes"))
        ? join(vaultPath, "02_Zettelkasten", "01_Literature_Notes")
        : existsSync(join(vaultPath, "40-compiled"))
            ? join(vaultPath, "40-compiled")
            : join(vaultPath, "02_Zettelkasten", "01_Literature_Notes");
    mkdirSync(targetZettelDir, { recursive: true });
    if (!existsSync(dropDir)) {
        return {
            processedCount: 0,
            skippedCount: 0,
            quarantinedCount: 0,
            createdNotes: [],
            logEntry: "Drop directory does not exist."
        };
    }
    const dropFiles = readdirSync(dropDir).filter((f) => f.endsWith(".md"));
    let processed = 0;
    let skipped = 0;
    const createdNotes = [];
    for (const file of dropFiles) {
        const mdPath = join(dropDir, file);
        const metaPath = `${mdPath}.meta.json`;
        let sourceId = file.replace(/\.md$/, "");
        let sourceUrl = "";
        let sha256 = "";
        let title = sourceId;
        if (existsSync(metaPath)) {
            try {
                const meta = JSON.parse(readFileSync(metaPath, "utf8"));
                sourceId = meta.source_id || sourceId;
                sourceUrl = meta.source_url || "";
                sha256 = meta.sha256 || "";
                title = meta.title || title;
            }
            catch {
                // use fallback
            }
        }
        if (sourceIdFilter && sourceId !== sourceIdFilter && file !== sourceIdFilter) {
            skipped++;
            continue;
        }
        const rawMd = readFileSync(mdPath, "utf8");
        const today = new Date().toISOString().slice(0, 10);
        const zettelUid = `ZET-LIT-${sourceId.slice(-8)}`;
        const curatedZettel = [
            "---",
            `uid: "${zettelUid}"`,
            `title: "${title.replace(/"/g, '\\"')}"`,
            "type: source",
            "status: literature",
            "epistemic_confidence: 0.85",
            `created: "${today}"`,
            `updated: "${today}"`,
            "sources:",
            sourceUrl ? `  - "${sourceUrl}"` : `  - "${sourceId}"`,
            "---",
            "",
            `# ${title}`,
            "",
            `> Ingested from source [[${sourceId}]] on ${today}.`,
            "",
            rawMd.replace(/^---[\s\S]*?---\r?\n/, "").trim()
        ].join("\n");
        const targetFile = join(targetZettelDir, `${sourceId}.md`);
        writeFileSync(targetFile, curatedZettel, "utf8");
        // Copy sidecar to target if exists
        if (existsSync(metaPath)) {
            writeFileSync(`${targetFile}.meta.json`, readFileSync(metaPath, "utf8"), "utf8");
        }
        // Update drop note status or remove from drop
        try {
            const updatedMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
            updatedMeta.status = "ingested";
            updatedMeta.ingested_at = new Date().toISOString();
            updatedMeta.curated_zettel = zettelUid;
            writeFileSync(metaPath, JSON.stringify(updatedMeta, null, 2), "utf8");
        }
        catch {
            // Ignore meta error
        }
        createdNotes.push(`${sourceId}.md -> ${zettelUid}`);
        processed++;
    }
    // Update operation log and hot memory
    const logDetails = `Ingested ${processed} source(s) into ${targetZettelDir}:\n${createdNotes.map((n) => `* ${n}`).join("\n")}`;
    const logChain = appendOperationLog({
        vaultPath,
        action: "ingest",
        details: logDetails
    });
    updateHotMemoryAndIndex(vaultPath);
    return {
        processedCount: processed,
        skippedCount: skipped,
        quarantinedCount: 0,
        createdNotes,
        logEntry: logChain
    };
}
//# sourceMappingURL=context-memory.js.map