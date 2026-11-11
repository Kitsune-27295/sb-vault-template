/** Default review window of a procedure: long enough to be a real cadence, short enough that API-bound docs do not rot unseen. */
export const DEFAULT_REVIEW_DAYS = 90;
/** `from` plus `days`, as YYYY-MM-DD (UTC). */
export function defaultReviewDate(from, days = DEFAULT_REVIEW_DAYS) {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/**
 * Fills the placeholders of a note template. `{{REVIEW_DATE}}` is the creation date plus the
 * default review window, never the creation date itself (a note due for review on the day it is
 * written is overdue on arrival).
 */
export function instantiateTemplate(content, title, today) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return content
        .replace(/\{\{TITLE\}\}/g, title)
        .replace(/\{\{DATE\}\}/g, today)
        .replace(/\{\{REVIEW_DATE\}\}/g, defaultReviewDate(today))
        .replace(/\{\{SLUG\}\}/g, slug);
}
//# sourceMappingURL=template-vars.js.map