### Added
- `sb --version`. `sb doctor` also checks the search index (healthy, not built yet, or damaged, with the remedy) and warns when the vault's skills and rules differ from this `sb`; a new vault records the version that made it in `.sb/config.json`.
- `sb ingest pending` lists the sources nobody has compiled: the inbox, and frozen sources no wiki page cites any more. `sb ingest skip <id> --reason "..."` records that one is deliberately left out, in the log. The session brief mentions uncited sources when there are some.
- `sb search --type T` and `--zone Z` narrow the search before the limit (`-k 5` still gives 5 matching pages, not the 5 best of which the filter then drops some); `--explain` shows each hit's raw score and zone weight. `--type` matches the frontmatter `type` exactly, so notes with their own types can be found too; an unknown `--zone` is refused with the valid ones.
- `sb eval` also reports hit rate, NDCG, the rank of the first right page per query, and recall per `kind` (an optional label in `eval/queries.yaml`). `--record` keeps each run in `eval/runs.jsonl`, and `--baseline` compares with the last run of the same queries, saying so when there is none. `--json` prints a valid empty report when there are no queries.
- `sb lint` warns (`IMG001`) about a page that carries a big inline image (`data:image/...;base64,...`, what a web clipper can paste). Frozen sources are not flagged.

### Changed
- The `onboarding` skill asks one question per message and now covers a changed answer, another language, an interview stopped midway, an offered secret (nothing is recorded about it) and an existing context file (updated, never overwritten). The `consolidate` skill gets a rule for telling a replaced fact from a real contradiction, and asks for both dates. They reach your vault with `sb upgrade`.
- Search no longer reads inline images: a page full of base64 is as light to search as one without, and a question never matches the encoded image. The files themselves are untouched.

### Fixed
- A failed `sb clip` no longer repeats a password, a token, a signature or an API key from the link or the server's answer in its message (a link's `key=`, `token=` and similar values show as `***`); a link that carries `user:password@` is refused with a clear reason.
- A disk error half-way through a command (full or read-only disk) is now a one-line message that says to run it again, not a traceback; `sb init` on a half-made vault says `sb upgrade` finishes it.
- Text of a page you deleted or rewrote no longer stays readable inside `.sb/index.sqlite`.
- A capture that fails half-way (disk full, read-only folder) no longer leaves a source without its sidecar in the inbox.
- Search results with equal scores now always come back in the same order (by path).
- Stripe-style keys (`sk_live_...`, `sk_test_...`, `rk_live_...`) are detected as credentials.
- `sb search` no longer fails because of a damaged or outdated search index: it rebuilds the index once by itself, and says what to do if even that fails. A note that another program holds open for a moment is skipped (its old entry stays, with a warning on stderr) instead of stopping every search.
- A command with nothing to change no longer rewrites files: `sb index rebuild` leaves `index.md` alone, and `sb upgrade` on a current vault leaves the hook files alone.
