import { VaultDatabase } from "../../core/db/database.js";
export interface WatcherOptions {
    debounceMs?: number;
    onUpdate?: (filePath: string, uid: string) => void;
    onDelete?: (filePath: string) => void;
}
export declare class VaultWatcher {
    private readonly vaultPath;
    private readonly db;
    private readonly options;
    private watcher?;
    private pendingUpdates;
    private knownHashes;
    constructor(vaultPath: string, db: VaultDatabase, options?: WatcherOptions);
    start(): void;
    private scheduleProcess;
    private processFile;
    private handleDelete;
    stop(): Promise<void>;
}
//# sourceMappingURL=watcher.d.ts.map