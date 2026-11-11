---
name: audit-brain
description: Audits the entire Second Brain vault for broken wiki-links, orphan zettels, frontmatter schema errors, and unlinked mentions, providing automated repair recommendations.
---

# /audit-brain — Vault Health Audit Skill

This skill performs a complete health inspection of the knowledge vault.

```mermaid
flowchart TD
    Start["Invoke /audit-brain"] --> Reindex["Refresh SQLite Database (.vault/index.db)"]
    Reindex --> Lint["Execute Lint Engine"]
    Lint --> Broken["Find Broken [[Wiki-links]]"]
    Lint --> Orphans["Find Orphan Zettels (degree = 0)"]
    Lint --> SchemaErr["Check YAML Schema Violations"]
    Lint --> Unlinked["Detect Unlinked Mentions"]
    Broken & Orphans & SchemaErr & Unlinked --> Report["Render Vault Health Audit Matrix"]
```

---

## Instructions

1. **Trigger Audit:**
   Execute the lint tool via MCP (`sb_lint_vault`) or CLI:
   ```bash
   sb lint .
   ```
2. **Evaluate Severity:**
   * **Errors:** Broken links pointing to non-existent UIDs (must be fixed).
   * **Warnings:** Orphan zettels without inbound or outbound links, schema violations.
   * **Info:** Unlinked mentions that could be converted to typed `[[Wiki-links]]`.
3. **Generate Action Plan:**
   Present the audit table to the operator with concrete suggestions to resolve each finding.

