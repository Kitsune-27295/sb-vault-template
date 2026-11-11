import { createHash } from "node:crypto";
import YAML from "yaml";
import { validateAndNormalizeFrontmatter } from "../schema/nodes.js";
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`\n]+`/g;
const WIKI_LINK_REGEX = /\[\[([^[\]]+)\]\]/g;
export function stripCodeBlocks(markdown) {
    // Replace fenced code blocks with empty lines preserving line counts
    const withoutFenced = markdown.replace(FENCED_CODE_BLOCK_REGEX, (match) => {
        const lineCount = (match.match(/\r?\n/g) || []).length;
        return "\n".repeat(lineCount);
    });
    // Replace inline code spans with blank spaces of identical length
    return withoutFenced.replace(INLINE_CODE_REGEX, (match) => " ".repeat(match.length));
}
export function extractWikiLinks(markdown) {
    const sanitizedMarkdown = stripCodeBlocks(markdown);
    const links = [];
    const lines = sanitizedMarkdown.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        let match;
        const regex = new RegExp(WIKI_LINK_REGEX.source, "g");
        while ((match = regex.exec(line)) !== null) {
            const rawInside = match[1].trim();
            if (!rawInside)
                continue;
            let target = rawInside;
            let alias;
            let heading;
            // Check for alias [[target|alias]]
            if (target.includes("|")) {
                const parts = target.split("|");
                target = parts[0].trim();
                alias = parts.slice(1).join("|").trim();
            }
            // Check for anchor/heading [[target#heading]]
            if (target.includes("#")) {
                const parts = target.split("#");
                target = parts[0].trim();
                heading = parts.slice(1).join("#").trim();
            }
            links.push({
                raw: match[0],
                target,
                alias,
                heading,
                line: lineIndex + 1
            });
        }
    }
    return links;
}
export function computeSha256(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
export function parseNoteContent(rawContent, fallbackUid = "UNTITLED") {
    const contentHash = computeSha256(rawContent);
    const match = rawContent.match(FRONTMATTER_REGEX);
    if (!match) {
        // No frontmatter found, build a synthetic fallback
        const fallbackFrontmatter = {
            uid: fallbackUid,
            type: "zettel",
            title: fallbackUid,
            aliases: [],
            tags: [],
            status: "permanent",
            epistemic_confidence: 0.5,
            created: new Date().toISOString().slice(0, 10),
            updated: new Date().toISOString().slice(0, 10),
            summary: "",
            sources: [],
            relations: []
        };
        return {
            frontmatter: fallbackFrontmatter,
            rawYaml: "",
            markdownBody: rawContent,
            contentHash,
            wikiLinks: extractWikiLinks(rawContent),
            validationError: "Missing YAML Frontmatter envelope (--- ... ---)"
        };
    }
    const rawYaml = match[1];
    const markdownBody = match[2] || "";
    let parsedYamlObj = {};
    try {
        parsedYamlObj = YAML.parse(rawYaml) || {};
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const fallbackFrontmatter = {
            uid: fallbackUid,
            type: "zettel",
            title: fallbackUid,
            aliases: [],
            tags: [],
            status: "permanent",
            epistemic_confidence: 0.5,
            created: new Date().toISOString().slice(0, 10),
            updated: new Date().toISOString().slice(0, 10),
            summary: "",
            sources: [],
            relations: []
        };
        return {
            frontmatter: fallbackFrontmatter,
            rawYaml,
            markdownBody,
            contentHash,
            wikiLinks: extractWikiLinks(markdownBody),
            validationError: `Invalid YAML syntax: ${errorMsg}`
        };
    }
    const validation = validateAndNormalizeFrontmatter(parsedYamlObj);
    if (!validation.success || !validation.data) {
        const fallbackFrontmatter = {
            uid: parsedYamlObj?.uid ? String(parsedYamlObj.uid) : fallbackUid,
            type: "zettel",
            title: parsedYamlObj?.title ? String(parsedYamlObj.title) : fallbackUid,
            aliases: [],
            tags: [],
            status: "permanent",
            epistemic_confidence: 0.5,
            created: new Date().toISOString().slice(0, 10),
            updated: new Date().toISOString().slice(0, 10),
            summary: "",
            sources: [],
            relations: []
        };
        return {
            frontmatter: fallbackFrontmatter,
            rawYaml,
            markdownBody,
            contentHash,
            wikiLinks: extractWikiLinks(markdownBody),
            validationError: validation.error
        };
    }
    return {
        frontmatter: validation.data,
        rawYaml,
        markdownBody,
        contentHash,
        wikiLinks: extractWikiLinks(markdownBody)
    };
}
//# sourceMappingURL=frontmatter.js.map