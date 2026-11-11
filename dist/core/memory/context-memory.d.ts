import { VaultDatabase } from "../db/database.js";
export interface AppendLogOptions {
    vaultPath: string;
    action: string;
    details: string;
    operator?: string;
}
export interface IngestItem {
    file: string;
    sourceId: string;
    sourceUrl?: string;
    sha256?: string;
    title: string;
    content: string;
}
export interface IngestResult {
    processedCount: number;
    skippedCount: number;
    quarantinedCount: number;
    createdNotes: string[];
    logEntry: string;
}
export declare function appendOperationLog(options: AppendLogOptions): string;
export declare function updateHotMemoryAndIndex(vaultPath: string, db?: VaultDatabase): void;
export declare function ingestPendingSources(vaultPath: string, sourceIdFilter?: string): IngestResult;
//# sourceMappingURL=context-memory.d.ts.map