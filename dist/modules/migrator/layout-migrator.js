import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";
const LITERATURE = "02_Zettelkasten/01_Literature_Notes";
const PERMANENT = "02_Zettelkasten/02_Permanent_Notes";
const CONCEPTS = "02_Zettelkasten/03_Concept_Notes";
const MOCS = "02_Zettelkasten/04_MOCs";
const JOURNAL = "04_Synthesis_Outputs/Journal";
const LOG = "04_Synthesis_Outputs/Log";
const DROP = "01_Inbox/_drop";
const QUARANTINE = "01_Inbox/_quarantine";
const TEMPLATE_ROOTS = ["01_Inbox", "02_Zettelkasten", "03_PARA", "04_Synthesis_Outputs"];
const ZONES = ["10-sources", "20-human", "30-proposals", "40-compiled", "50-ops", "90-system"];
const TEMPLATE_TYPES = new Set([
    "zettel", "concept", "moc", "project", "area", "resource", "archive", "source", "decision", "lesson", "log", "procedure"
]);
const TEMPLATE_STATUSES = new Set(["fleeting", "literature", "permanent", "evergreen", "archived"]);
// Keys written by the previous import (they point to paths that no longer exist).
const DROP_KEYS = new Set(["imported_from", "imported_defaults", "legacy_type", "legacy_status", "legacy_standalone"]);
// Files outside the zones that only the legacy framework wrote: its Obsidian configuration, and (when
// they are the legacy ones) the generated index and the agent permissions. `sb upgrade` installs the
// template's own Obsidian files.
const LEGACY_OBSIDIAN_FILES = [".obsidian/app.json", ".obsidian/core-plugins.json", ".obsidian/templates.json"];
const ROOT_CANDIDATES = ["index.md", ".claude/settings.json", ...LEGACY_OBSIDIAN_FILES];
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
// A top-level YAML key: not indented, not a comment, not a list item; quoted keys and keys with spaces included.
const KEY_LINE = /^(?!\s|#|-(?:\s|$))("(?:[^"\\]|\\.)*"|'[^']*'|[^:#\s][^:]*?):(?:\s|$)/;
function destinationForType(type) {
    switch (type) {
        case "source":
            return LITERATURE;
        case "concept":
            return CONCEPTS;
        case "moc":
            return MOCS;
        case "project":
            return "03_PARA/01_Projects";
        case "area":
            return "03_PARA/02_Areas";
        case "resource":
            return "03_PARA/03_Resources";
        case "archive":
            return "03_PARA/04_Archives";
        case "log":
            return JOURNAL;
        default:
            return PERMANENT; // zettel, procedure, decision, lesson
    }
}
function mapType(type) {
    if (!type)
        return undefined;
    if (type === "entity")
        return "concept";
    if (type === "proposal")
        return "zettel";
    return TEMPLATE_TYPES.has(type) ? type : undefined;
}
function mapStatus(status, type) {
    if (status && TEMPLATE_STATUSES.has(status))
        return status;
    if (status === "draft")
        return "fleeting";
    if (status === "superseded")
        return "archived";
    return type === "source" ? "literature" : "permanent";
}
const keyName = (raw) => raw.trim().replace(/^["']|["']$/g, "");
function parseBlocks(frontmatter) {
    const preamble = [];
    const blocks = [];
    if (frontmatter === "")
        return { preamble, blocks };
    for (const line of frontmatter.split(/\r?\n/)) {
        const k = line.match(KEY_LINE);
        if (k)
            blocks.push({ key: keyName(k[1]), lines: [line] });
        else if (blocks.length > 0)
            blocks[blocks.length - 1].lines.push(line);
        else
            preamble.push(line);
    }
    return { preamble, blocks };
}
function scalar(block) {
    if (!block)
        return undefined;
    const v = block.lines[0].replace(/^[^:]*:/, "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    return v === "" ? undefined : v;
}
// Adds `tag` to an existing `tags:` block in whichever YAML form it has; returns undefined when the
// form is not one it can edit safely (the caller reports a warning instead of losing the tag).
function mergeTag(block, tag) {
    const first = block.lines[0];
    const rest = first.replace(/^[^:]*:/, "").trim();
    const items = (text) => text.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim();
        if (items(inner).includes(tag))
            return block.lines;
        const merged = inner === "" ? tag : `${inner}, ${tag}`;
        return [first.replace(/\[[\s\S]*\]\s*$/, `[${merged}]`), ...block.lines.slice(1)];
    }
    if (rest !== "" && !/^[>|{&*!]/.test(rest)) {
        return rest.replace(/^["']|["']$/g, "") === tag ? block.lines : [first.replace(/:.*$/, `: [${rest.replace(/^["']|["']$/g, "")}, ${tag}]`), ...block.lines.slice(1)];
    }
    if (rest === "") {
        const listItems = block.lines.slice(1).filter((l) => /^\s*-\s/.test(l));
        if (listItems.length === block.lines.length - 1 && listItems.length > 0) {
            if (listItems.some((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "") === tag))
                return block.lines;
            const indent = listItems[listItems.length - 1].match(/^(\s*)-/)[1];
            return [...block.lines, `${indent}- ${tag}`];
        }
    }
    return undefined;
}
// Completes the template envelope of a note without touching anything else: every other key
// keeps its exact text and the body is returned unchanged.
export function convertNote(raw, options) {
    const { fileName, fallbackType, today } = options;
    const bom = raw.charCodeAt(0) === 0xfeff ? "﻿" : "";
    const text = bom ? raw.slice(1) : raw;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const warnings = [];
    const match = text.match(FRONTMATTER);
    const firstHeading = (t) => {
        const h = t.match(/^#\s+(.+)$/m);
        return h ? h[1].trim() : undefined;
    };
    if (!match) {
        const type = fallbackType;
        const status = mapStatus(undefined, type);
        const header = [
            "---",
            `uid: ${JSON.stringify(fileName)}`,
            `type: ${type}`,
            `title: ${JSON.stringify(firstHeading(text) ?? fileName)}`,
            `status: ${status}`,
            `created: ${today}`,
            `updated: ${today}`,
            "---"
        ].join(eol);
        return { text: `${bom}${header}${eol}${text}`, body: text, type, status, warnings };
    }
    const body = text.slice(match[0].length);
    const { preamble, blocks } = parseBlocks(match[1] ?? "");
    const find = (key) => blocks.find((b) => b.key === key);
    const originalType = scalar(find("type"));
    const lowered = originalType?.toLowerCase();
    const type = mapType(lowered) ?? fallbackType;
    const status = mapStatus(scalar(find("status")), type);
    // A type the template does not have is kept as a tag, so the distinction is not lost.
    const typeTag = lowered && lowered !== type ? lowered.replace(/[^\w-]/g, "-") : undefined;
    const out = [];
    for (const block of blocks) {
        if (DROP_KEYS.has(block.key))
            continue;
        if (block.key === "type")
            out.push({ key: "type", lines: [`type: ${type}`, ...block.lines.slice(1)] });
        else if (block.key === "status")
            out.push({ key: "status", lines: [`status: ${status}`, ...block.lines.slice(1)] });
        else if (block.key === "description" && !find("summary")) {
            out.push({ key: "summary", lines: [block.lines[0].replace(/^[^:]*:/, "summary:"), ...block.lines.slice(1)] });
        }
        else
            out.push(block);
    }
    const has = (key) => out.some((b) => b.key === key);
    if (!has("type"))
        out.push({ key: "type", lines: [`type: ${type}`] });
    if (!has("title"))
        out.push({ key: "title", lines: [`title: ${JSON.stringify(firstHeading(body) ?? fileName)}`] });
    if (!has("status"))
        out.push({ key: "status", lines: [`status: ${status}`] });
    if (!has("created"))
        out.push({ key: "created", lines: [`created: ${today}`] });
    if (!has("updated"))
        out.push({ key: "updated", lines: [`updated: ${today}`] });
    if (typeTag) {
        const tags = out.find((b) => b.key === "tags");
        if (!tags)
            out.push({ key: "tags", lines: [`tags: [${typeTag}]`] });
        else {
            const merged = mergeTag(tags, typeTag);
            if (merged)
                tags.lines = merged;
            else
                warnings.push(`${fileName}: the tags are in a form that cannot be edited safely, the "${typeTag}" tag was not added`);
        }
    }
    if (!has("uid"))
        out.unshift({ key: "uid", lines: [`uid: ${JSON.stringify(fileName)}`] });
    const frontmatter = [...preamble, ...out.flatMap((b) => b.lines)].join(eol);
    return { text: `${bom}---${eol}${frontmatter}${eol}---${eol}${body}`, body, type, status, warnings };
}
// Compares an original note with its conversion: the body must be identical and every
// frontmatter line must survive, except the ones the conversion rewrites on purpose.
// Returns a description of the first problem, or null.
export function verifyConversion(raw, converted) {
    const strip = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
    const a = strip(raw);
    const b = strip(converted);
    const ma = a.match(FRONTMATTER);
    const mb = b.match(FRONTMATTER);
    if (!ma)
        return b.endsWith(a) ? null : "body changed (no frontmatter in the original)";
    if (!mb)
        return "the converted note has no frontmatter";
    if (a.slice(ma[0].length) !== b.slice(mb[0].length))
        return "body changed";
    const newLines = new Set((mb[1] ?? "").split(/\r?\n/));
    const newText = mb[1] ?? "";
    const { preamble, blocks } = parseBlocks(ma[1] ?? "");
    for (const line of preamble)
        if (!newLines.has(line))
            return `frontmatter line lost: ${line}`;
    for (const block of blocks) {
        if (DROP_KEYS.has(block.key))
            continue;
        const rewrittenFirstLine = block.key === "type" || block.key === "status" || block.key === "description";
        if (block.key === "tags") {
            const tokens = block.lines.join(" ").replace(/^[^:]*:/, "").match(/[\w-]+/g) ?? [];
            const tagsOut = parseBlocks(newText).blocks.find((x) => x.key === "tags")?.lines.join(" ") ?? "";
            for (const t of tokens)
                if (!tagsOut.includes(t))
                    return `tag lost: ${t}`;
            continue;
        }
        for (const line of rewrittenFirstLine ? block.lines.slice(1) : block.lines) {
            if (!newLines.has(line))
                return `frontmatter line lost: ${line}`;
        }
    }
    return null;
}
function walk(dir, acc = []) {
    if (!existsSync(dir))
        return acc;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = lstatSync(full);
        if (st.isSymbolicLink())
            acc.push({ path: full, symlink: true });
        else if (st.isDirectory())
            walk(full, acc);
        else
            acc.push({ path: full, symlink: false });
    }
    return acc;
}
const rel = (vaultPath, full) => full.slice(vaultPath.length + 1).replace(/\\/g, "/");
function today() {
    return new Date().toISOString().slice(0, 10);
}
const isGeneratedIndex = (abs) => /^<!--\s*generated\b/i.test(readFileSync(abs, "utf8").slice(0, 200));
const isLegacyClaudeSettings = (abs) => {
    const text = readFileSync(abs, "utf8");
    return text.includes("10-sources") && text.includes("90-system");
};
export function planLayoutMigration(vaultPath) {
    const items = [];
    const entries = [
        ...ZONES.flatMap((z) => walk(join(vaultPath, z))),
        ...ROOT_CANDIDATES.map((f) => join(vaultPath, f)).filter(existsSync).map((p) => ({ path: p, symlink: false }))
    ];
    // Notes first, their sidecars after: a sidecar follows its note wherever the note goes.
    entries.sort((x, y) => Number(x.path.endsWith(".meta.json")) - Number(y.path.endsWith(".meta.json")));
    const noteDestination = new Map();
    const move = (from, dir, reason) => ({ action: "move", from, to: `${dir}/${basename(from)}`, reason });
    const remove = (from, reason) => ({ action: "remove", from, reason });
    const keep = (from, reason = "not known to the migration") => ({ action: "keep", from, reason });
    const note = (from, fallbackType, reason) => {
        const buf = readFileSync(join(vaultPath, from));
        const text = buf.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(buf)) {
            // Not valid UTF-8: a conversion would rewrite its bytes. Move it unchanged; the envelope is added by hand.
            return move(from, destinationForType(fallbackType), "not valid UTF-8: moved unchanged, add the template envelope by hand");
        }
        const converted = convertNote(text, { fileName: basename(from, ".md"), fallbackType, today: today() });
        const item = { action: "convert", from, to: `${destinationForType(converted.type)}/${basename(from)}`, reason, noteType: converted.type };
        noteDestination.set(from, item.to);
        return item;
    };
    for (const { path, symlink } of entries) {
        const from = rel(vaultPath, path);
        const name = basename(from);
        const isMd = extname(from).toLowerCase() === ".md";
        const baseNote = from.endsWith(".meta.json") ? from.slice(0, -".meta.json".length) : undefined;
        if (symlink)
            items.push(keep(from, "symbolic link: not followed"));
        else if (name === ".gitkeep")
            items.push(remove(from, "empty folder marker of a legacy zone"));
        else if (from === "index.md") {
            if (isGeneratedIndex(path))
                items.push(remove(from, "generated index of the legacy framework"));
        }
        else if (name === "_index.md" && isGeneratedIndex(path))
            items.push(remove(from, "generated index of the legacy framework"));
        else if (from === ".claude/settings.json") {
            if (isLegacyClaudeSettings(path))
                items.push(remove(from, "deny rules of the legacy framework"));
        }
        else if (LEGACY_OBSIDIAN_FILES.includes(from))
            items.push(remove(from, "Obsidian configuration of the legacy framework"));
        else if (baseNote && noteDestination.has(baseNote)) {
            items.push(move(from, dirname(noteDestination.get(baseNote)), "sidecar of a converted note"));
        }
        else if (from.startsWith("90-system/"))
            items.push(remove(from, "legacy system folder (the template ships 00_System)"));
        else if (from.startsWith("10-sources/"))
            items.push(move(from, LITERATURE, "raw source or sidecar"));
        else if (from.startsWith("40-compiled/"))
            items.push(isMd ? note(from, "concept", "compiled note") : keep(from));
        else if (from.startsWith("50-ops/decisions/"))
            items.push(isMd ? note(from, "decision", "decision note") : keep(from));
        else if (from.startsWith("50-ops/lessons/"))
            items.push(isMd ? note(from, "lesson", "lesson note") : keep(from));
        else if (from.startsWith("50-ops/journal/"))
            items.push(isMd ? note(from, "log", "journal note") : keep(from));
        else if (from.startsWith("50-ops/log/"))
            items.push(isMd ? move(from, LOG, "hash-chained log") : keep(from));
        else if (from.startsWith("50-ops/quarantine/sources/"))
            items.push(move(from, QUARANTINE, "quarantined capture"));
        else if (from.startsWith("50-ops/quarantine/import/"))
            items.push(remove(from, "list files of the legacy import"));
        else if (from.startsWith("50-ops/inbox/"))
            items.push(move(from, DROP, "pending drop"));
        else if (from.startsWith("50-ops/dashboards/") || from.startsWith("50-ops/migration/") || from.startsWith("50-ops/memory/") || from === "50-ops/hot.md") {
            items.push(remove(from, "legacy operations file"));
        }
        else if (from.startsWith("20-human/_imported/sb/sources/inbox/"))
            items.push(move(from, QUARANTINE, "skipped capture of the old vault"));
        else if (from.startsWith("20-human/_imported/"))
            items.push(remove(from, "snapshot of the legacy vault"));
        else if (from.startsWith("20-human/"))
            items.push(isMd ? note(from, "resource", "curator note") : keep(from));
        else if (from.startsWith("30-proposals/"))
            items.push(isMd ? note(from, "zettel", "proposal") : keep(from));
        else
            items.push(keep(from));
    }
    // Collisions: two files for one destination path, or two notes that would share a uid (the uid is
    // the file name and the engine keys notes by it), including notes already in the template folders.
    const planned = new Set(items.filter((i) => i.to).map((i) => i.to.toLowerCase()));
    const byPath = new Map();
    const byUid = new Map();
    const addUid = (name, who) => {
        const key = `uid:${name.toLowerCase()}`;
        byUid.set(key, [...(byUid.get(key) ?? []), who]);
    };
    for (const item of items) {
        if (!item.to)
            continue;
        const p = item.to.toLowerCase();
        byPath.set(p, [...(byPath.get(p) ?? []), item.from]);
        if (p.endsWith(".md"))
            addUid(basename(item.to, ".md"), item.from);
    }
    for (const root of TEMPLATE_ROOTS) {
        for (const { path } of walk(join(vaultPath, root))) {
            const r = rel(vaultPath, path);
            if (extname(r).toLowerCase() === ".md" && !planned.has(r.toLowerCase()))
                addUid(basename(r, ".md"), `existing:${r}`);
        }
    }
    const collisions = [...byPath, ...byUid]
        .filter(([, from]) => from.length > 1)
        .map(([to, from]) => ({ to, from }));
    const counts = { move: 0, convert: 0, remove: 0, keep: 0 };
    for (const item of items)
        counts[item.action]++;
    return { vaultPath, items, collisions, counts };
}
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function pruneEmptyDirs(vaultPath, dirs) {
    const ordered = [...dirs].sort((a, b) => b.length - a.length);
    for (const dir of ordered) {
        let current = dir;
        while (current.length > vaultPath.length && existsSync(current) && readdirSync(current).length === 0) {
            rmdirSync(current);
            current = dirname(current);
        }
    }
}
// Git is the undo of this command: refuse to start on a folder that is not a repository or has
// uncommitted changes, unless the curator forces it.
export function assertSafeToApply(vaultPath, force) {
    if (force)
        return;
    try {
        execFileSync("git", ["-C", vaultPath, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    }
    catch {
        throw new Error("The vault is not a git repository, so there is no undo. Commit it to git first, or pass --force.");
    }
    const status = execFileSync("git", ["-C", vaultPath, "status", "--porcelain"], { stdio: "pipe" }).toString().trim();
    if (status) {
        throw new Error("The vault has uncommitted changes, which would mix with the migration. Commit or stash them first, or pass --force.");
    }
}
export function applyLayoutMigration(vaultPath, plan) {
    if (plan.collisions.length > 0) {
        const first = plan.collisions[0];
        throw new Error(`Layout collision: ${plan.collisions.length} destination(s) are shared, first "${first.to}" by ${first.from.join(", ")}`);
    }
    const stamp = today();
    const targets = plan.items.filter((i) => i.to);
    // Every destination parent must be a directory (or absent) before anything is written.
    for (const item of targets) {
        let dir = dirname(join(vaultPath, item.to));
        while (dir.length > vaultPath.length) {
            if (existsSync(dir) && !statSync(dir).isDirectory())
                throw new Error(`Destination parent is not a directory: ${rel(vaultPath, dir)}`);
            dir = dirname(dir);
        }
    }
    // A destination that already exists is fine only when it is exactly what an interrupted run wrote.
    const written = new Set();
    const blocked = [];
    for (const item of targets) {
        const to = join(vaultPath, item.to);
        if (!existsSync(to))
            continue;
        const from = join(vaultPath, item.from);
        let same = false;
        if (existsSync(from)) {
            if (item.action === "move")
                same = sha256(from) === sha256(to);
            else if (item.action === "convert") {
                const converted = convertNote(readFileSync(from, "utf8"), { fileName: basename(from, ".md"), fallbackType: item.noteType ?? "zettel", today: stamp });
                same = readFileSync(to, "utf8") === converted.text || verifyConversion(readFileSync(from, "utf8"), readFileSync(to, "utf8")) === null;
            }
        }
        if (same)
            written.add(item);
        else
            blocked.push(item.to);
    }
    if (blocked.length > 0)
        throw new Error(`Destination already exists (${blocked.length}), first: ${blocked[0]}`);
    const report = { moved: 0, converted: 0, removed: 0, kept: 0, mismatches: [], warnings: [] };
    const touchedDirs = new Set();
    for (const item of plan.items) {
        const from = join(vaultPath, item.from);
        touchedDirs.add(dirname(from));
        if (item.action === "keep") {
            report.kept++;
        }
        else if (item.action === "move" && item.to) {
            const to = join(vaultPath, item.to);
            if (written.has(item)) {
                rmSync(from);
            }
            else {
                const before = sha256(from);
                mkdirSync(dirname(to), { recursive: true });
                renameSync(from, to);
                if (sha256(to) !== before)
                    report.mismatches.push(`${item.from} -> ${item.to}: bytes differ after the move`);
            }
            report.moved++;
        }
        else if (item.action === "convert" && item.to) {
            const to = join(vaultPath, item.to);
            const raw = readFileSync(from, "utf8");
            if (!written.has(item)) {
                const converted = convertNote(raw, { fileName: basename(from, ".md"), fallbackType: item.noteType ?? "zettel", today: stamp });
                report.warnings.push(...converted.warnings);
                mkdirSync(dirname(to), { recursive: true });
                writeFileSync(to, converted.text, "utf8");
            }
            const problem = verifyConversion(raw, readFileSync(to, "utf8"));
            if (problem)
                report.mismatches.push(`${item.from} -> ${item.to}: ${problem}`);
            else
                rmSync(from);
            report.converted++;
        }
        else if (item.action === "remove") {
            rmSync(from);
            report.removed++;
        }
    }
    pruneEmptyDirs(vaultPath, touchedDirs);
    return report;
}
//# sourceMappingURL=layout-migrator.js.map