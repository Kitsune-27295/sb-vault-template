### Fixed
- Deleted text no longer stays readable inside `.sb/index.sqlite` after many pages are removed at once; the fix of 0.3.0 only covered small deletions.
- `sb clip` no longer prints a password, token, session or `Authorization` header from a link on any path, including an invalid link; a link that carries `user:password@` is refused. What is stored keeps the link as given.
- `sb upgrade` refuses to run in a vault that a newer `sb` has already upgraded, instead of putting older framework files over newer ones; `sb doctor` warns about it.
- A closed pipe on Windows (`sb search ... | head`) is no longer reported as a disk error.
- `sb ingest pending` says how to give an id to a file dropped in the inbox.
- Search ignores question words (`quem`, `qual`, `onde`, `quando`, `who`, `what`, `where`...): "quem é X" now looks for X instead of requiring the word `quem` in the page.
