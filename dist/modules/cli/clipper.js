import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { computeSha256 } from "../../core/parser/frontmatter.js";
import { scanTextForSecrets } from "../linter/checks/secret-scan.js";
import { resolveDropDir } from "../../core/vault-layout.js";
const SENSITIVE_QUERY_PATTERNS = [
    /[?&](?:token|key|secret|session|password|sig|api_key|auth)=/i
];
const PRIVATE_HOST_PATTERNS = [
    /^https?:\/\/localhost\b/i,
    /^https?:\/\/127\./i,
    /^https?:\/\/0\.0\.0\.0\b/i,
    /^https?:\/\/10\./i,
    /^https?:\/\/192\.168\./i,
    /^https?:\/\/172\.(?:1[6-9]|2[0-9]|3[0-1])\./i,
    /^https?:\/\/\[::1\]/i
];
export function validateClipUrl(url) {
    for (const pattern of SENSITIVE_QUERY_PATTERNS) {
        if (pattern.test(url)) {
            return { valid: false, reason: "sensitive-query-tokens" };
        }
    }
    for (const pattern of PRIVATE_HOST_PATTERNS) {
        if (pattern.test(url)) {
            return { valid: false, reason: "private-internal-host" };
        }
    }
    return { valid: true };
}
export function stripHtmlToMarkdown(html) {
    // Simple deterministic HTML to Markdown parser for clean extraction
    let text = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "");
    // Headings
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
    // Paragraphs & breaks
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "* $1\n");
    // Links & bold/italic
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
    text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
    text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
    text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, " ");
    // Normalize whitespace
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
        .join("\n")
        .trim();
}
export async function fetchUrlContent(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SecondBrainClipper/1.3.0"
        }
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : new URL(url).hostname;
    const content = stripHtmlToMarkdown(html);
    return { title, content };
}
export function findExistingClippedSource(inboxDir, url, sha256) {
    if (!existsSync(inboxDir))
        return null;
    const entries = readdirSync(inboxDir);
    for (const entry of entries) {
        if (entry.endsWith(".meta.json")) {
            try {
                const sidecar = JSON.parse(readFileSync(join(inboxDir, entry), "utf8"));
                if (sidecar.source_url === url || sidecar.sha256 === sha256) {
                    return sidecar.source_id || entry.replace(".meta.json", "");
                }
            }
            catch {
                // Ignore unparseable sidecars
            }
        }
    }
    return null;
}
export async function clipSource(options) {
    const { vaultPath, urlOrFile, markdownContent } = options;
    const isUrl = /^https?:\/\//i.test(urlOrFile);
    if (isUrl) {
        const urlCheck = validateClipUrl(urlOrFile);
        if (!urlCheck.valid) {
            return {
                status: "failed",
                url: urlOrFile,
                reason: urlCheck.reason
            };
        }
    }
    let title = options.title || "";
    let text = markdownContent || "";
    if (isUrl && !markdownContent) {
        try {
            const fetched = await fetchUrlContent(urlOrFile);
            if (!title)
                title = fetched.title;
            text = fetched.content;
        }
        catch (err) {
            return {
                status: "failed",
                url: urlOrFile,
                reason: `fetch-failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }
    else if (!isUrl && !markdownContent) {
        const localPath = resolve(urlOrFile);
        if (!existsSync(localPath)) {
            return {
                status: "failed",
                url: urlOrFile,
                reason: `file-not-found: ${localPath}`
            };
        }
        text = readFileSync(localPath, "utf8");
        title = basename(localPath);
    }
    if (!title) {
        title = isUrl ? new URL(urlOrFile).hostname : basename(urlOrFile);
    }
    // Secret scan hygiene check
    const secretFindings = scanTextForSecrets(text, urlOrFile);
    if (secretFindings.length > 0) {
        return {
            status: "failed",
            url: urlOrFile,
            reason: "credential-detected"
        };
    }
    const sha256 = computeSha256(text);
    // Target directory: 01_Inbox/_drop/, 50-ops/inbox/_drop/ (Instance vault) or legacy sources/inbox/
    const dropDir = resolveDropDir(vaultPath);
    mkdirSync(dropDir, { recursive: true });
    // Deduplication check
    const existingId = findExistingClippedSource(dropDir, urlOrFile, sha256);
    if (existingId) {
        return {
            status: "exists",
            id: existingId,
            url: urlOrFile,
            sha256
        };
    }
    const timestamp = new Date().toISOString();
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "clip";
    const sourceId = `SRC-${Date.now()}-${slug.toUpperCase()}`;
    const fileName = `${sourceId}.md`;
    const destPath = join(dropDir, fileName);
    const fileBody = [
        "---",
        `source_id: "${sourceId}"`,
        `title: "${title.replace(/"/g, '\\"')}"`,
        `source_url: "${urlOrFile}"`,
        `captured_at: "${timestamp}"`,
        `sha256: "${sha256}"`,
        "status: pending_curation",
        "---",
        "",
        `# ${title}`,
        "",
        `> Captured from [${urlOrFile}](${urlOrFile}) on ${timestamp.slice(0, 10)}.`,
        "",
        text
    ].join("\n");
    writeFileSync(destPath, fileBody, "utf8");
    const sidecar = {
        source_id: sourceId,
        title,
        source_url: urlOrFile,
        sha256,
        captured_at: timestamp,
        status: "pending_curation",
        file: fileName
    };
    writeFileSync(`${destPath}.meta.json`, JSON.stringify(sidecar, null, 2), "utf8");
    return {
        status: "captured",
        id: sourceId,
        url: urlOrFile,
        file: fileName,
        sha256
    };
}
//# sourceMappingURL=clipper.js.map