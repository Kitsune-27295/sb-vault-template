import { describe, it, expect } from "vitest";
import { parseNoteContent, extractWikiLinks } from "./frontmatter.js";
describe("Frontmatter & WikiLink Parser", () => {
    it("should parse valid YAML frontmatter and normalize fields", () => {
        const raw = `---
uid: ZET-0001
type: zettel
title: Atomic Note Design
aliases: ["Atomic Note", "Zettel Principle"]
tags: ["pkm", "zettelkasten"]
status: evergreen
epistemic_confidence: 0.95
created: "2026-11-10"
updated: "2026-11-10"
summary: A single thought captured atomically.
relations:
  - to: CON-0002
    rel: supports
    weight: 0.9
custom_prop: "preserved through passthrough"
---

# Atomic Note Design

Links to [[CON-0002]] and [[ZET-0003|Third Note]] for context.
`;
        const parsed = parseNoteContent(raw);
        expect(parsed.validationError).toBeUndefined();
        expect(parsed.frontmatter.uid).toBe("ZET-0001");
        expect(parsed.frontmatter.type).toBe("zettel");
        expect(parsed.frontmatter.title).toBe("Atomic Note Design");
        expect(parsed.frontmatter.tags).toEqual(["pkm", "zettelkasten"]);
        expect(parsed.frontmatter.epistemic_confidence).toBe(0.95);
        expect(parsed.frontmatter.relations).toHaveLength(1);
        expect(parsed.frontmatter.relations[0].rel).toBe("supports");
        expect(parsed.frontmatter.custom_prop).toBe("preserved through passthrough");
        expect(parsed.wikiLinks).toHaveLength(2);
        expect(parsed.wikiLinks[0].target).toBe("CON-0002");
        expect(parsed.wikiLinks[1].target).toBe("ZET-0003");
        expect(parsed.wikiLinks[1].alias).toBe("Third Note");
    });
    it("should never extract false wiki-links from fenced code blocks (Mermaid/Code)", () => {
        const content = `
Here is a normal link: [[ZET-VALID]]

\`\`\`mermaid
flowchart TD
  A["[ZET-INVALID-1] Node"] --> B["[[ZET-INVALID-2]] Fake Link"]
\`\`\`

And inline code: \`[[ZET-INVALID-3]]\`
And another valid link: [[CON-VALID-2#heading|Alias Title]]
`;
        const links = extractWikiLinks(content);
        expect(links).toHaveLength(2);
        expect(links[0].target).toBe("ZET-VALID");
        expect(links[1].target).toBe("CON-VALID-2");
        expect(links[1].heading).toBe("heading");
        expect(links[1].alias).toBe("Alias Title");
    });
    it("should report validation errors gracefully on malformed schema", () => {
        const malformed = `---
uid: BAD
type: invalid_type
title: ""
created: "2026"
updated: "2026"
---
Note body
`;
        const parsed = parseNoteContent(malformed);
        expect(parsed.validationError).toBeDefined();
        expect(parsed.validationError).toContain("type");
    });
});
//# sourceMappingURL=frontmatter.test.js.map