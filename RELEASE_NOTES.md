### Fixed
- `sb memory brief`: strictly cap session briefing at 9,000 characters before truncating, preventing Claude Code and Antigravity hook context overflow errors on large vaults.

### Added
- Explicit contract verification and invariant coverage tests across all 10 canonical skills (`consolidate`, `decide`, `dossier`, `ingest`, `onboarding`, `postmortem`, `query`, `research`, `triage`, `wrapup`) in `tests/skills/test_skill_templates.py`.
