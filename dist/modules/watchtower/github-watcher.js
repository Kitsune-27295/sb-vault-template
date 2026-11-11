import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWatchlistContent, updateWatchlistNote } from "./watchlist-parser.js";
import { clipSource } from "../cli/clipper.js";
import { ingestPendingSources } from "../../core/memory/context-memory.js";
export function sanitizeVendorDocumentation(rawMarkdown) {
    // Strip Microsoft Learn / proprietary vendor frontmatter clutter while preserving title and core content
    let text = rawMarkdown;
    // 1. Clean proprietary vendor frontmatter fields
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (fmMatch) {
        const yamlBody = fmMatch[1];
        const body = fmMatch[2];
        const cleanYamlLines = yamlBody
            .split(/\r?\n/)
            .filter((line) => {
            const trimmed = line.trim();
            // Remove ms.*, dev_langs, author, manager, reviewer etc.
            return !/^(?:ms\.|author:|manager:|ms_author:|reviewer:|f1\.keywords:|helpviewer_keywords:)/i.test(trimmed);
        });
        text = `---\n${cleanYamlLines.join("\n")}\n---\n\n${body}`;
    }
    // 2. Clean or annotate proprietary include directives (e.g. [!INCLUDE [name](~/includes/file.md)])
    text = text.replace(/\[!INCLUDE\s*\[([^\]]*)\]\(([^)]*)\)\]/gi, "> *[Include: $1]*");
    // 3. Normalize multiple blank lines
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
}
export function isMeaningfulTechnicalDiff(oldText, newText) {
    // Strip whitespace, comments and dates to check if substantive technical content changed
    const normalize = (t) => t
        .replace(/\r?\n/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
    return normalize(oldText) !== normalize(newText);
}
export class GitHubWatchtower {
    vaultPath;
    githubToken;
    fetchFn;
    constructor(vaultPath, githubToken, fetchFn = fetch) {
        this.vaultPath = vaultPath;
        this.githubToken = githubToken || process.env.GITHUB_TOKEN;
        this.fetchFn = fetchFn;
    }
    getHeaders() {
        const headers = {
            "User-Agent": "SecondBrain-Watchtower/1.4.0",
            Accept: "application/vnd.github.v3+json"
        };
        if (this.githubToken) {
            headers.Authorization = `token ${this.githubToken}`;
        }
        return headers;
    }
    async syncWatchedRepos(options) {
        const report = {
            timestamp: new Date().toISOString(),
            totalRepos: 0,
            updatedFiles: [],
            errors: []
        };
        // Locate Watchlist note
        const watchlistPath = existsSync(join(this.vaultPath, "00_System", "Watchlist_Repos.md"))
            ? join(this.vaultPath, "00_System", "Watchlist_Repos.md")
            : existsSync(join(this.vaultPath, "00_System", "Watchlist.md"))
                ? join(this.vaultPath, "00_System", "Watchlist.md")
                : join(this.vaultPath, "00_System", "Watchlist_Repos.md");
        if (!existsSync(watchlistPath)) {
            report.errors.push(`Watchlist file not found at ${watchlistPath}`);
            return report;
        }
        const content = readFileSync(watchlistPath, "utf8");
        const entries = parseWatchlistContent(content);
        report.totalRepos = entries.length;
        for (const entry of entries) {
            try {
                await this.syncSingleRepo(entry, options, report);
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                report.errors.push(`Error syncing ${entry.owner}/${entry.repo}: ${errorMsg}`);
            }
        }
        // Persist updated commit SHAs back to Watchlist_Repos.md
        if (!options.dryRun) {
            updateWatchlistNote(watchlistPath, entries);
        }
        // Run ingest pipeline if requested
        if (options.autoIngest && report.updatedFiles.some((f) => f.status === "captured")) {
            ingestPendingSources(this.vaultPath);
        }
        return report;
    }
    async syncSingleRepo(entry, options, report) {
        const nowIso = new Date().toISOString();
        let commitApiUrl = `https://api.github.com/repos/${entry.owner}/${entry.repo}/commits?per_page=1`;
        if (entry.pathFilter) {
            commitApiUrl += `&path=${encodeURIComponent(entry.pathFilter)}`;
        }
        if (entry.branch) {
            commitApiUrl += `&sha=${encodeURIComponent(entry.branch)}`;
        }
        const res = await this.fetchFn(commitApiUrl, { headers: this.getHeaders() });
        if (!res.ok) {
            throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
        }
        const commits = (await res.json());
        if (!commits || commits.length === 0) {
            entry.lastChecked = nowIso.slice(0, 10);
            return;
        }
        const latestCommitSha = commits[0].sha;
        if (entry.lastSyncedSha === latestCommitSha) {
            entry.lastChecked = nowIso.slice(0, 10);
            return; // Already up to date
        }
        // Fetch commit details or modified files
        const detailRes = await this.fetchFn(`https://api.github.com/repos/${entry.owner}/${entry.repo}/commits/${latestCommitSha}`, { headers: this.getHeaders() });
        if (!detailRes.ok) {
            throw new Error(`Failed to fetch commit detail for ${latestCommitSha}`);
        }
        const detail = (await detailRes.json());
        const modifiedFiles = (detail.files || []).filter((f) => f.filename.endsWith(".md") && (!entry.pathFilter || f.filename.startsWith(entry.pathFilter)));
        for (const file of modifiedFiles) {
            if (options.dryRun) {
                report.updatedFiles.push({
                    repo: `${entry.owner}/${entry.repo}`,
                    path: file.filename,
                    status: "dry-run-modified"
                });
                continue;
            }
            // Fetch raw markdown content
            const rawUrl = file.raw_url || `https://raw.githubusercontent.com/${entry.owner}/${entry.repo}/${latestCommitSha}/${file.filename}`;
            const rawRes = await this.fetchFn(rawUrl);
            if (!rawRes.ok)
                continue;
            const rawMarkdown = await rawRes.text();
            const sanitized = sanitizeVendorDocumentation(rawMarkdown);
            // Clip into vault inbox
            const clipResult = await clipSource({
                vaultPath: this.vaultPath,
                urlOrFile: rawUrl,
                title: `${entry.repo} - ${file.filename}`,
                markdownContent: sanitized
            });
            report.updatedFiles.push({
                repo: `${entry.owner}/${entry.repo}`,
                path: file.filename,
                status: clipResult.status,
                clipId: clipResult.id
            });
        }
        entry.lastSyncedSha = latestCommitSha;
        entry.lastChecked = nowIso.slice(0, 10);
    }
}
//# sourceMappingURL=github-watcher.js.map