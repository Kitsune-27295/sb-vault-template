### Added
- Two page types for operational knowledge, `procedure` (ordered steps to do something) and `incident` (what broke, why, the fix), and two optional frontmatter dates, `updated` and `review_by`. `sb lint` warns (`STA001`) when a page is past its `review_by` (and `STA002` when `updated` or `review_by` is not a date), the session brief lists those pages, and the `query` skill says how old each page it cites is. **Update `sb` before using the new types: an older one rejects them.**
- `sb import <folder>` mirrors a folder of documents (markdown, text, HTML, PDF) into your inbox, offline. Run it again whenever the folder changes: unchanged files write nothing, a changed file becomes a new source that replaces the old one (`sb lint` then warns, `SRC005`, about pages that still cite the old version), and a file that left the folder is listed, never deleted.
- `sb related <page>` shows what a page relates to: the pages it links to and that link to it, pages that draw on the same sources, pages with similar words, pages close in meaning (from the stored vectors, no model needed) and pages named in its text without a link.

### Changed
- `sb search --semantic` now works with `--type` and `--zone`, and is about twice as fast on a large vault: it no longer re-reads pages that did not change.
- `sb ingest plan` reports `supersedes` and `replaces_pages` for a source that replaces an older one.

### Fixed
- A page whose frontmatter had an impossible date without quotes (`2026-13-40`) crashed the command that read it; it is now reported as `FM001`.
