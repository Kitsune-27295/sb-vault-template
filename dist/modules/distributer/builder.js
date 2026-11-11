import { resolve, join, relative } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { computeSha256 } from "../../core/parser/frontmatter.js";
import { runSecretScanCheck } from "../linter/checks/secret-scan.js";
import { lintVault } from "../linter/linter.js";
export function copyRecursive(src, dest, filter) {
    mkdirSync(dest, { recursive: true });
    for (const item of readdirSync(src)) {
        const s = join(src, item);
        const d = join(dest, item);
        if (filter && !filter(s))
            continue;
        const st = statSync(s);
        if (st.isDirectory()) {
            copyRecursive(s, d, filter);
        }
        else {
            copyFileSync(s, d);
        }
    }
}
export function buildDistTemplate(options) {
    const root = resolve(options.repoRoot || process.cwd());
    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version = pkgJson.version || "1.5.0";
    const outDir = resolve(options.outDir);
    if (existsSync(outDir)) {
        rmSync(outDir, { recursive: true, force: true });
    }
    mkdirSync(outDir, { recursive: true });
    console.log(`[build-dist-template] Packaging turnkey Second Brain Vault v${version} into ${outDir}...`);
    // 1. Copy vault-template contents
    const vaultTemplateDir = join(root, "vault-template");
    if (existsSync(vaultTemplateDir)) {
        copyRecursive(vaultTemplateDir, outDir, (p) => {
            return !p.includes(".vault/index.db") && !p.includes(".vault\\index.db");
        });
    }
    // 2. Pre-compiled Turnkey Runtime Engine: bin/ + dist/
    const binTarget = join(outDir, "bin");
    mkdirSync(binTarget, { recursive: true });
    copyFileSync(join(root, "bin", "sb.js"), join(binTarget, "sb.js"));
    const distTarget = join(outDir, "dist");
    const distSrc = join(root, "dist");
    if (existsSync(distSrc)) {
        copyRecursive(distSrc, distTarget);
    }
    // 3. Multi-Agent Governance, Skills, Rules & Dual MCP Configuration
    const agentsTarget = join(outDir, ".agents");
    mkdirSync(join(agentsTarget, "rules"), { recursive: true });
    mkdirSync(join(agentsTarget, "skills"), { recursive: true });
    const rulesSrc = join(root, ".agents", "rules");
    if (existsSync(rulesSrc))
        copyRecursive(rulesSrc, join(agentsTarget, "rules"));
    const skillsSrc = join(root, ".agents", "skills");
    if (existsSync(skillsSrc))
        copyRecursive(skillsSrc, join(agentsTarget, "skills"));
    // Copy root AGENTS.md
    if (existsSync(join(root, "AGENTS.md"))) {
        copyFileSync(join(root, "AGENTS.md"), join(outDir, "AGENTS.md"));
    }
    // Dual MCP Configs (Antigravity & Claude Code / Cursor)
    const turnkeyMcpConfig = {
        mcpServers: {
            "second-brain": {
                command: "node",
                args: ["./dist/modules/mcp/server.js"],
                env: {
                    VAULT_PATH: ".",
                    SB_VAULT_PATH: "."
                }
            }
        }
    };
    writeFileSync(join(agentsTarget, "mcp_config.json"), JSON.stringify(turnkeyMcpConfig, null, 2), "utf8");
    writeFileSync(join(outDir, ".mcp.json"), JSON.stringify(turnkeyMcpConfig, null, 2), "utf8");
    // 4. Consumer-Ready GitHub Actions (.github/workflows/nightly-repo-sync.yml & vault-doctor.yml)
    const ghWorkflowsTarget = join(outDir, ".github", "workflows");
    mkdirSync(ghWorkflowsTarget, { recursive: true });
    const nightlyWfSrc = join(vaultTemplateDir, "00_System", "Automation", "nightly-repo-sync.yml");
    if (existsSync(nightlyWfSrc)) {
        copyFileSync(nightlyWfSrc, join(ghWorkflowsTarget, "nightly-repo-sync.yml"));
    }
    writeFileSync(join(ghWorkflowsTarget, "vault-doctor.yml"), `name: vault-doctor\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\npermissions:\n  contents: read\n\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n      - run: npm ci\n      - name: Rebuild Index & Run Doctor Audit\n        run: npm run setup\n`, "utf8");
    // 5. Turnkey Consumer package.json
    const consumerPkg = {
        name: "sb-vault-template",
        version: version,
        license: "MIT",
        description: "Production-ready Second Brain Vault & Pre-Compiled Engine: local-first PKM with SQLite WAL/FTS5, 3-tier RAG, and native MCP server.",
        type: "module",
        engines: {
            node: ">=22"
        },
        bin: {
            sb: "./bin/sb.js",
            sbk: "./bin/sb.js"
        },
        scripts: {
            setup: "node ./bin/sb.js index . && node ./bin/sb.js doctor .",
            index: "node ./bin/sb.js index .",
            doctor: "node ./bin/sb.js doctor .",
            watch: "node ./bin/sb.js watch .",
            "sync-repos": "node ./bin/sb.js sync-repos --ingest --vault .",
            mcp: "node ./dist/modules/mcp/server.js"
        },
        dependencies: {
            "@modelcontextprotocol/sdk": pkgJson.dependencies["@modelcontextprotocol/sdk"],
            "better-sqlite3": pkgJson.dependencies["better-sqlite3"],
            chokidar: pkgJson.dependencies["chokidar"],
            yaml: pkgJson.dependencies["yaml"],
            zod: pkgJson.dependencies["zod"]
        }
    };
    writeFileSync(join(outDir, "package.json"), JSON.stringify(consumerPkg, null, 2), "utf8");
    // 6. Consumer package-lock.json (strip upstream devDependencies for clean npm ci)
    if (existsSync(join(root, "package-lock.json"))) {
        try {
            const lockObj = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
            lockObj.name = "sb-vault-template";
            lockObj.version = version;
            if (lockObj.packages && lockObj.packages[""]) {
                lockObj.packages[""].name = "sb-vault-template";
                lockObj.packages[""].version = version;
                delete lockObj.packages[""].devDependencies;
            }
            writeFileSync(join(outDir, "package-lock.json"), JSON.stringify(lockObj, null, 2), "utf8");
        }
        catch {
            // fallback
        }
    }
    // 7. Stamp framework.lock
    const lockData = {
        framework_version: version,
        packaged_at: new Date().toISOString(),
        distribution: "Kitsune-27295/sb-vault-template"
    };
    writeFileSync(join(outDir, "framework.lock"), JSON.stringify(lockData, null, 2), "utf8");
    // 8. Consumer documentation & .gitignore
    writeFileSync(join(outDir, ".gitignore"), `# SO / editor\n.DS_Store\nThumbs.db\n.vscode/\n.idea/\n\n# Secrets\n.env\n.env.*\n!*.env.example\n*.pem\n*.key\n\n# Dependencies\nnode_modules/\n\n# Ephemeral Vault Database Index\n.vault/\n*.db\n*.db-wal\n*.db-shm\n\n# Claude Code local\n.claude/settings.local.json\n`, "utf8");
    const consumerReadme = `# Second Brain Vault Template (v${version})

Production-grade, local-first **Second Brain (PKM) Vault** powered by the **Second Brain Framework Engine**.

\`\`\`mermaid
flowchart LR
    A["Use this template"] --> B["Clone to Local Machine"]
    B --> C["npm install && npm run setup"]
    C --> D["Open in Obsidian & Antigravity/Claude IDE"]
    D --> E["Native MCP Tools + Skills Ready!"]
\`\`\`

---

## Quickstart Guide

### 1. Installation
Ensure you have **Node.js >= 22** installed, then in your cloned vault directory run:

\`\`\`bash
npm install
npm run setup
\`\`\`

\`npm run setup\` will index your vault into an ephemeral SQLite WAL database (\`.vault/index.db\`) and execute the comprehensive 14+ invariant Doctor audit.

### 2. Available Commands (\`sb\` / \`npm run\`)

* **Rebuild Index:** \`npm run index\` or \`npx sb index .\`
* **Real-time File Watcher:** \`npm run watch\` or \`npx sb watch .\`
* **Vault Doctor Health Audit:** \`npm run doctor\` or \`npx sb doctor .\`
* **Harvest Documentation from GitHub:** \`npm run sync-repos\`
* **Wire an External Software Project:** \`npx sb connect-workspace <project-path> --vault .\`
* **Start stdio MCP Server:** \`npm run mcp\`

---

## Multi-Agent IDE Integration

This vault is pre-configured with **Dual MCP Support**:
* **Google Antigravity IDE:** Pre-wired via \`.agents/mcp_config.json\`.
* **Anthropic Claude Code & Cursor:** Pre-wired via \`.mcp.json\`.

All canonical slash skills (\`/new-brain\`, \`/capture-zettel\`, \`/synthesize-topic\`, \`/audit-brain\`, \`/deep-research\`, \`/migrate-notes\`, \`/watch-repos\`) are ready in \`.agents/skills/\`.

---

## Automated Documentation Watchtower

Add any public GitHub documentation URL to \`00_System/Watchlist_Repos.md\`.
The bundled GitHub Actions workflow (\`.github/workflows/nightly-repo-sync.yml\`) will automatically check for upstream updates every night at 03:00 UTC and commit fresh documentation into your vault!
`;
    writeFileSync(join(outDir, "README.md"), consumerReadme, "utf8");
    // 9. Run the 6-point Hardened Publish Guard
    runPublishGuard(outDir, version);
    const allStagedFiles = getAllFiles(outDir);
    const combinedHashes = allStagedFiles
        .map((f) => {
        const rel = relative(outDir, f).replace(/\\/g, "/");
        const hash = computeSha256(readFileSync(f, "utf8"));
        return `${rel}:${hash}`;
    })
        .sort()
        .join("\n");
    const treeHash = computeSha256(combinedHashes);
    console.log(`[build-dist-template] Successfully built distribution bundle!`);
    console.log(`* Output Dir: ${outDir}`);
    console.log(`* File Count: ${allStagedFiles.length}`);
    console.log(`* Tree Hash: ${treeHash}`);
    return {
        outDir,
        fileCount: allStagedFiles.length,
        treeHash
    };
}
export function getAllFiles(dir) {
    const files = [];
    for (const item of readdirSync(dir)) {
        const full = join(dir, item);
        const st = statSync(full);
        if (st.isDirectory()) {
            files.push(...getAllFiles(full));
        }
        else {
            files.push(full);
        }
    }
    return files;
}
export function runPublishGuard(stagedDir, expectedVersion) {
    console.log(`[publish-guard] Running 6-Point Hardened Gate on ${stagedDir}...`);
    const stagedFiles = getAllFiles(stagedDir);
    const relPaths = stagedFiles.map((f) => relative(stagedDir, f).replace(/\\/g, "/"));
    // Gate 1: Zero Upstream Source Leak
    const forbiddenPrefixes = ["src/", "tests/", "INPUT/", "docs/inspirations/", "tsconfig.json", "vitest.config.ts"];
    for (const rel of relPaths) {
        for (const forbidden of forbiddenPrefixes) {
            if (rel === forbidden || rel.startsWith(forbidden)) {
                throw new Error(`[publish-guard FAIL] Upstream source leak detected in staged bundle: ${rel}`);
            }
        }
    }
    // Gate 2: Zero Personal Path / PII Leak
    const personalPatterns = [/C:[\\/]Users[\\/]/i, /fabriciosilvafreitas69@gmail\.com/i];
    for (const file of stagedFiles) {
        if (/\.(png|jpg|db|woff2?)$/i.test(file))
            continue;
        const content = readFileSync(file, "utf8");
        for (const pat of personalPatterns) {
            if (pat.test(content)) {
                throw new Error(`[publish-guard FAIL] Personal developer path or PII detected in ${file}: matches ${pat}`);
            }
        }
    }
    // Gate 3: Secret Scan Gate
    const secretFindings = runSecretScanCheck(stagedDir);
    if (secretFindings.length > 0) {
        throw new Error(`[publish-guard FAIL] Secret pattern detected in staged bundle: ${JSON.stringify(secretFindings)}`);
    }
    // Gate 4: Live Smoke Test & Doctor Gate
    const report = lintVault(stagedDir);
    if (report.errorCount > 0) {
        throw new Error(`[publish-guard FAIL] Doctor audit failed with ${report.errorCount} errors in staged bundle: ${JSON.stringify(report.findings)}`);
    }
    // Gate 5: Version & framework.lock Sync
    const lockPath = join(stagedDir, "framework.lock");
    if (!existsSync(lockPath)) {
        throw new Error(`[publish-guard FAIL] Missing framework.lock in staged bundle.`);
    }
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.framework_version !== expectedVersion) {
        throw new Error(`[publish-guard FAIL] Version mismatch: framework.lock has ${lock.framework_version}, expected ${expectedVersion}`);
    }
    // Gate 6: Mermaid Compliance Gate
    for (const file of stagedFiles.filter((f) => f.endsWith(".md"))) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("```text") || line.startsWith("```plaintext")) {
                throw new Error(`[publish-guard FAIL] ASCII text block detected in ${file}:${i + 1}`);
            }
        }
    }
    const vaultDbDir = join(stagedDir, ".vault");
    if (existsSync(vaultDbDir)) {
        rmSync(vaultDbDir, { recursive: true, force: true });
    }
    console.log(`[publish-guard PASS] All 6 gates passed cleanly for v${expectedVersion}!`);
}
//# sourceMappingURL=builder.js.map