import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export function runFrameworkVersionCheck(vaultPath, currentFrameworkVersion = "1.5.0") {
    const findings = [];
    const candidateLocks = [
        "00_System/Config/framework.lock",
        "90-system/framework.lock",
        "framework.lock"
    ];
    for (const rel of candidateLocks) {
        const fullPath = join(vaultPath, rel);
        if (existsSync(fullPath)) {
            try {
                const lock = JSON.parse(readFileSync(fullPath, "utf8"));
                const lockedVer = String(lock.framework_version || "").trim();
                if (!lockedVer) {
                    findings.push({
                        rule: "framework-version",
                        severity: "error",
                        file: rel,
                        message: `Lockfile missing "framework_version" string.`
                    });
                    continue;
                }
                const parseParts = (v) => v.split(".").map((n) => parseInt(n, 10));
                const [lockedMajor, lockedMinor] = parseParts(lockedVer);
                const [currMajor, currMinor] = parseParts(currentFrameworkVersion);
                if (lockedMajor !== currMajor) {
                    findings.push({
                        rule: "framework-version",
                        severity: "error",
                        file: rel,
                        message: `Framework major version mismatch: locked to ${lockedVer}, current engine is ${currentFrameworkVersion}.`
                    });
                }
                else if (lockedMinor < currMinor) {
                    findings.push({
                        rule: "framework-version",
                        severity: "warning",
                        file: rel,
                        message: `Vault locked to ${lockedVer}, older than framework ${currentFrameworkVersion}. Run "sb upgrade" or update lock.`
                    });
                }
            }
            catch (err) {
                findings.push({
                    rule: "framework-version",
                    severity: "error",
                    file: rel,
                    message: `Malformed framework lock JSON: ${err instanceof Error ? err.message : String(err)}`
                });
            }
        }
    }
    return findings;
}
//# sourceMappingURL=framework-version.js.map