import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
const VALID_MERMAID_TYPES = [
    "flowchart",
    "graph",
    "sequencediagram",
    "erdiagram",
    "statediagram",
    "statediagram-v2",
    "classdiagram",
    "mindmap",
    "timeline",
    "gitgraph",
    "xychart-beta"
];
export function runMermaidSyntaxCheck(vaultPath) {
    const files = walkDirectory(vaultPath).filter((f) => f.endsWith(".md"));
    const findings = [];
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            const content = readFileSync(file, "utf8");
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                // 1. Forbid raw text/plaintext blocks
                if (line.startsWith("```text") || line.startsWith("```plaintext")) {
                    findings.push({
                        rule: "mermaid-syntax",
                        severity: "error",
                        file: rel,
                        line: i + 1,
                        message: `Forbidden "${line}" block detected. Second Brain policy requires native \`\`\`mermaid diagrams.`
                    });
                }
                // 2. Validate Mermaid diagram initiator
                if (line.startsWith("```mermaid")) {
                    // Look at the next non-empty line
                    let nextIdx = i + 1;
                    while (nextIdx < lines.length && !lines[nextIdx].trim())
                        nextIdx++;
                    if (nextIdx < lines.length) {
                        const firstHeader = lines[nextIdx].trim().toLowerCase().split(/\s+/)[0];
                        if (!VALID_MERMAID_TYPES.some((t) => firstHeader.startsWith(t))) {
                            findings.push({
                                rule: "mermaid-syntax",
                                severity: "warning",
                                file: rel,
                                line: nextIdx + 1,
                                message: `Unrecognized or non-standard Mermaid diagram type: "${lines[nextIdx].trim()}".`
                            });
                        }
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
//# sourceMappingURL=mermaid-syntax.js.map