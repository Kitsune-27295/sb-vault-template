import { writeFileSync } from "node:fs";
export function parseGitHubRepoUrl(rawUrl) {
    const cleanUrl = rawUrl.trim().replace(/[>)\],;]+$/, "");
    const match = cleanUrl.match(/^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\/tree\/([a-zA-Z0-9_.-]+)\/(.*))?/i);
    if (!match)
        return null;
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    const branch = match[3] || undefined;
    const pathFilter = match[4] ? match[4].replace(/\/+$/, "") : undefined;
    return { owner, repo, branch, pathFilter };
}
export function parseWatchlistContent(markdownContent) {
    const entries = [];
    const lines = markdownContent.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--"))
            continue;
        // 1. Table row format: | Repo URL | Path Filter | Auto-Ingest | Last Synced Commit | Last Checked |
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            const parts = trimmed.split("|").map((p) => p.trim()).slice(1, -1);
            if (parts.length >= 1) {
                const urlCandidate = parts[0].replace(/^\[(.*?)\]\(.*?\)$/, "$1");
                if (urlCandidate.toLowerCase().includes("github.com")) {
                    const parsed = parseGitHubRepoUrl(urlCandidate);
                    if (parsed) {
                        const pathFilter = parts[1] && parts[1] !== "-" && parts[1] !== "None" ? parts[1] : parsed.pathFilter;
                        const autoIngest = parts[2] ? /^(true|yes|1|sim)$/i.test(parts[2]) : true;
                        const lastSyncedSha = parts[3] && parts[3] !== "-" ? parts[3] : undefined;
                        const lastChecked = parts[4] && parts[4] !== "-" ? parts[4] : undefined;
                        entries.push({
                            url: urlCandidate,
                            owner: parsed.owner,
                            repo: parsed.repo,
                            pathFilter,
                            branch: parsed.branch,
                            autoIngest,
                            lastSyncedSha,
                            lastChecked
                        });
                        continue;
                    }
                }
            }
        }
        // 2. Bullet list or bare URL format: - https://github.com/... or https://github.com/...
        const bulletMatch = trimmed.match(/^(?:[-*]\s+)?(https?:\/\/github\.com\/[^\s]+)/i);
        if (bulletMatch) {
            const rawUrl = bulletMatch[1];
            const parsed = parseGitHubRepoUrl(rawUrl);
            if (parsed) {
                entries.push({
                    url: rawUrl,
                    owner: parsed.owner,
                    repo: parsed.repo,
                    pathFilter: parsed.pathFilter,
                    branch: parsed.branch,
                    autoIngest: true
                });
            }
        }
    }
    return entries;
}
export function formatWatchlistTable(entries) {
    const header = [
        "# GitHub Documentation Watchlist",
        "",
        "Repositories watched by Second Brain Watchtower (`sb sync-repos`).",
        "Paste any GitHub repository URL below in a bullet or update the table directly.",
        "",
        "| Repository URL | Path Filter (Optional) | Auto-Ingest | Last Synced Commit | Last Checked |",
        "| :--- | :--- | :--- | :--- | :--- |"
    ];
    const rows = entries.map((e) => {
        const pf = e.pathFilter || "-";
        const sha = e.lastSyncedSha || "-";
        const checked = e.lastChecked || "-";
        const auto = e.autoIngest ? "true" : "false";
        return `| ${e.url} | ${pf} | ${auto} | ${sha} | ${checked} |`;
    });
    return `${header.join("\n")}\n${rows.join("\n")}\n`;
}
export function updateWatchlistNote(filePath, entries) {
    const formatted = formatWatchlistTable(entries);
    writeFileSync(filePath, formatted, "utf8");
}
//# sourceMappingURL=watchlist-parser.js.map