### Fixed
- A killed `sb index rebuild` (or the first search after the index was lost) no longer throws its work away: the index is committed in batches of 200 pages and the next command resumes from there, so a vault too large for one timeout finishes over a few calls (ADR-042).
- A vault's `.gitignore` also ignores SQLite's working files and the `.bak` copies of a moved index, so an interrupted sync leaves `git status` clean.
