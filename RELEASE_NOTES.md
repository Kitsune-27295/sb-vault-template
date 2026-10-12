### Added
- `CONVENTIONS.md` in every vault: the rules you and the agent agree on, which `sb upgrade` never rewrites. `AGENTS.md` stays the framework's (ADR-037).
- `sb init --agents` and `sb upgrade --agents` also install the skills where Antigravity reads them (`.agents/skills/`); `docs/harnesses.md` says how to work without hooks.
- `sb clip --allow-local` to fetch a local documentation server.

### Changed
- After an edit, the hook tells the agent about warnings (an orphan page, a review date past) as a note, not a block; errors still block. It no longer hashes every frozen source on each edit, and each hook has a time limit (ADR-036).
- The session brief quotes `memory/hot.md` and cuts what is too long, one line per decision, and says when framework files are out of date.
- `sb clip` fetches only `http` and `https`, and refuses localhost, loopback and link-local addresses (cloud metadata), also when a page redirects to one. Private network addresses still work.
- Skill descriptions start with when to use them, which also takes about a fifth off what every session pays for.
- The shared settings deny editing `log/`, `.sb/`, `.githooks/` and the settings files; the per-machine settings allow the `"<python>" -m sb` form the brief gives when `sb` is not on PATH.

### Fixed
- An IPv6 literal in a link to `sb clip` is one failed link, not a traceback.
