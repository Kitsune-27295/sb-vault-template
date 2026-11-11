---
name: watch-repos
description: Add GitHub repositories to Watchlist_Repos.md, trigger incremental sync, and auto-ingest documentation updates.
---

# GitHub Documentation Watchtower Skill

This skill allows agents to track public GitHub repositories and automatically ingest documentation updates into the Second Brain vault.

```mermaid
flowchart LR
    A["User pastes GitHub URL"] --> B["00_System/Watchlist_Repos.md"]
    B --> C["sb sync-repos / GitHub REST API"]
    C --> D["Incremental Commit Diff (Zero Git Clone)"]
    D --> E["Clean Vendor Clutter (ms.*, [!INCLUDE])"]
    E --> F["sb clip -> 01_Inbox/_drop/"]
    F --> G["sb ingest -> Curated Literature Notes"]
```

## Usage

1. **Add Repository to Watchlist:**
   * Append bare GitHub URL: `https://github.com/owner/repo`
   * Or subpath filter: `https://github.com/owner/repo/tree/main/docs`
   * Or via CLI: `sb watch-repo <url> [--vault <path>]`

2. **Run Incremental Sync & Ingest:**
   * Via CLI: `sb sync-repos --ingest --vault <path>`
   * Via MCP: `sb_sync_watched_repos` or `sb_ingest_sources`

