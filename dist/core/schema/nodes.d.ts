import { z } from "zod";
export declare const NodeTypeEnum: z.ZodEnum<{
    archive: "archive";
    area: "area";
    concept: "concept";
    decision: "decision";
    lesson: "lesson";
    log: "log";
    moc: "moc";
    procedure: "procedure";
    project: "project";
    resource: "resource";
    source: "source";
    zettel: "zettel";
}>;
export type NodeType = z.infer<typeof NodeTypeEnum>;
export declare const NodeStatusEnum: z.ZodEnum<{
    archived: "archived";
    evergreen: "evergreen";
    fleeting: "fleeting";
    literature: "literature";
    permanent: "permanent";
}>;
export type NodeStatus = z.infer<typeof NodeStatusEnum>;
export declare const RelationTypeEnum: z.ZodEnum<{
    contradicts: "contradicts";
    derived_from: "derived_from";
    extends: "extends";
    part_of: "part_of";
    related_to: "related_to";
    supports: "supports";
}>;
export type RelationType = z.infer<typeof RelationTypeEnum>;
export declare const RelationEdgeSchema: z.ZodObject<{
    to: z.ZodString;
    rel: z.ZodEnum<{
        contradicts: "contradicts";
        derived_from: "derived_from";
        extends: "extends";
        part_of: "part_of";
        related_to: "related_to";
        supports: "supports";
    }>;
    weight: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type RelationEdge = z.infer<typeof RelationEdgeSchema>;
export declare const UniversalNodeFrontmatterSchema: z.ZodObject<{
    uid: z.ZodString;
    type: z.ZodEnum<{
        archive: "archive";
        area: "area";
        concept: "concept";
        decision: "decision";
        lesson: "lesson";
        log: "log";
        moc: "moc";
        procedure: "procedure";
        project: "project";
        resource: "resource";
        source: "source";
        zettel: "zettel";
    }>;
    title: z.ZodString;
    aliases: z.ZodPreprocess<z.ZodDefault<z.ZodArray<z.ZodString>>, unknown>;
    tags: z.ZodPreprocess<z.ZodDefault<z.ZodArray<z.ZodString>>, unknown>;
    status: z.ZodDefault<z.ZodEnum<{
        archived: "archived";
        evergreen: "evergreen";
        fleeting: "fleeting";
        literature: "literature";
        permanent: "permanent";
    }>>;
    epistemic_confidence: z.ZodPreprocess<z.ZodDefault<z.ZodNumber>, unknown>;
    created: z.ZodString;
    updated: z.ZodString;
    summary: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    sources: z.ZodPreprocess<z.ZodDefault<z.ZodArray<z.ZodString>>, unknown>;
    relations: z.ZodPreprocess<z.ZodDefault<z.ZodArray<z.ZodObject<{
        to: z.ZodString;
        rel: z.ZodEnum<{
            contradicts: "contradicts";
            derived_from: "derived_from";
            extends: "extends";
            part_of: "part_of";
            related_to: "related_to";
            supports: "supports";
        }>;
        weight: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>, unknown>;
}, z.core.$loose>;
export type UniversalNodeFrontmatter = z.infer<typeof UniversalNodeFrontmatterSchema>;
export declare function validateAndNormalizeFrontmatter(raw: unknown): {
    success: boolean;
    data?: UniversalNodeFrontmatter;
    error?: string;
};
//# sourceMappingURL=nodes.d.ts.map