export interface ClipOptions {
    vaultPath: string;
    urlOrFile: string;
    markdownContent?: string;
    title?: string;
    json?: boolean;
}
export interface ClipResult {
    status: "captured" | "exists" | "failed";
    id?: string;
    url: string;
    reason?: string;
    file?: string;
    sha256?: string;
}
export declare function validateClipUrl(url: string): {
    valid: boolean;
    reason?: string;
};
export declare function stripHtmlToMarkdown(html: string): string;
export declare function fetchUrlContent(url: string): Promise<{
    title: string;
    content: string;
}>;
export declare function findExistingClippedSource(inboxDir: string, url: string, sha256: string): string | null;
export declare function clipSource(options: ClipOptions): Promise<ClipResult>;
//# sourceMappingURL=clipper.d.ts.map