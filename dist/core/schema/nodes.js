import { z } from "zod";
export const NodeTypeEnum = z.enum([
    "zettel",
    "concept",
    "moc",
    "project",
    "area",
    "resource",
    "archive",
    "source",
    "decision",
    "lesson",
    "log",
    "procedure"
]);
export const NodeStatusEnum = z.enum([
    "fleeting",
    "literature",
    "permanent",
    "evergreen",
    "archived"
]);
export const RelationTypeEnum = z.enum([
    "supports",
    "contradicts",
    "extends",
    "part_of",
    "derived_from",
    "related_to"
]);
export const RelationEdgeSchema = z.object({
    to: z.string().min(1, "Target UID must not be empty"),
    rel: RelationTypeEnum,
    weight: z.number().min(0.0).max(1.0).default(1.0)
});
export const UniversalNodeFrontmatterSchema = z.object({
    uid: z.string().min(1, "UID is required"),
    type: NodeTypeEnum,
    title: z.string().min(1, "Title is required"),
    aliases: z.preprocess((val) => {
        if (typeof val === "string")
            return [val];
        if (Array.isArray(val))
            return val.map(String);
        return [];
    }, z.array(z.string()).default([])),
    tags: z.preprocess((val) => {
        if (typeof val === "string")
            return [val.replace(/^#/, "")];
        if (Array.isArray(val))
            return val.map((v) => String(v).replace(/^#/, ""));
        return [];
    }, z.array(z.string()).default([])),
    status: NodeStatusEnum.default("permanent"),
    epistemic_confidence: z.preprocess((val) => {
        if (typeof val === "number")
            return val;
        if (typeof val === "string") {
            const parsed = parseFloat(val);
            if (!isNaN(parsed))
                return parsed;
        }
        return 0.5;
    }, z.number().min(0.0).max(1.0).default(0.5)),
    created: z.string().min(4, "Creation date is required"),
    updated: z.string().min(4, "Update date is required"),
    summary: z.string().optional().default(""),
    sources: z.preprocess((val) => {
        if (typeof val === "string")
            return [val];
        if (Array.isArray(val))
            return val.map(String);
        return [];
    }, z.array(z.string()).default([])),
    relations: z.preprocess((val) => {
        if (Array.isArray(val))
            return val;
        return [];
    }, z.array(RelationEdgeSchema).default([]))
}).passthrough();
export function validateAndNormalizeFrontmatter(raw) {
    const result = UniversalNodeFrontmatterSchema.safeParse(raw);
    if (!result.success) {
        const errorMsg = result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
        return { success: false, error: errorMsg };
    }
    return { success: true, data: result.data };
}
//# sourceMappingURL=nodes.js.map