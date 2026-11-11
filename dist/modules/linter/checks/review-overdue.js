import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
import { parseNoteContent } from "../../../core/parser/frontmatter.js";
export function runReviewOverdueCheck(vaultPath, currentDate = new Date().toISOString().slice(0, 10)) {
    const files = walkDirectory(vaultPath).filter((f) => f.endsWith(".md"));
    const findings = [];
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        try {
            const parsed = parseNoteContent(readFileSync(file, "utf8"));
            const rawFm = parsed.frontmatter;
            const reviewBy = rawFm.review_by ? String(rawFm.review_by).slice(0, 10) : undefined;
            if (reviewBy && reviewBy < currentDate) {
                findings.push({
                    rule: "review-overdue",
                    severity: "warning",
                    file: rel,
                    message: `Procedure or note "${parsed.frontmatter.title}" was due for review on ${reviewBy} (past current date ${currentDate}).`
                });
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    return findings;
}
//# sourceMappingURL=review-overdue.js.map