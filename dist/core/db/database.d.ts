import { Database as SqliteDatabase } from "better-sqlite3";
import { ParsedNode } from "../parser/frontmatter.js";
export interface NodeRecord {
    uid: string;
    type: string;
    title: string;
    status: string;
    epistemic_confidence: number;
    para_category: string | null;
    file_path: string;
    content_hash: string;
    raw_yaml: string | null;
    updated_at: string;
}
export interface EdgeRecord {
    id?: number;
    source_uid: string;
    target_uid: string;
    relation_type: string;
    weight: number;
    context_snippet?: string | null;
    is_broken_link: number;
}
export interface SearchResult {
    uid: string;
    title: string;
    type: string;
    summary: string;
    rank: number;
    snippet?: string;
    degreeScore?: number;
}
export interface GraphNeighborhood {
    focalUid: string;
    nodes: NodeRecord[];
    edges: EdgeRecord[];
}
export declare class VaultDatabase {
    readonly db: SqliteDatabase;
    constructor(dbPath?: string);
    private configurePragmas;
    private initSchema;
    upsertNode(parsed: ParsedNode, filePath: string): void;
    refreshBrokenLinks(): number;
    getNode(uid: string): NodeRecord | undefined;
    getAllNodes(): NodeRecord[];
    searchNodesFts(query: string, limit?: number, typeFilter?: string): SearchResult[];
    calculateDegreeCentrality(): Map<string, number>;
    getNodeNeighbors(uid: string, maxDepth?: number): GraphNeighborhood;
    getBrokenLinks(): EdgeRecord[];
    getOrphanNodes(): NodeRecord[];
    close(): void;
}
//# sourceMappingURL=database.d.ts.map