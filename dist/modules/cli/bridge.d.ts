export interface WorkspaceBridgeConfig {
    targetWorkspacePath: string;
    vaultPath: string;
}
export declare function generateDeepResearchSkill(vaultPath: string): string;
export declare function generateKnowledgeBaseSearchRule(vaultPath: string): string;
export declare function connectWorkspaceToVault(config: WorkspaceBridgeConfig): {
    skillPath: string;
    rulePath: string;
    antigravityMcpPath: string;
    claudeMcpPath: string;
};
//# sourceMappingURL=bridge.d.ts.map