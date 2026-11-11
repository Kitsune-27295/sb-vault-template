---
name: new-brain
description: Bootstraps a production-grade, local-first Second Brain vault with canonical PARA folders, Zod schemas, SQLite WAL index, and dual MCP configurations.
---

# /new-brain — Vault Initialization Skill

This skill guides the agent in bootstrapping a clean Second Brain vault instance.

```mermaid
flowchart TD
    Step1["1. Determine Target Directory"] --> Step2["2. Scaffold Canonical PARA & Zettel Hierarchy"]
    Step2 --> Step3["3. Copy System Templates & Zod Schemas"]
    Step3 --> Step4["4. Write Dual MCP Configurations (.agents & .mcp.json)"]
    Step4 --> Step5["5. Initialize Ephemeral SQLite WAL Database (.vault/index.db)"]
    Step5 --> Step6["6. Perform Initial Vault Index & Health Verification"]
```

---

## Execution Steps

1. **Verify Target Path:** Ask the operator for the destination folder or default to the current active workspace.
2. **Execute Scaffolder:**
   Run the CLI init command:
   ```bash
   sb init <targetPath> --name "Second Brain"
   ```
3. **Verify Folder Hierarchy:**
   Ensure the following directories exist:
   * `10-inbox/` (raw captures and drop zone)
   * `20-zettels/` (atomic zettelkasten notes)
   * `30-concepts/` (synthesis and evergreen concepts)
   * `40-projects/` (active PARA projects)
   * `50-areas/` (long-term PARA areas of responsibility)
   * `60-resources/` (topic reference materials)
   * `70-archives/` (completed or inactive notes)
   * `80-sources/` (literature and external references)
   * `90-system/` (schemas and templates)
4. **Verify MCP Setup:**
   Confirm that `.agents/mcp_config.json` and `.mcp.json` point to the installed Second Brain MCP server.
5. **Run Indexing:**
   ```bash
   sb index <targetPath>
   ```

