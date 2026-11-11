---
name: migrate-notes
description: Migrates legacy Markdown files and native DOCX documents into canonical Second Brain notes, automatically converting ASCII trees into native Mermaid diagrams and normalizing YAML frontmatter.
---

# /migrate-notes — Vault Ingestion & Migration Skill

This skill guides the agent in safely ingesting external or legacy document collections into the Second Brain vault without data loss.

```mermaid
flowchart TD
    Scan["Scan Source Directory (.md & .docx)"] --> Filter{"File Extension"}
    Filter -->|.docx| Unzip["Extract word/document.xml via node:zlib"]
    Filter -->|.md| Read["Read Raw Markdown"]
    Unzip --> ParseXML["Convert Word XML to Markdown Paragraphs"]
    ParseXML --> TreeDetect["Detect ASCII Trees (├──, └──)"]
    Read --> TreeDetect
    TreeDetect --> MermaidConvert["Convert Tree to Native ```mermaid graph"]
    MermaidConvert --> Frontmatter["Normalize YAML Frontmatter (Zod Envelope)"]
    Frontmatter --> WriteTarget["Write Migrated Note to Target Path"]
    WriteTarget --> IndexSync["Sync Incremental SQLite Index"]
```

---

## Execution Protocol

1. **Dry-Run First:**
   Always perform a dry-run migration first to preview converted files and Mermaid transformations:
   ```bash
   sb migrate <sourceDir> <targetDir> --dry-run
   ```
2. **Review Output:**
   Inspect the dry-run summary for errors or malformed documents.
3. **Execute Real Migration:**
   ```bash
   sb migrate <sourceDir> <targetDir>
   ```
4. **Re-index & Lint:**
   ```bash
   sb index <targetDir>
   sb lint <targetDir>
   ```

