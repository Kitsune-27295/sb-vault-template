import { VaultDatabase } from "../db/database.js";
export type RAGTier = "frugal" | "standard" | "panoramic";
export interface ContextAssemblerOptions {
    tier?: RAGTier;
    includeMermaidGraph?: boolean;
    vaultBasePath?: string;
    customTokenLimit?: number;
}
export interface AssembledContextResult {
    focalUid: string;
    tier: RAGTier;
    estimatedTokens: number;
    characterCount: number;
    includedNodeUids: string[];
    mermaidGraph?: string;
    renderedDossier: string;
}
export declare class ContextAssembler {
    private readonly db;
    constructor(db: VaultDatabase);
    assembleContext(focalUid: string, options?: ContextAssemblerOptions): AssembledContextResult;
    private readNodeBody;
    private generateMermaidSubgraph;
}
//# sourceMappingURL=context-assembler.d.ts.map