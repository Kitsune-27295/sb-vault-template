import { LintFinding } from "../linter.js";
export interface SecretPattern {
    name: string;
    description: string;
    regex: RegExp;
    accept?: (match: RegExpExecArray) => boolean;
}
export declare const SECRET_PATTERNS: readonly SecretPattern[];
export declare function scanTextForSecrets(text: string, relPath: string): LintFinding[];
export declare function runSecretScanCheck(vaultPath: string): LintFinding[];
//# sourceMappingURL=secret-scan.d.ts.map