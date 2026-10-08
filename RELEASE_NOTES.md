### Changed
- The semantic search model is pinned to one revision, so a change upstream under the same name can never mix old and new vectors. Your vectors are rebuilt once (`sb index vectors`, or the next `--semantic` search).

### Fixed
- `sb related` no longer lists the generated `index.md` among the pages that link to a page.
- The weekly update workflow that every vault calls now runs on Ubuntu 24.04 instead of `ubuntu-latest`, which GitHub moves to Ubuntu 26 on 2026-10-19, so the weekly pull request cannot break on the day it changes.
