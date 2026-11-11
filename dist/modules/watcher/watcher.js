import { watch } from "chokidar";
import { parseNoteContent, computeSha256 } from "../../core/parser/frontmatter.js";
import { isContentNoteFile } from "../linter/linter.js";
import { readFileSync, existsSync } from "node:fs";
import { relative, extname, basename } from "node:path";
export class VaultWatcher {
    vaultPath;
    db;
    options;
    watcher;
    pendingUpdates = new Map();
    knownHashes = new Map();
    constructor(vaultPath, db, options = {}) {
        this.vaultPath = vaultPath;
        this.db = db;
        this.options = options;
    }
    start() {
        const debounceMs = this.options.debounceMs ?? 200;
        this.watcher = watch(this.vaultPath, {
            ignored: [
                "**/node_modules/**",
                "**/.git/**",
                "**/.vault/**",
                "**/dist/**"
            ],
            persistent: true,
            ignoreInitial: false
        });
        this.watcher.on("add", (filePath) => this.scheduleProcess(filePath, debounceMs));
        this.watcher.on("change", (filePath) => this.scheduleProcess(filePath, debounceMs));
        this.watcher.on("unlink", (filePath) => this.handleDelete(filePath));
    }
    scheduleProcess(filePath, debounceMs) {
        if (extname(filePath).toLowerCase() !== ".md")
            return;
        const rel = relative(this.vaultPath, filePath);
        if (!isContentNoteFile(rel))
            return;
        const existingTimeout = this.pendingUpdates.get(filePath);
        if (existingTimeout)
            clearTimeout(existingTimeout);
        const timeout = setTimeout(() => {
            this.pendingUpdates.delete(filePath);
            this.processFile(filePath);
        }, debounceMs);
        this.pendingUpdates.set(filePath, timeout);
    }
    processFile(filePath) {
        if (!existsSync(filePath))
            return;
        try {
            const content = readFileSync(filePath, "utf8");
            const currentHash = computeSha256(content);
            const previousHash = this.knownHashes.get(filePath);
            // Skip update if content hash has not changed
            if (previousHash === currentHash)
                return;
            const relPath = relative(this.vaultPath, filePath);
            const parsed = parseNoteContent(content, basename(filePath, ".md"));
            this.db.upsertNode(parsed, relPath);
            this.knownHashes.set(filePath, currentHash);
            if (this.options.onUpdate) {
                this.options.onUpdate(relPath, parsed.frontmatter.uid);
            }
        }
        catch (err) {
            console.error(`[VaultWatcher] Failed to process ${filePath}:`, err);
        }
    }
    handleDelete(filePath) {
        if (extname(filePath).toLowerCase() !== ".md")
            return;
        const relPath = relative(this.vaultPath, filePath);
        this.knownHashes.delete(filePath);
        // Delete node from db if file path matches
        this.db.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(relPath);
        if (this.options.onDelete) {
            this.options.onDelete(relPath);
        }
    }
    async stop() {
        for (const timeout of this.pendingUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingUpdates.clear();
        if (this.watcher) {
            await this.watcher.close();
        }
    }
}
//# sourceMappingURL=watcher.js.map