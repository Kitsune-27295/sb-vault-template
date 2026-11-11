import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
import { parseNoteContent } from "../../../core/parser/frontmatter.js";
export function runSupersedeReferenceCheck(vaultPath) {
    const files = walkDirectory(vaultPath).filter((f) => f.endsWith(".md") || f.endsWith(".meta.json"));
    const findings = [];
    const entries = new Map();
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            if (file.endsWith(".md")) {
                const parsed = parseNoteContent(readFileSync(file, "utf8"));
                const rawFm = parsed.frontmatter;
                if (rawFm.supersedes || rawFm.superseded_by) {
                    entries.set(parsed.frontmatter.uid, {
                        uid: parsed.frontmatter.uid,
                        file: rel,
                        supersedes: rawFm.supersedes ? String(rawFm.supersedes) : undefined,
                        superseded_by: rawFm.superseded_by ? String(rawFm.superseded_by) : undefined
                    });
                }
            }
            else if (file.endsWith(".meta.json")) {
                const json = JSON.parse(readFileSync(file, "utf8"));
                if (json.source_id && (json.supersedes || json.superseded_by)) {
                    entries.set(json.source_id, {
                        uid: json.source_id,
                        file: rel,
                        supersedes: json.supersedes,
                        superseded_by: json.superseded_by
                    });
                }
            }
        }
        catch {
            // Ignore parse errors here
        }
    }
    // Validate invariants
    for (const [id, entry] of entries.entries()) {
        // 1. No self supersede
        if (entry.supersedes === id) {
            findings.push({
                rule: "supersede-reference",
                severity: "error",
                file: entry.file,
                message: `Node or source "${id}" supersedes itself.`
            });
        }
        // 2. Validate bidirectional reciprocity
        if (entry.superseded_by) {
            const target = entries.get(entry.superseded_by);
            if (target && target.supersedes !== id) {
                findings.push({
                    rule: "supersede-reference",
                    severity: "error",
                    file: entry.file,
                    message: `Node "${id}" declares superseded_by "${entry.superseded_by}", but target does not reciprocate with supersedes.`
                });
            }
        }
        // 3. Cycle detection
        const visited = new Set([id]);
        let current = entry.supersedes;
        while (current) {
            if (current === id) {
                findings.push({
                    rule: "supersede-reference",
                    severity: "error",
                    file: entry.file,
                    message: `Cycle detected in supersede lineage involving node "${id}".`
                });
                break;
            }
            if (visited.has(current))
                break;
            visited.add(current);
            const nextNode = entries.get(current);
            current = nextNode ? nextNode.supersedes : undefined;
        }
    }
    return findings;
}
//# sourceMappingURL=supersede-reference.js.map