import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
import { parseNoteContent } from "../../../core/parser/frontmatter.js";
export function runIngestCoverageCheck(vaultPath) {
    const files = walkDirectory(vaultPath).filter((f) => f.endsWith(".md"));
    const findings = [];
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            const parsed = parseNoteContent(readFileSync(file, "utf8"));
            if (parsed.frontmatter.type !== "source")
                continue;
            const rawFm = parsed.frontmatter;
            const covers = rawFm.covers;
            // If covers is declared, check valid range format
            if (covers) {
                if (!Array.isArray(covers)) {
                    findings.push({
                        rule: "ingest-coverage",
                        severity: "error",
                        file: rel,
                        message: `Property "covers" must be an array of string ranges (e.g., ["1-120"]).`
                    });
                }
                else {
                    for (const item of covers) {
                        const rangeStr = String(item).trim();
                        const match = rangeStr.match(/^(\d+)-(\d+)$/);
                        if (!match) {
                            findings.push({
                                rule: "ingest-coverage",
                                severity: "error",
                                file: rel,
                                message: `Range "${rangeStr}" is not formatted as "startLine-endLine".`
                            });
                        }
                        else {
                            const start = parseInt(match[1], 10);
                            const end = parseInt(match[2], 10);
                            if (start > end) {
                                findings.push({
                                    rule: "ingest-coverage",
                                    severity: "error",
                                    file: rel,
                                    message: `Invalid line range "${rangeStr}": start line is greater than end line.`
                                });
                            }
                        }
                    }
                }
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    return findings;
}
//# sourceMappingURL=ingest-coverage.js.map