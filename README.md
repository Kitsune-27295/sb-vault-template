# Second Brain vault template

This repository holds the vault template of the Second Brain Framework-Template, ready to be copied into a new vault.

**It is generated.** Do not edit it here: every commit is built from the source repository (`Kitsune-27295/Second_brain`) by `sbk dist`, and the commit message names the source commit and the version. Changes made here are overwritten by the next publication.

## What is in it

- `template/`: the vault base, with the six zones, the note schema, the note templates, the dashboards and the agent instructions (`AGENTS.md`).
- `.github/workflows/`: the reusable workflow that migrates a vault repository (see below).

## Start a new vault

Install the `sbk` command from the source repository (Node 22 or later), then create the vault from its own copy of the template:

```
sbk init <new-vault-folder>
```

`sbk init` writes the template into an empty folder and records the framework version in `90-system/framework.lock`. Run `sbk doctor <new-vault-folder>` to check it.

## Migrate an existing vault

`sbk import <source> <target>` plans the move of a vault built with another framework into a new vault and writes nothing until you add `--apply`:

```
sbk import <old-vault> <new-vault-folder>
sbk import <old-vault> <new-vault-folder> --apply
```

The source is only read. The command prints, for every file, whether it was mapped, kept verbatim, excluded or quarantined, and writes a manifest of the run. For a vault kept in a Git repository, the reusable workflow in `.github/workflows/` runs the same import and opens one pull request, so nothing changes until you merge it.
