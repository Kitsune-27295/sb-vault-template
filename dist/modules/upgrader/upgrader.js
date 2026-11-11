import { resolve, join, relative } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { computeSha256 } from "../../core/parser/frontmatter.js";
import { copyRecursive } from "../distributer/builder.js";
export async function upgradeVault(targetVaultPath, options = {}) {
    const vaultPath = resolve(targetVaultPath);
    const root = resolve(options.repoRoot || process.cwd());
    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const targetVersion = options.targetVersion || pkgJson.version || "1.5.0";
    // 1. Detect System Directory Layout
    let systemDir = "00_System";
    if (existsSync(join(vaultPath, "90-system"))) {
        systemDir = "90-system";
    }
    else if (existsSync(join(vaultPath, "00_System"))) {
        systemDir = "00_System";
    }
    // 2. Read current framework version
    let currentVersion = "unknown";
    const candidateLocks = [
        join(vaultPath, systemDir, "framework.lock"),
        join(vaultPath, systemDir, "Config", "framework.lock"),
        join(vaultPath, "framework.lock")
    ];
    for (const lockPath of candidateLocks) {
        if (existsSync(lockPath)) {
            try {
                const lock = JSON.parse(readFileSync(lockPath, "utf8"));
                if (lock.framework_version) {
                    currentVersion = String(lock.framework_version).trim();
                    break;
                }
            }
            catch {
                // ignore malformed lock
            }
        }
    }
    const changes = [];
    const isApply = options.apply === true;
    // 3. Plan / Apply Engine: bin/ & dist/
    changes.push({
        action: "add",
        path: "bin/sb.js",
        description: "Turnkey Second Brain CLI runner executable"
    });
    changes.push({
        action: "add",
        path: "dist/",
        description: "Pre-compiled Second Brain runtime engine & MCP server"
    });
    if (isApply) {
        const binTarget = join(vaultPath, "bin");
        mkdirSync(binTarget, { recursive: true });
        copyFileSync(join(root, "bin", "sb.js"), join(binTarget, "sb.js"));
        const distTarget = join(vaultPath, "dist");
        const distSrc = join(root, "dist");
        if (existsSync(distSrc)) {
            copyRecursive(distSrc, distTarget);
        }
    }
    // 4. Plan / Apply Dual MCP & Multi-Agent Governance: .mcp.json & .agents/
    changes.push({
        action: "add",
        path: ".mcp.json",
        description: "Turnkey MCP configuration for Antigravity & Claude Code"
    });
    changes.push({
        action: "add",
        path: ".agents/mcp_config.json",
        description: "IDE & agent MCP server config"
    });
    changes.push({
        action: "add",
        path: ".agents/rules/",
        description: "Multi-Agent governance rules"
    });
    changes.push({
        action: "add",
        path: ".agents/skills/",
        description: "Canonical Second Brain agent skills"
    });
    if (isApply) {
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
        writeFileSync(join(vaultPath, ".mcp.json"), JSON.stringify(turnkeyMcpConfig, null, 2), "utf8");
        const agentsDir = join(vaultPath, ".agents");
        mkdirSync(join(agentsDir, "rules"), { recursive: true });
        mkdirSync(join(agentsDir, "skills"), { recursive: true });
        writeFileSync(join(agentsDir, "mcp_config.json"), JSON.stringify(turnkeyMcpConfig, null, 2), "utf8");
        const rulesSrc = join(root, ".agents", "rules");
        if (existsSync(rulesSrc))
            copyRecursive(rulesSrc, join(agentsDir, "rules"));
        const skillsSrc = join(root, ".agents", "skills");
        if (existsSync(skillsSrc))
            copyRecursive(skillsSrc, join(agentsDir, "skills"));
    }
    // 5. Plan / Apply Consumer package.json & package-lock.json
    changes.push({
        action: "add",
        path: "package.json",
        description: "Turnkey consumer scripts (npm run setup, index, doctor, watch, mcp)"
    });
    changes.push({
        action: "add",
        path: "package-lock.json",
        description: "Pinned consumer dependencies without upstream devDependencies"
    });
    if (isApply) {
        const consumerPkg = {
            name: "second-brain-vault",
            version: targetVersion,
            license: "MIT",
            description: "Second Brain Vault with Pre-Compiled Engine, SQLite WAL/FTS5, 3-tier RAG, and native MCP server.",
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
        writeFileSync(join(vaultPath, "package.json"), JSON.stringify(consumerPkg, null, 2), "utf8");
        if (existsSync(join(root, "package-lock.json"))) {
            try {
                const lockObj = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
                lockObj.name = "second-brain-vault";
                lockObj.version = targetVersion;
                if (lockObj.packages && lockObj.packages[""]) {
                    lockObj.packages[""].name = "second-brain-vault";
                    lockObj.packages[""].version = targetVersion;
                    delete lockObj.packages[""].devDependencies;
                }
                writeFileSync(join(vaultPath, "package-lock.json"), JSON.stringify(lockObj, null, 2), "utf8");
            }
            catch {
                // fallback
            }
        }
    }
    // 6. Plan / Apply Consumer CI Workflows
    changes.push({
        action: "add",
        path: ".github/workflows/vault-doctor.yml",
        description: "Automated GitHub Actions health validation"
    });
    changes.push({
        action: "add",
        path: ".github/workflows/nightly-repo-sync.yml",
        description: "Automated GitHub repository documentation sync"
    });
    if (isApply) {
        const ghWorkflows = join(vaultPath, ".github", "workflows");
        mkdirSync(ghWorkflows, { recursive: true });
        writeFileSync(join(ghWorkflows, "vault-doctor.yml"), `name: vault-doctor\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\npermissions:\n  contents: read\n\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n      - run: npm ci\n      - name: Rebuild Index & Run Doctor Audit\n        run: npm run setup\n`, "utf8");
        const nightlySrc = join(root, "vault-template", "00_System", "Automation", "nightly-repo-sync.yml");
        if (existsSync(nightlySrc)) {
            copyFileSync(nightlySrc, join(ghWorkflows, "nightly-repo-sync.yml"));
        }
    }
    // 7. Plan / Apply System Schemas & Templates
    if (systemDir === "90-system") {
        changes.push({
            action: "update",
            path: "90-system/schema/note-schema.yaml",
            description: "Canonical note schema"
        });
        changes.push({
            action: "update",
            path: "90-system/framework.lock",
            description: `Stamp framework.lock to v${targetVersion}`
        });
        if (isApply) {
            const schemaSrc = join(root, "vault-template", "00_System", "Config", "note-schema.yaml");
            const schemaDest = join(vaultPath, "90-system", "schema", "note-schema.yaml");
            mkdirSync(join(vaultPath, "90-system", "schema"), { recursive: true });
            if (existsSync(schemaSrc)) {
                copyFileSync(schemaSrc, schemaDest);
            }
            // Hash system files for framework.lock
            const sysFiles = {};
            const sysDir = join(vaultPath, "90-system");
            const scanDir = (d) => {
                if (!existsSync(d))
                    return;
                for (const item of readdirSync(d)) {
                    const p = join(d, item);
                    if (statSync(p).isDirectory()) {
                        scanDir(p);
                    }
                    else if (item !== "framework.lock") {
                        const rel = relative(vaultPath, p).replace(/\\/g, "/");
                        sysFiles[rel] = computeSha256(readFileSync(p, "utf8"));
                    }
                }
            };
            scanDir(sysDir);
            const updatedLock = {
                framework_version: targetVersion,
                upgraded_at: new Date().toISOString(),
                distribution: "second-brain-framework",
                files: sysFiles
            };
            writeFileSync(join(vaultPath, "90-system", "framework.lock"), JSON.stringify(updatedLock, null, 2), "utf8");
        }
    }
    else {
        // 00_System
        changes.push({
            action: "update",
            path: "00_System/Config/note-schema.yaml",
            description: "Canonical note schema"
        });
        changes.push({
            action: "update",
            path: "framework.lock",
            description: `Stamp framework.lock to v${targetVersion}`
        });
        if (isApply) {
            const configDest = join(vaultPath, "00_System", "Config");
            mkdirSync(configDest, { recursive: true });
            const schemaSrc = join(root, "vault-template", "00_System", "Config", "note-schema.yaml");
            if (existsSync(schemaSrc)) {
                copyFileSync(schemaSrc, join(configDest, "note-schema.yaml"));
            }
            const updatedLock = {
                framework_version: targetVersion,
                upgraded_at: new Date().toISOString(),
                distribution: "second-brain-framework"
            };
            writeFileSync(join(vaultPath, "framework.lock"), JSON.stringify(updatedLock, null, 2), "utf8");
        }
    }
    // 8. Update AGENTS.md with canonical governance & Mermaid diagram
    changes.push({
        action: "update",
        path: "AGENTS.md",
        description: "Update multi-agent contract with bilingual governance and Mermaid visual standards"
    });
    if (isApply) {
        const agentsPath = join(vaultPath, "AGENTS.md");
        if (existsSync(agentsPath)) {
            const existingAgents = readFileSync(agentsPath, "utf8");
            // If it's an instance AGENTS.md (starts with Second Brain Instance), append the new MCP & governance sections
            if (!existingAgents.includes("sb_assemble_context")) {
                const canonicalSnippet = `
## Native Model Context Protocol (MCP) Tools

When interacting with this vault, agents execute operations via the 10 canonical MCP tools:
1. \`sb_assemble_context\`: Assembles token-budgeted 3-tier RAG context dossiers.
2. \`sb_search_knowledge\`: Searches notes via hybrid FTS5 BM25 and degree centrality scoring.
3. \`sb_inspect_page\`: Inspects candidate note provenance, status and connected neighbors.
4. \`sb_clip_web_source\`: Clips web URLs or raw text to Inbox with SHA-256 sidecars.
5. \`sb_get_node_graph\`: Retrieves directed graph neighborhood.
6. \`sb_upsert_node\`: Atomically creates or updates notes with Zod frontmatter validation.
7. \`sb_lint_vault\`: Runs vault health audits checking links, orphans, and schemas.
8. \`sb_index_vault\`: Rebuilds SQLite lexical and graph database.
9. \`sb_vault_stats\`: Retrieves knowledge graph density metrics.
10. \`sb_create_from_template\`: Scaffolds notes instantiated from canonical templates.
`;
                writeFileSync(agentsPath, existingAgents.trimEnd() + "\n" + canonicalSnippet, "utf8");
            }
        }
    }
    // 9. Update .gitignore
    changes.push({
        action: "update",
        path: ".gitignore",
        description: "Ensure .vault/ and ephemeral index files are ignored"
    });
    if (isApply) {
        const gitignorePath = join(vaultPath, ".gitignore");
        let gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        if (!gitignoreContent.includes(".vault/")) {
            gitignoreContent += "\n# Ephemeral Vault Database Index\n.vault/\n*.db\n*.db-wal\n*.db-shm\nnode_modules/\n";
            writeFileSync(gitignorePath, gitignoreContent, "utf8");
        }
    }
    return {
        vaultPath,
        currentVersion,
        targetVersion,
        applied: isApply,
        changes,
        systemDir
    };
}
//# sourceMappingURL=upgrader.js.map