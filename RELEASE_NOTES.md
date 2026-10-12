### Added
- `sb new <type> "<title>"` creates a page of a type (`concept`, `entity`, `analysis`, `procedure`, `incident`, `decision`) with its sections; whatever is not written yet says `[PENDING VALIDATION]` (ADR-040).
- Starter packs: `sb init --pack <name>` and `sb pack <name>` add a conventions block and seed pages for `research`, `engineering` or `entities`; applying twice changes nothing.
- Skills `decide`, `postmortem` and `dossier`; `onboarding` now knows how to take stock of material that already exists.
- `standalone: true` on a page silences its orphan warning.
- `sb doctor --json`, `sb doctor --bundle FILE` (versions and counts, no page, no text, no path) and `sb uninstall [--apply]` (ADR-041).

### Changed
- `wrapup` hands decisions to the `decide` skill; `query` offers to file an answer back only when it is durable, spans pages, is new and is sourced.
