export interface ExtractedDocxContent {
    text: string;
    markdown: string;
    paragraphs: string[];
}
export declare function extractDocumentXmlFromZip(buffer: Buffer): string | null;
export declare function convertXmlToMarkdown(xml: string): ExtractedDocxContent;
export declare function convertAsciiTreesToMermaid(text: string): string;
//# sourceMappingURL=docx-extractor.d.ts.map