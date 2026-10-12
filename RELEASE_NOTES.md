### Added
- `sb lint` says what it checked: `checked N page(s), M source(s): <families>`. A check that crashes is reported as `LNT001` (an error) and never as a clean run.
- `sb search --explain` shows the tier of each hit (`identity`, `prefix`, `bm25`).
- `sb import` skips `node_modules`, `__pycache__` and `site-packages` folders, saying so once. A vault written in a newer layout than your `sb` knows is refused with the way out (update `sb`). The log merges by union, so two machines that both appended keep both (ADR-035).

### Changed
- `sb lint --json` is now an object (`findings`, `ran`, `crashed`, `pages`, `sources`, `errors`, `warnings`) instead of a bare list, and the text output stops after `--limit` findings (100) and says how many more there are (ADR-034).
- A page named exactly like the query comes first in `sb search`, then a page whose name starts with it, then the rest by relevance. On the curator's vault that took the name of a page to rank first in 120 of 120 samples (it was 111).

### Fixed
- The weekly update workflow of a vault passes its input to the commit message through a variable instead of expanding it inside the script.
- `[[wiki/Alvo]]`, a path-qualified link, resolves like in Obsidian (and is a dead link when the folder is wrong); a page name typed in another Unicode form (macOS) matches; a frontmatter key written twice is an error instead of silently keeping the last.
