import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const TIER_BUDGETS = {
    frugal: 4000,
    standard: 16000,
    panoramic: 64000
};
export class ContextAssembler {
    db;
    constructor(db) {
        this.db = db;
    }
    assembleContext(focalUid, options = {}) {
        const tier = options.tier || "standard";
        const tokenBudget = options.customTokenLimit || TIER_BUDGETS[tier];
        const charBudget = tokenBudget * 4;
        const includeMermaid = options.includeMermaidGraph ?? false;
        const focalNode = this.db.getNode(focalUid);
        if (!focalNode) {
            throw new Error(`Node with UID "${focalUid}" not found in vault index.`);
        }
        const depth = tier === "frugal" ? 1 : tier === "standard" ? 2 : 3;
        const neighborhood = this.db.getNodeNeighbors(focalUid, depth);
        // Optional BM25 associative search for standard and panoramic
        let associatedNodes = [];
        if (tier !== "frugal") {
            const searchHits = this.db.searchNodesFts(focalNode.title, 5);
            for (const hit of searchHits) {
                if (!neighborhood.nodes.some((n) => n.uid === hit.uid)) {
                    const hitNode = this.db.getNode(hit.uid);
                    if (hitNode)
                        associatedNodes.push(hitNode);
                }
            }
        }
        const allCandidateNodes = [...neighborhood.nodes, ...associatedNodes];
        const candidateEdges = neighborhood.edges;
        // Build Mermaid Topology Diagram if requested
        let mermaidDiagram;
        if (includeMermaid && candidateEdges.length > 0) {
            mermaidDiagram = this.generateMermaidSubgraph(focalUid, candidateEdges, allCandidateNodes);
        }
        // Assemble Dossier Blocks respecting token budget
        const includedUids = [];
        const dossierSections = [];
        // Header
        dossierSections.push(`# Knowledge Context Dossier: ${focalNode.title} (${focalNode.uid})\n`);
        dossierSections.push(`**Tier:** ${tier.toUpperCase()} | **Budget:** ~${tokenBudget} tokens | **Status:** ${focalNode.status} | **Epistemic:** ${focalNode.epistemic_confidence}\n`);
        if (mermaidDiagram) {
            dossierSections.push(`## Relationship Topology\n\n${mermaidDiagram}\n`);
        }
        // Focal Note Section
        const focalContent = this.readNodeBody(focalNode, options.vaultBasePath);
        dossierSections.push(`## Focal Note: ${focalNode.title} [${focalNode.uid}]\n`);
        dossierSections.push(`*File:* \`${focalNode.file_path}\`\n`);
        if (focalNode.raw_yaml) {
            dossierSections.push(`\`\`\`yaml\n${focalNode.raw_yaml.trim()}\n\`\`\`\n`);
        }
        dossierSections.push(`${focalContent}\n`);
        includedUids.push(focalNode.uid);
        let currentLength = dossierSections.join("\n").length;
        // Neighbor Nodes
        if (neighborhood.nodes.length > 1) {
            dossierSections.push(`## Connected Graph Neighborhood\n`);
            for (const node of neighborhood.nodes) {
                if (node.uid === focalUid)
                    continue;
                const body = this.readNodeBody(node, options.vaultBasePath);
                const sectionSnippet = `### ${node.title} [${node.uid}]\n*Type:* \`${node.type}\` | *Status:* \`${node.status}\` | *Path:* \`${node.file_path}\`\n\n${body}\n`;
                if (currentLength + sectionSnippet.length > charBudget) {
                    // Truncate to summary if budget is tight
                    const fallbackSummary = `### ${node.title} [${node.uid}] (Summary)\n*Type:* \`${node.type}\` | *Path:* \`${node.file_path}\`\n\n${body.slice(0, 300)}...\n`;
                    if (currentLength + fallbackSummary.length <= charBudget) {
                        dossierSections.push(fallbackSummary);
                        includedUids.push(node.uid);
                        currentLength += fallbackSummary.length;
                    }
                    break;
                }
                else {
                    dossierSections.push(sectionSnippet);
                    includedUids.push(node.uid);
                    currentLength += sectionSnippet.length;
                }
            }
        }
        // Associated FTS Matches (Panoramic / Standard)
        if (associatedNodes.length > 0 && currentLength < charBudget) {
            dossierSections.push(`## Associated Knowledge (Lexical Matches)\n`);
            for (const assoc of associatedNodes) {
                const snippet = `* **${assoc.title}** [\`${assoc.uid}\`]: ${assoc.type} in \`${assoc.file_path}\`\n`;
                if (currentLength + snippet.length <= charBudget) {
                    dossierSections.push(snippet);
                    includedUids.push(assoc.uid);
                    currentLength += snippet.length;
                }
            }
        }
        const renderedDossier = dossierSections.join("\n");
        const characterCount = renderedDossier.length;
        const estimatedTokens = Math.ceil(characterCount / 4);
        return {
            focalUid,
            tier,
            estimatedTokens,
            characterCount,
            includedNodeUids: includedUids,
            mermaidGraph: mermaidDiagram,
            renderedDossier
        };
    }
    readNodeBody(node, basePath) {
        if (!basePath)
            return `(Node content indexed at ${node.file_path})`;
        const fullPath = resolve(basePath, node.file_path);
        if (!existsSync(fullPath)) {
            return `(File on disk not found: ${node.file_path})`;
        }
        const raw = readFileSync(fullPath, "utf8");
        // Strip frontmatter to return body
        const parts = raw.split(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        return (parts[1] || parts[0] || "").trim();
    }
    generateMermaidSubgraph(focalUid, edges, nodes) {
        const nodeMap = new Map();
        for (const n of nodes) {
            nodeMap.set(n.uid, n.title.replace(/"/g, "'"));
        }
        const lines = ["```mermaid", "flowchart LR"];
        const cleanId = (uid) => uid.replace(/[^a-zA-Z0-9_]/g, "_");
        for (const edge of edges) {
            const srcTitle = nodeMap.get(edge.source_uid) || edge.source_uid;
            const tgtTitle = nodeMap.get(edge.target_uid) || edge.target_uid;
            const srcId = cleanId(edge.source_uid);
            const tgtId = cleanId(edge.target_uid);
            const srcLabel = `"${edge.source_uid}: ${srcTitle}"`;
            const tgtLabel = `"${edge.target_uid}: ${tgtTitle}"`;
            const relLabel = `"${edge.relation_type}"`;
            lines.push(`  ${srcId}[${srcLabel}] -->|${relLabel}| ${tgtId}[${tgtLabel}]`);
        }
        lines.push("```");
        return lines.join("\n");
    }
}
//# sourceMappingURL=context-assembler.js.map