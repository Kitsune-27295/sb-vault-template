import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeAndConvertHtml } from './sanitizer.js';
import activeProfile from '../profiles/active.js';

/**
 * Clean slug generation for file names
 */
export function slugifyTitle(title) {
  return title
    .replace(/\(.*?\)/g, '') // remove parentheticals
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-zA-Z0-9\s_-]/g, '') // remove special symbols
    .trim()
    .replace(/[\s-]+/g, '_');
}

/**
 * Cross-platform curl fallback for anti-bot bypass
 */
function fetchWithCurl(url, userAgent) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return execFileSync(curlBin, ['-s', '-L', '-A', userAgent, url], {
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
  });
}

/**
 * Clips a URL or HTML string and saves .md + .json sidecar
 */
export async function clipUrlOrHtml({ url, html, franchise = null, vaultRoot = process.cwd(), dryRun = false, replaceExisting = false, profile = activeProfile }) {
  let rawHtml = html;

  if (!rawHtml && url) {
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // Fandom / MediaWiki native API fast-path (bypasses Cloudflare anti-bot and delivers clean article HTML)
    const fandomMatch = url.match(/^(https?:\/\/[^\/]+)\/wiki\/(.+)$/);
    if (fandomMatch && fandomMatch[1].includes('fandom.com')) {
      try {
        const domain = fandomMatch[1];
        const pageTitle = decodeURIComponent(fandomMatch[2]);
        const apiUrl = `${domain}/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&redirects=1`;
        const apiRes = await fetch(apiUrl, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        });
        if (apiRes.ok) {
          const apiData = await apiRes.json();
          if (apiData?.parse?.text?.['*']) {
            rawHtml = `<!DOCTYPE html><html><head><title>${apiData.parse.title}</title></head><body><h1 id="firstHeading">${apiData.parse.title}</h1>${apiData.parse.text['*']}</body></html>`;
          }
        }
      } catch {
        // Fall through to standard fetch / curl fallback
      }
    }

    if (!rawHtml) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
        });
        if (res.ok) {
          rawHtml = await res.text();
        } else {
          // Fallback to curl on anti-bot / 403 response
          try {
            rawHtml = fetchWithCurl(url, userAgent);
          } catch {
            throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
          }
        }
      } catch (fetchErr) {
        try {
          rawHtml = fetchWithCurl(url, userAgent);
        } catch {
          throw fetchErr;
        }
      }
    }
  }

  if (!rawHtml) {
    throw new Error('No HTML content provided or fetched.');
  }

  // The profile decides where the capture goes and which provenance fields it carries.
  const route = profile.clip.route({ url: url || '', explicitFranchise: franchise, vaultRoot });
  const targetFranchise = route.group;
  route.scaffold();

  const parsed = sanitizeAndConvertHtml(rawHtml, url);
  if (parsed.title.toLowerCase().includes('just a moment') || parsed.title.toLowerCase().includes('attention required')) {
    throw new Error(`Cloudflare anti-bot challenge page intercepted for ${url}. Aborting clip.`);
  }
  const slug = slugifyTitle(parsed.title);

  const sourcesDir = route.sourcesDir;
  const mdPath = path.join(sourcesDir, `${slug}.md`);
  const jsonPath = path.join(sourcesDir, `${slug}.json`);

  // Keep captures immutable unless replacement is explicitly authorized.
  const captureExists = fs.existsSync(mdPath) || fs.existsSync(jsonPath);
  if (fs.existsSync(jsonPath)) {
    try {
      const existingMeta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const existingMarkdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      const frontmatterMatch = existingMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      const existingBody = frontmatterMatch ? existingMarkdown.slice(frontmatterMatch[0].length).replace(/^\r?\n/, '') : null;
      if (existingMeta.content_sha256 === parsed.contentHash && existingBody === parsed.markdown) {
        return {
          status: 'unchanged',
          slug,
          franchise: targetFranchise,
          mdPath,
          jsonPath,
          contentHash: parsed.contentHash,
        };
      }
    } catch {
      // A corrupt sidecar is still protected data; require explicit replacement.
    }
  }
  if (captureExists && !replaceExisting) {
    throw new Error(`Capture already exists with different or unreadable provenance: ${mdPath}. Inspect it and rerun with --replace-existing only if replacement is intended.`);
  }

  const sidecar = {
    source_id: `src_${slug}_${parsed.contentHash.slice(0, 8)}`,
    url: url || 'local',
    title: parsed.title,
    ...route.sidecar,
    captured_at: new Date().toISOString(),
    content_sha256: parsed.contentHash,
    categories: parsed.categories,
    infobox: parsed.infobox,
  };

  if (!dryRun) {
    fs.mkdirSync(sourcesDir, { recursive: true });
    const frontmatter = [
      '---',
      `title: "${parsed.title.replace(/"/g, '\\"')}"`,
      `note_type: ${route.noteType}`,
      ...route.frontmatter.map(([key, value]) => `${key}: ${value}`),
      `source_url: "${url || 'local'}"`,
      'is_processed: false',
      '---',
      '',
      '',
    ].join('\n');
    fs.writeFileSync(mdPath, frontmatter + parsed.markdown, 'utf8');
    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2), 'utf8');
  }

  return {
    status: captureExists ? 'replaced' : 'created',
    slug,
    franchise: targetFranchise,
    mdPath,
    jsonPath,
    contentHash: parsed.contentHash,
  };
}

// CLI entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let url = '';
  let franchise = null;
  let htmlPath = null;
  let dryRun = false;
  let replaceExisting = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node tools/clipper/clipper.js <url> [--franchise <name>] [--html-file <path>] [--dry-run] [--replace-existing]');
      process.exit(0);
    } else if (args[i] === '--franchise' || args[i] === '-f') {
      franchise = args[++i];
    } else if (args[i] === '--html-file') {
      htmlPath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--replace-existing') {
      replaceExisting = true;
    } else if (!url && !args[i].startsWith('-')) {
      url = args[i];
    }
  }

  if (!url && !htmlPath) {
    console.log('Usage: node tools/clipper/clipper.js <url> [--franchise <name>] [--html-file <path>] [--dry-run] [--replace-existing]');
    process.exit(1);
  }

  let htmlContent = null;
  if (htmlPath) {
    htmlContent = fs.readFileSync(htmlPath, 'utf8');
  }

  clipUrlOrHtml({ url, html: htmlContent, franchise, dryRun, replaceExisting })
    .then(res => {
      console.log(`[CLIPPER] Result: ${res.status.toUpperCase()} -> ${res.slug} (${res.franchise})`);
      console.log(`[CLIPPER] MD: ${res.mdPath}`);
      console.log(`[CLIPPER] JSON: ${res.jsonPath}`);
    })
    .catch(err => {
      console.error(`[CLIPPER ERROR]`, err.message);
      process.exit(1);
    });
}
