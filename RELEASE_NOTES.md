### Added
- `sb page <page>`: one call for a page's type, role in the link graph, inbound links, age, sources (and whether a newer version replaced one), pages on the same sources and lint findings. The `query` skill uses it before opening a long file (ADR-038).
- `sb graph`: orphans by direction (`--orphans incoming|outgoing|both`), the most linked pages (`--hubs N`) and dead links grouped by target (`--dead`), from the link table the index now keeps.
- `sb mv <page> <new name or path>`: rename or move a page and every link follows, including `superseded_by` and `contradicts`; `--dry-run` shows each line, `--undo` puts the last move back from `.sb/journal/` (ADR-039).

### Changed
- `sb related` finds the pages that link to a page from the index instead of reading every page, and a captured source's own wikilinks no longer count as links to a page.
- The search index is rebuilt once on the first command after upgrading (it gained the link table).
