import { VaultDatabase } from "../../core/db/database.js";
import { parseNoteContent } from "../../core/parser/frontmatter.js";
import { walkDirectory } from "../migrator/migrator.js";
import { readFileSync, existsSync } from "node:fs";
import { relative, extname, basename } from "node:path";
// Specialized Check Runners
import { runSecretScanCheck } from "./checks/secret-scan.js";
import { runRawSourceIntegrityCheck } from "./checks/raw-source-integrity.js";
import { runSupersedeReferenceCheck } from "./checks/supersede-reference.js";
import { runReviewOverdueCheck } from "./checks/review-overdue.js";
import { runIngestCoverageCheck } from "./checks/ingest-coverage.js";
import { runMemoryBudgetCheck } from "./checks/memory-budget.js";
import { runFrameworkVersionCheck } from "./checks/framework-version.js";
import { runLogAppendOnlyCheck, runCaptureLedgerCheck } from "./checks/log-and-ledger.js";
import { runMermaidSyntaxCheck } from "./checks/mermaid-syntax.js";
export function isContentNoteFile(relPath) {
    const normalized = relPath.replace(/\\/g, "/");
    if (normalized.startsWith(".agents/") ||
        normalized.startsWith(".claude/") ||
        normalized.startsWith(".obsidian/") ||
        normalized.includes("/Templates/") ||
        normalized.includes("/templates/") ||
        normalized.startsWith("00_System/Templates/") ||
        normalized === "AGENTS.md" ||
        normalized === "CLAUDE.md" ||
        normalized === "README.md") {
        return false;
    }
    return true;
}
export function lintVault(vaultPath, db, options = {}) {
    const localDb = db || new VaultDatabase(":memory:");
    const files = walkDirectory(vaultPath)
        .filter((f) => extname(f).toLowerCase() === ".md")
        .filter((f) => isContentNoteFile(relative(vaultPath, f)));
    const activeChecks = options.checks ? new Set(options.checks) : null;
    const shouldRun = (checkId) => !activeChecks || activeChecks.has(checkId);
    const findings = [];
    // 1. Index & Schema Violations
    for (const file of files) {
        const rel = relative(vaultPath, file).replace(/\\/g, "/");
        try {
            const content = readFileSync(file, "utf8");
            const parsed = parseNoteContent(content, basename(file, ".md"));
            if (parsed.validationError && shouldRun("schema-violation")) {
                findings.push({
                    rule: "schema-violation",
                    severity: "warning",
                    file: rel,
                    message: parsed.validationError
                });
            }
            localDb.upsertNode(parsed, rel);
        }
        catch (err) {
            if (shouldRun("schema-violation")) {
                findings.push({
                    rule: "schema-violation",
                    severity: "error",
                    file: rel,
                    message: err instanceof Error ? err.message : String(err)
                });
            }
        }
    }
    // 2. Broken Links
    if (shouldRun("broken-link")) {
        const brokenLinks = localDb.getBrokenLinks();
        for (const b of brokenLinks) {
            const sourceNode = localDb.getNode(b.source_uid);
            findings.push({
                rule: "broken-link",
                severity: "error",
                file: sourceNode?.file_path || b.source_uid,
                message: `Broken link to missing target UID: [[${b.target_uid}]]`
            });
        }
    }
    // 3. Orphan Notes
    if (shouldRun("orphan-node")) {
        const orphans = localDb.getOrphanNodes();
        for (const o of orphans) {
            if (o.type === "zettel" || o.type === "concept") {
                findings.push({
                    rule: "orphan-node",
                    severity: "warning",
                    file: o.file_path,
                    message: `Note "${o.title}" (${o.uid}) is an orphan with zero inbound or outbound connections.`
                });
            }
        }
    }
    // 4. Unlinked Mentions
    if (shouldRun("unlinked-mention")) {
        const allNodes = localDb.getAllNodes();
        for (const node of allNodes) {
            if (!node.title || node.title.length < 4)
                continue;
            const titleRegex = new RegExp(`\\b${escapeRegExp(node.title)}\\b`, "gi");
            for (const other of allNodes) {
                if (other.uid === node.uid)
                    continue;
                const filePath = existsSync(other.file_path) ? other.file_path : `${vaultPath}/${other.file_path}`;
                if (existsSync(filePath)) {
                    const text = readFileSync(filePath, "utf8");
                    const occurrences = text.match(titleRegex);
                    const linkedCount = (text.match(new RegExp(`\\[\\[[^\\]]*${escapeRegExp(node.uid)}[^\\]]*\\]\\]`, "gi")) || []).length;
                    if (occurrences && occurrences.length > linkedCount && linkedCount === 0) {
                        findings.push({
                            rule: "unlinked-mention",
                            severity: "info",
                            file: other.file_path,
                            message: `Possible unlinked mention of "${node.title}" (${node.uid}) in ${other.file_path}`
                        });
                    }
                }
            }
        }
    }
    // 5. Secret Scan
    if (shouldRun("secret-scan")) {
        findings.push(...runSecretScanCheck(vaultPath));
    }
    // 6. Raw Source Integrity
    if (shouldRun("raw-source-integrity")) {
        findings.push(...runRawSourceIntegrityCheck(vaultPath));
    }
    // 7. Supersede Reference
    if (shouldRun("supersede-reference")) {
        findings.push(...runSupersedeReferenceCheck(vaultPath));
    }
    // 8. Review Overdue
    if (shouldRun("review-overdue")) {
        findings.push(...runReviewOverdueCheck(vaultPath, options.today));
    }
    // 9. Ingest Coverage
    if (shouldRun("ingest-coverage")) {
        findings.push(...runIngestCoverageCheck(vaultPath));
    }
    // 10. Memory Budget
    if (shouldRun("memory-budget")) {
        findings.push(...runMemoryBudgetCheck(vaultPath));
    }
    // 11. Framework Version
    if (shouldRun("framework-version")) {
        findings.push(...runFrameworkVersionCheck(vaultPath, options.frameworkVersion));
    }
    // 12. Log Append Only
    if (shouldRun("log-append-only")) {
        findings.push(...runLogAppendOnlyCheck(vaultPath));
    }
    // 13. Capture Ledger
    if (shouldRun("capture-ledger")) {
        findings.push(...runCaptureLedgerCheck(vaultPath));
    }
    // 14. Mermaid Visual Policy
    if (shouldRun("mermaid-syntax")) {
        findings.push(...runMermaidSyntaxCheck(vaultPath));
    }
    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;
    const infoCount = findings.filter((f) => f.severity === "info").length;
    return {
        vaultPath,
        totalNotes: localDb.getAllNodes().length,
        errorCount,
        warningCount,
        infoCount,
        findings,
        isClean: errorCount === 0
    };
}
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=linter.js.map