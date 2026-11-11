/** Default review window of a procedure: long enough to be a real cadence, short enough that API-bound docs do not rot unseen. */
export declare const DEFAULT_REVIEW_DAYS = 90;
/** `from` plus `days`, as YYYY-MM-DD (UTC). */
export declare function defaultReviewDate(from: string, days?: number): string;
/**
 * Fills the placeholders of a note template. `{{REVIEW_DATE}}` is the creation date plus the
 * default review window, never the creation date itself (a note due for review on the day it is
 * written is overdue on arrival).
 */
export declare function instantiateTemplate(content: string, title: string, today: string): string;
//# sourceMappingURL=template-vars.d.ts.map