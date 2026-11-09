# Second Brain vault template

This repository holds the vault template of the Second Brain Framework-Template, ready to be copied into a new vault.

**It is generated.** Do not edit it here: every commit is built from the source repository (`Kitsune-27295/Second_brain`) by `sbk dist`, and the commit message names the source commit and the version. Changes made here are overwritten by the next publication.

## What is in it

- `template/`: the vault base, with the six zones, the note schema, the note templates, the dashboards and the agent instructions (`AGENTS.md`).
- `.github/workflows/`: two reusable workflows. `update-vault.yml` is the weekly update of vaults that follow the moving tag `stable` (inputs `template-ref` and `dry-run`): it verifies `tool/` and `template/` against `manifest.json`, runs `sbk migrate-vault` and opens ONE pull request on the branch `sb/framework-update`. `vault-migration.yml` is the pinned variant that imports a vault repository on the branch `sbk/migration`. Nothing changes on a vault's default branch until its owner merges the pull request; closing it leaves the vault as it was.
- `tool/`: the `sbk` command line tool (`bin/`, `src/`, `package.json`, `package-lock.json`), so a vault can run it without access to the source repository. Install its one dependency with `npm ci --omit=dev --ignore-scripts` inside `tool/`; `manifest.json` lists the sha256 of every file for verification.
- `LICENSE` (when the source repository has one): the license of the whole tree, `tool/` included; `tool/` carries no license file of its own.

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

To migrate a Git working tree in place, run `node tool/bin/sbk.js migrate-vault <repo>` from a checkout of this repository (after `npm ci --omit=dev --ignore-scripts` in `tool/`). It is a dry run until you add `--apply`, it never touches `.git` or `.github`, and `--report <folder>` writes the report outside the tree.
