import { VaultDatabase } from "../../core/db/database.js";
export type LintRuleId = "broken-link" | "orphan-node" | "schema-violation" | "unlinked-mention" | "secret-scan" | "raw-source-integrity" | "supersede-reference" | "review-overdue" | "ingest-coverage" | "memory-budget" | "framework-version" | "log-append-only" | "capture-ledger" | "mermaid-syntax";
export interface LintFinding {
    rule: LintRuleId | string;
    severity: "error" | "warning" | "info";
    file: string;
    line?: number;
    message: string;
}
export interface LintReport {
    vaultPath: string;
    totalNotes: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    findings: LintFinding[];
    isClean: boolean;
}
export interface LintOptions {
    checks?: string[];
    today?: string;
    frameworkVersion?: string;
}
export declare function isContentNoteFile(relPath: string): boolean;
export declare function isExemptOnInstanceLayout(finding: LintFinding): boolean;
export declare function lintVault(vaultPath: string, db?: VaultDatabase, options?: LintOptions): LintReport;
//# sourceMappingURL=linter.d.ts.map