import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
export function runLogAppendOnlyCheck(vaultPath) {
    const files = walkDirectory(vaultPath).filter((f) => {
        const rel = f.slice(vaultPath.length + 1).replace(/\\/g, "/");
        return (rel.includes("/log/") || rel.startsWith("log/")) && rel.endsWith(".md");
    });
    const findings = [];
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            const content = readFileSync(file, "utf8");
            const lines = content.split(/\r?\n/);
            let lastTimestamp = null;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = line.match(/^##\s+(\d{4}-\d{2}-\d{2}(?:T|\s+)\d{2}:\d{2}:\d{2})/);
                if (match) {
                    const currentTimestamp = match[1];
                    if (lastTimestamp && currentTimestamp < lastTimestamp) {
                        findings.push({
                            rule: "log-append-only",
                            severity: "error",
                            file: rel,
                            line: i + 1,
                            message: `Log chronological order violation at line ${i + 1}: ${currentTimestamp} is earlier than previous entry ${lastTimestamp}.`
                        });
                    }
                    lastTimestamp = currentTimestamp;
                }
            }
        }
        catch {
            // Ignore read errors
        }
    }
    return findings;
}
export function runCaptureLedgerCheck(vaultPath) {
    const files = walkDirectory(vaultPath);
    const findings = [];
    const logFiles = files.filter((f) => {
        const rel = f.slice(vaultPath.length + 1).replace(/\\/g, "/");
        return (rel.includes("/log/") || rel.startsWith("log/")) && rel.endsWith(".md");
    });
    for (const logFile of logFiles) {
        const logRel = logFile.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            const content = readFileSync(logFile, "utf8");
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // The operation must follow the entry's date or timestamp directly, as in
                // `## [2026-11-10] capture | <id>` or `## 2026-11-10T12:00:00 supersede <id>`.
                // The word "capture" elsewhere in a title (`ingest-skip | x — capture truncated`) is not an entry.
                const captureMatch = line.match(/^##\s+(?:\[[^\]]*\]|\d{4}-\d{2}-\d{2}(?:[T\s]+\d{2}:\d{2}:\d{2})?)\s+(?:capture|supersede)\b\s*\|?\s*([A-Za-z0-9_.-]+)/i);
                if (captureMatch) {
                    const sourceId = captureMatch[1];
                    // Look for this source id in vault files
                    const exists = files.some((f) => {
                        const rel = f.slice(vaultPath.length + 1).replace(/\\/g, "/");
                        return rel.includes(sourceId);
                    });
                    if (!exists) {
                        findings.push({
                            rule: "capture-ledger",
                            severity: "error",
                            file: logRel,
                            line: i + 1,
                            message: `Log entry records sealed source "${sourceId}", but no corresponding file exists in the vault.`
                        });
                    }
                }
            }
        }
        catch {
            // Ignore read errors
        }
    }
    return findings;
}
//# sourceMappingURL=log-and-ledger.js.map