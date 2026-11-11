import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname, basename } from "node:path";
import { extractDocumentXmlFromZip, convertXmlToMarkdown, convertAsciiTreesToMermaid } from "./docx-extractor.js";
import { parseNoteContent } from "../../core/parser/frontmatter.js";
import YAML from "yaml";
export function walkDirectory(dir) {
    const files = [];
    try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
            if (entry === "node_modules" ||
                entry === ".git" ||
                entry === ".vault" ||
                entry === ".agents" ||
                entry === ".claude" ||
                entry === "dist") {
                continue;
            }
            const fullPath = join(dir, entry);
            const st = statSync(fullPath);
            if (st.isDirectory()) {
                files.push(...walkDirectory(fullPath));
            }
            else {
                files.push(fullPath);
            }
        }
    }
    catch {
        // Return collected so far
    }
    return files;
}
export function migrateVault(sourceDir, targetDir, options = {}) {
    const dryRun = options.dryRun ?? false;
    const files = walkDirectory(sourceDir);
    const items = [];
    let migratedCount = 0;
    let failedCount = 0;
    for (const file of files) {
        const ext = extname(file).toLowerCase();
        if (ext !== ".md" && ext !== ".docx")
            continue;
        const relPath = relative(sourceDir, file);
        const targetFile = join(targetDir, relPath.replace(/\.docx$/i, ".md"));
        try {
            let finalMarkdown = "";
            let convertedMermaid = 0;
            if (ext === ".docx") {
                const docxBuffer = readFileSync(file);
                const xml = extractDocumentXmlFromZip(docxBuffer);
                if (!xml) {
                    throw new Error("Invalid or unreadable DOCX archive (missing word/document.xml)");
                }
                const extracted = convertXmlToMarkdown(xml);
                finalMarkdown = extracted.markdown;
                if (finalMarkdown.includes("```mermaid")) {
                    convertedMermaid++;
                }
                // Prepend frontmatter envelope if absent
                const noteTitle = basename(file, ext);
                const autoUid = `SRC-${noteTitle.replace(/[^a-zA-Z0-9]/g, "-").toUpperCase()}`;
                const syntheticFm = {
                    uid: autoUid,
                    type: "source",
                    title: noteTitle,
                    status: "permanent",
                    created: new Date().toISOString().slice(0, 10),
                    updated: new Date().toISOString().slice(0, 10),
                    summary: `Migrated from DOCX: ${basename(file)}`
                };
                finalMarkdown = `---\n${YAML.stringify(syntheticFm)}---\n\n${finalMarkdown}`;
            }
            else {
                // Markdown file
                const rawContent = readFileSync(file, "utf8");
                const withMermaid = convertAsciiTreesToMermaid(rawContent);
                if (withMermaid !== rawContent) {
                    convertedMermaid++;
                }
                const parsed = parseNoteContent(withMermaid, basename(file, ext));
                const normalizedYaml = YAML.stringify(parsed.frontmatter);
                finalMarkdown = `---\n${normalizedYaml}---\n\n${parsed.markdownBody.trim()}\n`;
            }
            if (!dryRun) {
                mkdirSync(dirname(targetFile), { recursive: true });
                writeFileSync(targetFile, finalMarkdown, "utf8");
            }
            items.push({
                sourceFile: file,
                targetFile,
                type: ext === ".docx" ? "docx" : "markdown",
                convertedMermaidTrees: convertedMermaid,
                status: dryRun ? "simulated" : "migrated"
            });
            migratedCount++;
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            items.push({
                sourceFile: file,
                targetFile,
                type: ext === ".docx" ? "docx" : "markdown",
                convertedMermaidTrees: 0,
                status: "failed",
                error: errorMsg
            });
            failedCount++;
        }
    }
    return {
        totalProcessed: files.length,
        migratedCount,
        failedCount,
        dryRun,
        items
    };
}
//# sourceMappingURL=migrator.js.map