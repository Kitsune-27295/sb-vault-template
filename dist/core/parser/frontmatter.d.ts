import { UniversalNodeFrontmatter } from "../schema/nodes.js";
export interface ExtractedWikiLink {
    raw: string;
    target: string;
    alias?: string;
    heading?: string;
    line: number;
}
export interface ParsedNode {
    frontmatter: UniversalNodeFrontmatter;
    rawYaml: string;
    markdownBody: string;
    contentHash: string;
    wikiLinks: ExtractedWikiLink[];
    validationError?: string;
}
export declare function stripCodeBlocks(markdown: string): string;
export declare function extractWikiLinks(markdown: string): ExtractedWikiLink[];
export declare function computeSha256(content: string): string;
export declare function parseNoteContent(rawContent: string, fallbackUid?: string): ParsedNode;
//# sourceMappingURL=frontmatter.d.ts.map