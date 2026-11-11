import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const MAX_HOT_MEMORY_LINES = 60;
export function runMemoryBudgetCheck(vaultPath) {
    const findings = [];
    const candidatePaths = [
        "04_Synthesis_Outputs/Hot_Memory.md",
        "50-ops/hot.md",
        "hot.md"
    ];
    for (const rel of candidatePaths) {
        const fullPath = join(vaultPath, rel);
        if (existsSync(fullPath)) {
            try {
                const content = readFileSync(fullPath, "utf8");
                const lines = content.split(/\r?\n/).filter((l, idx, arr) => !(idx === arr.length - 1 && l === ""));
                if (lines.length > MAX_HOT_MEMORY_LINES) {
                    findings.push({
                        rule: "memory-budget",
                        severity: "warning",
                        file: rel,
                        message: `Operational memory note has ${lines.length} lines, exceeding the recommended limit of ${MAX_HOT_MEMORY_LINES} lines. Offload details to atomic Zettels.`
                    });
                }
            }
            catch {
                // Ignore read errors
            }
        }
    }
    return findings;
}
//# sourceMappingURL=memory-budget.js.map