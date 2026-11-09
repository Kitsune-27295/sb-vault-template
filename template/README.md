# Your Second Brain Instance

This folder is an Instance: a vault of Markdown notes that you open in Obsidian. Open the folder as a vault; nothing else needs installing.

## Agents

`AGENTS.md` tells an agent how to work in this Instance (zones, write rules, the `sbk` commands and the capture, ingest, query, lint, archive and session-close workflows). `CLAUDE.md` only imports it, so Claude Code and tools that read `AGENTS.md` natively follow the same file. Like `.obsidian/` and `.claude/`, these two files are not updated by `sbk upgrade`.

## Zones

| Folder | Holds | Who writes |
| --- | --- | --- |
| `10-sources/` | Raw sources, immutable | capture tools only |
| `20-human/` | Your own notes | you |
| `30-proposals/` | Agent-written proposals awaiting your approval | agents, then you |
| `40-compiled/` | Approved knowledge notes | agents under your review |
| `50-ops/` | Operations: dashboards, hot notes, decisions (`decisions/`), lessons (`lessons/`), the inbox, the append-only log in `50-ops/log/` | tools and agents |
| `90-system/` | Schema, note templates, framework lock | the framework (`sbk upgrade`) |

## Obsidian

`.obsidian/` enables core plugins only (Properties, Bases, Templates, Canvas, Backlinks, Outline, Graph, File recovery, plus the basic file explorer, search, quick switcher and command palette). No community plugin is enabled. The Templates plugin reads templates from `90-system/templates/`. Search, graph and unlinked mentions skip `90-system/` and `50-ops/log/`.

Dashboards live in `50-ops/dashboards/`. Set each view's sort once, as `50-ops/dashboards/README.md` explains.

## Claude Code permissions

`.claude/settings.json` denies Claude Code's file-editing tools (Edit, Write, MultiEdit; Claude Code covers all of them with an `Edit` rule) on `10-sources/`, `50-ops/log/` and `90-system/`, and denies common shell commands (`rm`, `mv`, `cp`, `touch`, `tee`, `sed -i`, PowerShell file cmdlets) that name those paths.

These permissions are a first line of defense, not a guarantee. Rules match command text, so a script that opens files itself, a command spelled in an unexpected way, or a different tool can still change a protected file. `sbk doctor` is the authority: it checks the raw-source hashes, the hash-chained log and the note schema from the files on disk, whatever wrote them. Run it regularly:

```
sbk doctor <this folder>
```

Put your own allow rules and preferences in `.claude/settings.local.json`, which is not shared. Do not weaken the deny rules.

`sbk upgrade` updates `90-system/` only. Changes to `.obsidian/`, `.claude/` and the dashboards in a newer framework version are not applied to an existing Instance automatically.
