import { readFileSync } from "node:fs";
import { walkDirectory } from "../../migrator/migrator.js";
const PLACEHOLDER = /changeme|change-me|example|placeholder|redacted|your[-_ ]|xxxx|dummy|sample/i;
function isNonTrivialLiteral(match) {
    const value = match[1];
    if (/^[$%{[*]/.test(value))
        return false; // ${VAR}, %VAR%, {{ var }}, [REDACTED], ****
    if (/^[\w.]+\(/.test(value))
        return false; // function call
    if (PLACEHOLDER.test(value))
        return false;
    if (/^(.)\1+$/.test(value))
        return false; // one repeated character
    return /[^A-Za-z_.-]/.test(value);
}
export const SECRET_PATTERNS = Object.freeze([
    {
        name: "aws-access-key-id",
        description: "Cloud access key id (AWS style)",
        regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/
    },
    {
        name: "gcp-api-key",
        description: "Cloud API key (Google style)",
        regex: /\bAIza[0-9A-Za-z_-]{35}\b/
    },
    {
        name: "github-token",
        description: "GitHub personal access token or app token",
        regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/
    },
    {
        name: "slack-token",
        description: "Slack API token",
        regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/
    },
    {
        name: "api-token-prefix",
        description: "Generic API key with a well-known prefix",
        regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|[spr]k_(?:live|test)_[A-Za-z0-9]{16,})/
    },
    {
        name: "private-key-block",
        description: "PEM private key block header",
        regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
    },
    {
        name: "jwt",
        description: "JSON Web Token pattern",
        regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
    },
    {
        name: "credential-assignment",
        description: "Password or secret assignment with literal value",
        regex: /(?:password|passwd|secret|token)["']?\s*(?:=(?!=)|:(?!:))\s*["']?([^\s"'`,;<>=]{8,})/i,
        accept: isNonTrivialLiteral
    }
]);
export function scanTextForSecrets(text, relPath) {
    const findings = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of SECRET_PATTERNS) {
            const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
            const match = regex.exec(line);
            if (match) {
                if (!pattern.accept || pattern.accept(match)) {
                    findings.push({
                        rule: "secret-scan",
                        severity: "error",
                        file: relPath,
                        line: i + 1,
                        message: `Secret pattern "${pattern.name}" detected on line ${i + 1} (${pattern.description})`
                    });
                    break; // report at most one pattern per line
                }
            }
        }
    }
    return findings;
}
export function runSecretScanCheck(vaultPath) {
    const files = walkDirectory(vaultPath);
    const findings = [];
    for (const file of files) {
        const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
        // Skip quarantine folders as they contain intentional captures under review
        if (rel.includes("quarantine/") || rel.includes("_quarantine/"))
            continue;
        try {
            const buffer = readFileSync(file);
            // Check if text (no NUL bytes in first 8KB)
            const probe = buffer.subarray(0, 8192);
            if (probe.includes(0))
                continue;
            const text = buffer.toString("utf8");
            findings.push(...scanTextForSecrets(text, rel));
        }
        catch {
            // Ignore read errors
        }
    }
    return findings;
}
//# sourceMappingURL=secret-scan.js.map