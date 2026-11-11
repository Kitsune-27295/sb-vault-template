export declare function copyRecursive(src: string, dest: string, filter?: (p: string) => boolean): void;
export interface BuildDistOptions {
    outDir: string;
    repoRoot?: string;
}
export declare function renderConsumerReadme(version: string): string;
export declare function buildDistTemplate(options: BuildDistOptions): {
    outDir: string;
    fileCount: number;
    treeHash: string;
};
export declare function getAllFiles(dir: string): string[];
export declare function runPublishGuard(stagedDir: string, expectedVersion: string): void;
//# sourceMappingURL=builder.d.ts.map