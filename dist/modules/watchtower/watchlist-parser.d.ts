export interface WatchedRepoEntry {
    url: string;
    owner: string;
    repo: string;
    pathFilter?: string;
    branch?: string;
    autoIngest: boolean;
    lastSyncedSha?: string;
    lastChecked?: string;
}
export declare function parseGitHubRepoUrl(rawUrl: string): {
    owner: string;
    repo: string;
    branch?: string;
    pathFilter?: string;
} | null;
export declare function parseWatchlistContent(markdownContent: string): WatchedRepoEntry[];
export declare function formatWatchlistTable(entries: WatchedRepoEntry[]): string;
export declare function updateWatchlistNote(filePath: string, entries: WatchedRepoEntry[]): void;
//# sourceMappingURL=watchlist-parser.d.ts.map