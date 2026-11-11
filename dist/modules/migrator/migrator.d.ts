export interface MigrationOptions {
    dryRun?: boolean;
}
export interface MigrationReportItem {
    sourceFile: string;
    targetFile: string;
    type: "markdown" | "docx";
    convertedMermaidTrees: number;
    status: "migrated" | "simulated" | "failed";
    error?: string;
}
export interface MigrationReport {
    totalProcessed: number;
    migratedCount: number;
    failedCount: number;
    dryRun: boolean;
    items: MigrationReportItem[];
}
export declare function walkDirectory(dir: string): string[];
export declare function migrateVault(sourceDir: string, targetDir: string, options?: MigrationOptions): MigrationReport;
//# sourceMappingURL=migrator.d.ts.map