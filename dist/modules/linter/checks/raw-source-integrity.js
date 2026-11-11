import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkDirectory } from "../../migrator/migrator.js";
import { computeSha256 } from "../../../core/parser/frontmatter.js";
export function runRawSourceIntegrityCheck(vaultPath) {
    const files = walkDirectory(vaultPath);
    const findings = [];
    // Filter sources files
    const isSourceDir = (rel) => rel.startsWith("80-sources/") ||
        rel.startsWith("10-sources/") ||
        rel.startsWith("01_Inbox/sources/") ||
        rel.startsWith("02_Zettelkasten/01_Literature_Notes/");
    const sourceFiles = files.filter((f) => isSourceDir(f.slice(vaultPath.length + 1).replace(/\\/g, "/")));
    const fileSet = new Set(sourceFiles.map((f) => f.slice(vaultPath.length + 1).replace(/\\/g, "/")));
    for (const rel of fileSet) {
        if (rel.endsWith(".meta.json")) {
            const sourceRel = rel.slice(0, -".meta.json".length);
            if (!fileSet.has(sourceRel)) {
                findings.push({
                    rule: "raw-source-integrity",
                    severity: "error",
                    file: rel,
                    message: `Orphan metadata sidecar has no matching source file at "${sourceRel}".`
                });
            }
            continue;
        }
        // Check if source file has a sidecar
        const sidecarRel = `${rel}.meta.json`;
        if (fileSet.has(sidecarRel)) {
            try {
                const sidecarContent = JSON.parse(readFileSync(join(vaultPath, sidecarRel), "utf8"));
                if (!sidecarContent || typeof sidecarContent.sha256 !== "string") {
                    findings.push({
                        rule: "raw-source-integrity",
                        severity: "error",
                        file: sidecarRel,
                        message: `Sidecar is missing required "sha256" cryptographic property.`
                    });
                }
                else {
                    const actualSha = computeSha256(readFileSync(join(vaultPath, rel)).toString("utf8"));
                    if (actualSha !== sidecarContent.sha256) {
                        findings.push({
                            rule: "raw-source-integrity",
                            severity: "error",
                            file: rel,
                            message: `Hash mismatch: expected ${sidecarContent.sha256}, got ${actualSha}. Source file has been modified.`
                        });
                    }
                }
            }
            catch (err) {
                findings.push({
                    rule: "raw-source-integrity",
                    severity: "error",
                    file: sidecarRel,
                    message: `Malformed JSON in sidecar: ${err instanceof Error ? err.message : String(err)}`
                });
            }
        }
    }
    return findings;
}
//# sourceMappingURL=raw-source-integrity.js.map