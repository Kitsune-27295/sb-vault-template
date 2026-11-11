export interface UpgradeOptions {
    apply?: boolean;
    repoRoot?: string;
    targetVersion?: string;
}
export interface UpgradeChange {
    action: "add" | "update" | "preserve";
    path: string;
    description: string;
}
export interface UpgradeResult {
    vaultPath: string;
    currentVersion: string;
    targetVersion: string;
    applied: boolean;
    changes: UpgradeChange[];
    systemDir: "90-system" | "00_System";
}
export declare function upgradeVault(targetVaultPath: string, options?: UpgradeOptions): Promise<UpgradeResult>;
//# sourceMappingURL=upgrader.d.ts.map