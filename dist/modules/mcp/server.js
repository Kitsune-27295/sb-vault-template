import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve, join, dirname, basename } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { VaultDatabase } from "../../core/db/database.js";
import { ContextAssembler } from "../../core/rag/context-assembler.js";
import { parseNoteContent } from "../../core/parser/frontmatter.js";
import { lintVault, isContentNoteFile } from "../linter/linter.js";
import { walkDirectory } from "../migrator/migrator.js";
import { clipSource } from "../cli/clipper.js";
import { ingestPendingSources } from "../../core/memory/context-memory.js";
import { GitHubWatchtower } from "../watchtower/github-watcher.js";
import { ENGINE_VERSION } from "../../core/version.js";
import { instantiateTemplate } from "../../core/template-vars.js";
export function createSecondBrainMcpServer(vaultPath) {
    const dbPath = join(vaultPath, ".vault", "index.db");
    const db = new VaultDatabase(dbPath);
    const assembler = new ContextAssembler(db);
    const server = new Server({
        name: "second-brain-engine",
        version: ENGINE_VERSION
    }, {
        capabilities: {
            tools: {}
        }
    });
    const TOOLS = [
        {
            name: "sb_assemble_context",
            description: "Assemble a token-budgeted 3-tier RAG context dossier (frugal, standard, panoramic) with optional Mermaid relationship topology.",
            inputSchema: {
                type: "object",
                properties: {
                    uid: { type: "string", description: "Target note UID (e.g. ZET-0001, CON-0042)" },
                    tier: {
                        type: "string",
                        enum: ["frugal", "standard", "panoramic"],
                        description: "Context budget tier: frugal (<=4k tokens), standard (<=16k tokens), panoramic (<=64k tokens)"
                    },
                    includeMermaidGraph: {
                        type: "boolean",
                        description: "Whether to embed an executable ```mermaid flowchart graph into the dossier"
                    }
                },
                required: ["uid"]
            }
        },
        {
            name: "sb_search_knowledge",
            description: "Search notes across the vault using hybrid FTS5 BM25 text ranking and graph degree centrality scoring.",
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Natural language search query or keywords" },
                    type: { type: "string", description: "Filter by note type (e.g., zettel, concept, project, decision)" },
                    limit: { type: "number", description: "Maximum number of results to return (default 20)" }
                },
                required: ["query"]
            }
        },
        {
            name: "sb_inspect_page",
            description: "Inspect a candidate note's epistemic provenance, status, confidence, sources, headings, and connected neighbors.",
            inputSchema: {
                type: "object",
                properties: {
                    uidOrTitle: { type: "string", description: "Target note UID or title" },
                    section: { type: "string", description: "Optional heading section to isolate" }
                },
                required: ["uidOrTitle"]
            }
        },
        {
            name: "sb_clip_web_source",
            description: "Securely clip a web URL (or provided Markdown) to the vault's Inbox with cryptographic SHA-256 sidecar, credential scanning, and deduplication.",
            inputSchema: {
                type: "object",
                properties: {
                    url: { type: "string", description: "Source URL or local file path" },
                    title: { type: "string", description: "Human title of the source (optional)" },
                    markdownContent: { type: "string", description: "Pre-scraped clean markdown content (optional)" }
                },
                required: ["url"]
            }
        },
        {
            name: "sb_ingest_sources",
            description: "Ingest pending raw sources from the inbox into curated literature zettels, append to operation log and refresh memory.",
            inputSchema: {
                type: "object",
                properties: {
                    sourceId: { type: "string", description: "Specific source ID to ingest (optional; default all pending)" }
                }
            }
        },
        {
            name: "sb_sync_watched_repos",
            description: "Run incremental commit and diff sync for all repositories in Watchlist_Repos.md without full git clones.",
            inputSchema: {
                type: "object",
                properties: {
                    autoIngest: { type: "boolean", description: "Whether to auto-ingest modified docs into literature zettels" }
                }
            }
        },
        {
            name: "sb_get_node_graph",
            description: "Retrieve the directed graph neighborhood (inbound and outbound edges) of a node to a specified depth.",
            inputSchema: {
                type: "object",
                properties: {
                    uid: { type: "string", description: "Focal note UID" },
                    depth: { type: "number", description: "Neighborhood traversal depth (default 1, max 3)" }
                },
                required: ["uid"]
            }
        },
        {
            name: "sb_upsert_node",
            description: "Atomically create or update a vault note with Zod frontmatter validation and immediate SQLite index synchronization.",
            inputSchema: {
                type: "object",
                properties: {
                    relPath: { type: "string", description: "Relative markdown file path (e.g. 02_Zettelkasten/02_Permanent_Notes/zet-new.md)" },
                    content: { type: "string", description: "Complete note content including YAML frontmatter envelope" }
                },
                required: ["relPath", "content"]
            }
        },
        {
            name: "sb_lint_vault",
            description: "Run comprehensive 14+ invariant health audit (broken links, orphans, schemas, secrets, budgets, integrity).",
            inputSchema: {
                type: "object",
                properties: {
                    checks: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional list of specific check IDs to run (e.g. ['secret-scan', 'broken-link'])"
                    }
                }
            }
        },
        {
            name: "sb_index_vault",
            description: "Trigger a full or incremental rebuild of the SQLite lexical and graph database (.vault/index.db).",
            inputSchema: {
                type: "object",
                properties: {
                    forceRebuild: { type: "boolean", description: "Whether to purge and rebuild all records" }
                }
            }
        },
        {
            name: "sb_vault_stats",
            description: "Retrieve knowledge graph metrics, node counts by type, graph density, and degree centrality highlights.",
            inputSchema: {
                type: "object",
                properties: {}
            }
        },
        {
            name: "sb_create_from_template",
            description: "Scaffold a new note instantiated from a canonical template (e.g., TMP-Zettel, TMP-Concept, TMP-Decision).",
            inputSchema: {
                type: "object",
                properties: {
                    templateName: { type: "string", description: "Name of template (e.g. TMP-Zettel.md, TMP-Decision.md)" },
                    title: { type: "string", description: "Human title of the new note" },
                    relPath: { type: "string", description: "Target relative file path (e.g. 02_Zettelkasten/02_Permanent_Notes/zet-0099.md)" }
                },
                required: ["templateName", "title", "relPath"]
            }
        }
    ];
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return { tools: TOOLS };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const safeArgs = (args || {});
        try {
            switch (name) {
                case "sb_assemble_context": {
                    const uid = String(safeArgs.uid);
                    const tier = safeArgs.tier || "standard";
                    const includeMermaidGraph = Boolean(safeArgs.includeMermaidGraph);
                    const result = assembler.assembleContext(uid, {
                        tier,
                        includeMermaidGraph,
                        vaultBasePath: vaultPath
                    });
                    return {
                        content: [{ type: "text", text: result.renderedDossier }]
                    };
                }
                case "sb_search_knowledge": {
                    const query = String(safeArgs.query);
                    const type = safeArgs.type ? String(safeArgs.type) : undefined;
                    const limit = typeof safeArgs.limit === "number" ? safeArgs.limit : 20;
                    const results = db.searchNodesFts(query, limit, type);
                    return {
                        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
                    };
                }
                case "sb_inspect_page": {
                    const target = String(safeArgs.uidOrTitle);
                    const sectionFilter = safeArgs.section ? String(safeArgs.section).toLowerCase() : undefined;
                    let node = db.getNode(target);
                    if (!node) {
                        const all = db.getAllNodes();
                        node = all.find((n) => n.title.toLowerCase() === target.toLowerCase() || basename(n.file_path, ".md").toLowerCase() === target.toLowerCase());
                    }
                    if (!node) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: `Note "${target}" not found in vault.` }]
                        };
                    }
                    const fullPath = join(vaultPath, node.file_path);
                    const rawContent = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
                    const parsed = parseNoteContent(rawContent, node.uid);
                    const neighborhood = db.getNodeNeighbors(node.uid, 1);
                    let outputContent = parsed.markdownBody;
                    if (sectionFilter) {
                        const lines = parsed.markdownBody.split(/\r?\n/);
                        let inSection = false;
                        const sectionLines = [];
                        for (const line of lines) {
                            const match = line.match(/^#{1,6}\s+(.*)$/);
                            if (match) {
                                if (match[1].toLowerCase().includes(sectionFilter)) {
                                    inSection = true;
                                    sectionLines.push(line);
                                    continue;
                                }
                                else if (inSection) {
                                    break;
                                }
                            }
                            if (inSection)
                                sectionLines.push(line);
                        }
                        outputContent = sectionLines.join("\n").trim() || `(Section "${sectionFilter}" not found)`;
                    }
                    const pageInspection = {
                        uid: node.uid,
                        title: node.title,
                        type: node.type,
                        status: node.status,
                        epistemic_confidence: node.epistemic_confidence,
                        sources: parsed.frontmatter.sources || [],
                        relations: parsed.frontmatter.relations || [],
                        wikiLinks: parsed.wikiLinks,
                        connectedNeighbors: neighborhood.nodes.filter((n) => n.uid !== node.uid).map((n) => ({ uid: n.uid, title: n.title, type: n.type })),
                        content: outputContent
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify(pageInspection, null, 2) }]
                    };
                }
                case "sb_clip_web_source": {
                    const url = String(safeArgs.url);
                    const title = safeArgs.title ? String(safeArgs.title) : undefined;
                    const markdownContent = safeArgs.markdownContent ? String(safeArgs.markdownContent) : undefined;
                    const result = await clipSource({
                        vaultPath,
                        urlOrFile: url,
                        title,
                        markdownContent,
                        json: true
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                    };
                }
                case "sb_ingest_sources": {
                    const sourceId = safeArgs.sourceId ? String(safeArgs.sourceId) : undefined;
                    const result = ingestPendingSources(vaultPath, sourceId);
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                    };
                }
                case "sb_sync_watched_repos": {
                    const autoIngest = Boolean(safeArgs.autoIngest);
                    const watchtower = new GitHubWatchtower(vaultPath);
                    const report = await watchtower.syncWatchedRepos({
                        vaultPath,
                        autoIngest,
                        json: true
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
                    };
                }
                case "sb_get_node_graph": {
                    const uid = String(safeArgs.uid);
                    const depth = Math.min(Math.max(Number(safeArgs.depth || 1), 1), 3);
                    const neighborhood = db.getNodeNeighbors(uid, depth);
                    return {
                        content: [{ type: "text", text: JSON.stringify(neighborhood, null, 2) }]
                    };
                }
                case "sb_upsert_node": {
                    const relPath = String(safeArgs.relPath);
                    const content = String(safeArgs.content);
                    const parsed = parseNoteContent(content);
                    if (parsed.validationError) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: `Schema validation failed: ${parsed.validationError}` }]
                        };
                    }
                    const fullPath = join(vaultPath, relPath);
                    mkdirSync(dirname(fullPath), { recursive: true });
                    writeFileSync(fullPath, content, "utf8");
                    db.upsertNode(parsed, relPath);
                    db.refreshBrokenLinks();
                    return {
                        content: [{ type: "text", text: `Successfully upserted node ${parsed.frontmatter.uid} at ${relPath}.` }]
                    };
                }
                case "sb_lint_vault": {
                    const checkFilter = Array.isArray(safeArgs.checks) ? safeArgs.checks : undefined;
                    const report = lintVault(vaultPath, db, { checks: checkFilter });
                    return {
                        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
                    };
                }
                case "sb_index_vault": {
                    const files = walkDirectory(vaultPath)
                        .filter((f) => f.endsWith(".md"))
                        .filter((f) => isContentNoteFile(f.slice(vaultPath.length + 1)));
                    let indexed = 0;
                    for (const file of files) {
                        try {
                            const content = readFileSync(file, "utf8");
                            const rel = file.slice(vaultPath.length + 1).replace(/\\/g, "/");
                            const parsed = parseNoteContent(content);
                            db.upsertNode(parsed, rel);
                            indexed++;
                        }
                        catch (err) {
                            console.error(`[MCP] Index error in ${file}:`, err);
                        }
                    }
                    const broken = db.refreshBrokenLinks();
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Vault indexed. Total notes: ${indexed}. Broken links detected: ${broken}.`
                            }
                        ]
                    };
                }
                case "sb_vault_stats": {
                    const allNodes = db.getAllNodes();
                    const centrality = db.calculateDegreeCentrality();
                    const typeDistribution = {};
                    for (const n of allNodes) {
                        typeDistribution[n.type] = (typeDistribution[n.type] || 0) + 1;
                    }
                    let totalDegree = 0;
                    for (const deg of centrality.values())
                        totalDegree += deg;
                    const stats = {
                        totalNotes: allNodes.length,
                        totalEdges: totalDegree / 2,
                        averageDegree: allNodes.length > 0 ? (totalDegree / allNodes.length).toFixed(2) : 0,
                        typeDistribution
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
                    };
                }
                case "sb_create_from_template": {
                    const templateName = String(safeArgs.templateName);
                    const title = String(safeArgs.title);
                    const relPath = String(safeArgs.relPath);
                    const tplPath = join(vaultPath, "00_System", "Templates", templateName);
                    if (!existsSync(tplPath)) {
                        return {
                            isError: true,
                            content: [{ type: "text", text: `Template not found: ${tplPath}` }]
                        };
                    }
                    const tplContent = readFileSync(tplPath, "utf8");
                    const dateStr = new Date().toISOString().slice(0, 10);
                    const instantiated = instantiateTemplate(tplContent, title, dateStr);
                    const fullTarget = join(vaultPath, relPath);
                    mkdirSync(dirname(fullTarget), { recursive: true });
                    writeFileSync(fullTarget, instantiated, "utf8");
                    const parsed = parseNoteContent(instantiated);
                    db.upsertNode(parsed, relPath);
                    return {
                        content: [{ type: "text", text: `Instantiated ${templateName} as note "${title}" at ${relPath}.` }]
                    };
                }
                default:
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Unknown tool name: ${name}` }]
                    };
            }
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[MCP Tool Error: ${name}]`, errorMsg);
            return {
                isError: true,
                content: [{ type: "text", text: `Tool execution failed: ${errorMsg}` }]
            };
        }
    });
    return { server, db };
}
export async function startMcpStdioServer(vaultPath) {
    const { server } = createSecondBrainMcpServer(vaultPath);
    const transport = new StdioServerTransport();
    console.error(`[MCP Server] Initializing Second Brain MCP Server for vault: ${vaultPath}`);
    await server.connect(transport);
    console.error(`[MCP Server] Connected to StdioServerTransport.`);
}
if (process.argv[1] && (process.argv[1].endsWith("mcp/server.js") || process.argv[1].endsWith("mcp\\server.js"))) {
    const targetVault = process.env.VAULT_PATH || process.cwd();
    startMcpStdioServer(resolve(targetVault)).catch((err) => {
        console.error("[MCP Fatal Error]", err);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map