### Added
- `sb search --path P` (repeatable) searches only a file or the pages under a folder; several are a union. It is applied before the limit and works with `--type`, `--zone` and `--semantic`: the vault's way of choosing which sources an answer may use (ADR-043).
- Skill `research`: finds sources from a loose idea or a question with a plan (quick or thorough, with caps), a table of candidates, and only the links you approve captured through `sb clip --from`. It never ingests on its own.

### Changed
- Skill `query` files a FAQ, briefing, study guide, timeline or table over a scope as an `analysis` page, records the request and scope under `## Question`, gives a table row its source, and puts a computed figure in with its script (`## Method`).
- Skill `ingest` ends each source page with `## Questions this source raises`, which `research` and `query` start from.
