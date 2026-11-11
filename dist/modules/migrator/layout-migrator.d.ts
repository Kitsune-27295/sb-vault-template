export type PlanAction = "move" | "convert" | "remove" | "keep";
export interface PlanItem {
    action: PlanAction;
    from: string;
    to?: string;
    reason: string;
    noteType?: string;
}
export interface LayoutCollision {
    to: string;
    from: string[];
}
export interface LayoutPlan {
    vaultPath: string;
    items: PlanItem[];
    collisions: LayoutCollision[];
    counts: Record<PlanAction, number>;
}
export interface ApplyReport {
    moved: number;
    converted: number;
    removed: number;
    kept: number;
    mismatches: string[];
    warnings: string[];
}
export interface ConvertOptions {
    fileName: string;
    fallbackType: string;
    today: string;
}
export interface ConvertedNote {
    text: string;
    body: string;
    type: string;
    status: string;
    warnings: string[];
}
export declare function convertNote(raw: string, options: ConvertOptions): ConvertedNote;
export declare function verifyConversion(raw: string, converted: string): string | null;
export declare function planLayoutMigration(vaultPath: string): LayoutPlan;
export declare function assertSafeToApply(vaultPath: string, force: boolean): void;
export declare function applyLayoutMigration(vaultPath: string, plan: LayoutPlan): ApplyReport;
//# sourceMappingURL=layout-migrator.d.ts.map