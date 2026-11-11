import { VaultDatabase } from "../../core/db/database.js";
import { parseNoteContent, computeSha256 } from "../../core/parser/frontmatter.js";
import { walkDirectory } from "../migrator/migrator.js";
import { isInstanceLayout } from "../../core/vault-layout.js";
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
        // The framework's own files (templates, integrations, watchlist, config) and the generated
        // hot memory are not notes of the vault.
        normalized.startsWith("00_System/") ||
        normalized === "04_Synthesis_Outputs/Hot_Memory.md" ||
        normalized === "AGENTS.md" ||
        normalized === "CLAUDE.md" ||
        normalized === "README.md") {
        return false;
    }
    return true;
}
// Zones whose files are immutable captures or hash-chained logs: a content-quality finding
// there can never be fixed by editing, so reporting it only buries the real findings.
const IMMUTABLE_ZONES = ["10-sources/", "50-ops/log/", "50-ops/quarantine/", "20-human/_imported/"];
const CONTENT_QUALITY_RULES = new Set(["broken-link", "orphan-node", "mermaid-syntax", "schema-violation"]);
// `unlinked-mention` re-reads every note for every title (quadratic): minutes on a vault
// of thousands of notes. It is an info-level heuristic, so it runs only when asked for.
const EXPLICIT_ONLY_CHECKS = new Set(["unlinked-mention"]);
// Integrity checks (secret-scan, raw-source-integrity, log-append-only, capture-ledger, ...)
// are never exempt. The Instance note schema lives in 90-system/schema and is not validated
// by this engine, so a Zettelkasten schema mismatch (a warning) is dropped on an Instance
// vault. Invalid YAML syntax and notes that cannot be read at all are real defects in a
// writable zone and stay reported.
export function isExemptOnInstanceLayout(finding) {
    if (!CONTENT_QUALITY_RULES.has(finding.rule))
        return false;
    const file = finding.file.replace(/\\/g, "/");
    if (IMMUTABLE_ZONES.some((zone) => file.startsWith(zone)))
        return true;
    if (finding.rule === "schema-violation") {
        return finding.severity === "warning" && !finding.message.startsWith("Invalid YAML syntax");
    }
    return false;
}
// Template-layout zones that hold hash-chained logs and quarantined third-party captures.
const TEMPLATE_IMMUTABLE_ZONES = ["04_Synthesis_Outputs/Log/", "01_Inbox/_quarantine/"];
// A note that has a `<file>.meta.json` sidecar whose hash matches the file is a sealed raw source (on
// every layout): its bytes are pinned, so a content-quality finding in it can never be fixed by
// editing. A sidecar that does not match seals nothing (raw-source-integrity reports the mismatch and
// the note's own problems stay visible). Integrity checks are never exempt.
export function isSealedOrImmutable(vaultPath, finding, cache = new Map()) {
    if (!CONTENT_QUALITY_RULES.has(finding.rule))
        return false;
    const file = finding.file.replace(/\\/g, "/");
    if (TEMPLATE_IMMUTABLE_ZONES.some((zone) => file.startsWith(zone)))
        return true;
    const cached = cache.get(file);
    if (cached !== undefined)
        return cached;
    let sealed = false;
    const sidecarPath = `${vaultPath}/${file}.meta.json`;
    if (existsSync(sidecarPath)) {
        try {
            const meta = JSON.parse(readFileSync(sidecarPath, "utf8"));
            sealed = typeof meta.sha256 === "string" && meta.sha256 === computeSha256(readFileSync(`${vaultPath}/${file}`).toString("utf8"));
        }
        catch {
            sealed = false;
        }
    }
    cache.set(file, sealed);
    return sealed;
}
export function lintVault(vaultPath, db, options = {}) {
    const localDb = db || new VaultDatabase(":memory:");
    const files = walkDirectory(vaultPath)
        .filter((f) => extname(f).toLowerCase() === ".md")
        .filter((f) => isContentNoteFile(relative(vaultPath, f)));
    const activeChecks = options.checks ? new Set(options.checks) : null;
    const shouldRun = (checkId) => activeChecks ? activeChecks.has(checkId) : !EXPLICIT_ONLY_CHECKS.has(checkId);
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
    const instance = isInstanceLayout(vaultPath);
    const sealedCache = new Map();
    const reported = findings.filter((f) => !(instance && isExemptOnInstanceLayout(f)) && !isSealedOrImmutable(vaultPath, f, sealedCache));
    const errorCount = reported.filter((f) => f.severity === "error").length;
    const warningCount = reported.filter((f) => f.severity === "warning").length;
    const infoCount = reported.filter((f) => f.severity === "info").length;
    return {
        vaultPath,
        totalNotes: localDb.getAllNodes().length,
        errorCount,
        warningCount,
        infoCount,
        findings: reported,
        isClean: errorCount === 0
    };
}
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//# sourceMappingURL=linter.js.map