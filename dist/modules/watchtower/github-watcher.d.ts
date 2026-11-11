export interface SyncOptions {
    vaultPath: string;
    autoIngest?: boolean;
    sinceHours?: number;
    dryRun?: boolean;
    json?: boolean;
    githubToken?: string;
    fetchFn?: typeof fetch;
}
export interface SyncReport {
    timestamp: string;
    totalRepos: number;
    updatedFiles: {
        repo: string;
        path: string;
        status: string;
        clipId?: string;
    }[];
    errors: string[];
}
export declare function sanitizeVendorDocumentation(rawMarkdown: string): string;
export declare function isMeaningfulTechnicalDiff(oldText: string, newText: string): boolean;
export declare class GitHubWatchtower {
    private vaultPath;
    private githubToken?;
    private fetchFn;
    constructor(vaultPath: string, githubToken?: string, fetchFn?: typeof fetch);
    private getHeaders;
    syncWatchedRepos(options: SyncOptions): Promise<SyncReport>;
    private syncSingleRepo;
}
//# sourceMappingURL=github-watcher.d.ts.map