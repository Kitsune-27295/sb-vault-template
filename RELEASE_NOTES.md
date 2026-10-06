### Added
- `sb upgrade [--dry-run] [--json]`: refreshes a vault's skills, rules and settings from the installed `sb`, and never touches notes, sources, memory or the log. A file you edited is kept as it is.
- A vault now carries `setup-sb.py` (installs or updates `sb` on a machine and wires the vault to it, with no GitHub account or key) and a weekly `sb-update` workflow that opens a pull request with the framework changes.
- A public template repository with an empty vault, kept in step with this framework automatically.
- `setup-sb.py` installs with the same dependency pins CI verified, binary wheels only, and checks every download's sha256; on Windows it refuses a tool folder too long for the dependencies, with the fix.

### Fixed
- A credential whose underscore a page parser escaped (`ghp\_...`) was no longer detected when capturing a link.
- Hook settings: a curator's local approvals in `.claude/settings.local.json` survive `sb hook install`.
