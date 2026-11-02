import fs from 'node:fs';
import path from 'node:path';
import { searchDocuments } from './search.js';
import activeProfile from '../profiles/active.js';

/**
 * Estimates token count from a character length (~4 characters per token).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Categorizes a search result into one of the 5 context tiers of the active profile.
 * @param {Record<string, any>} doc
 * @param {{tierOf: Function}} [profile]
 * @returns {number} Tier 1 to 5
 */
export function categorizeTier(doc, profile = activeProfile) {
  return profile.tierOf(doc);
}

/**
 * Assembles a structured, tiered context packet (tiers and texts come from the active profile) respecting token budget.
 *
 * @param {Object} options
 * @param {string} options.query - Query prompt or focus keywords.
 * @param {string} [options.scenePath] - Optional path to current scene file to anchor.
 * @param {number} [options.budgetTokens=2500] - Total token budget for context.
 * @param {import('node:sqlite').DatabaseSync} options.db - SQLite database instance.
 * @param {number} [options.maxDocs=15] - Maximum documents to retrieve from FTS.
 * @returns {{ contextText: string, packedTiers: number[], tokenEstimate: number, sources: string[] }}
 */
export function assembleContext({ query, scenePath, budgetTokens = 2500, db, maxDocs = 20, profile = activeProfile }) {
  const { context } = profile;
  const maxChars = budgetTokens * 4;
  const sources = [];
  const packedTiers = new Set();

  // Tier buckets
  const tiers = {
    1: [], // highest priority; meaning per profile (narr: active scene anchor)
    2: [],
    3: [],
    4: [],
    5: [], // lowest priority; meaning per profile (narr: canon background lore)
  };

  // If scenePath is provided, anchor it as Tier 1
  if (scenePath) {
    if (fs.existsSync(scenePath)) {
      const sceneContent = fs.readFileSync(scenePath, 'utf-8');
      const sceneTitle = path.basename(scenePath, path.extname(scenePath)).replace(/_/g, ' ');
      tiers[1].push({
        rel_path: scenePath.replace(/\\/g, '/'),
        title: sceneTitle,
        content: sceneContent,
        zone: context.anchor.zone,
        ptype: context.anchor.ptype,
      });
    } else {
      console.warn(`[RAG WARNING] Scene file not found: ${scenePath}`);
    }
  }

  // Retrieve candidate documents using BM25 with an expanded pool to prevent dropping PODs
  const rawResults = searchDocuments(db, query, { limit: Math.max(maxDocs, 50) });

  // Distribute into tiers
  for (const doc of rawResults) {
    const tierNum = categorizeTier(doc, profile);
    // Avoid duplicate if scenePath was already anchored
    if (scenePath && doc.rel_path === scenePath.replace(/\\/g, '/')) {
      continue;
    }
    tiers[tierNum].push(doc);
  }

  // Build the markdown text while monitoring character budget
  const header = `# ${context.heading}\n${context.preface}\n\n`;

  let outputText = header;
  let remainingChars = maxChars - header.length;

  const tierTitles = context.tierTitles;

  // Process tiers in strict priority order (1 -> 2 -> 3 -> 4 -> 5)
  for (let t = 1; t <= 5; t++) {
    const docs = tiers[t];
    if (!docs || docs.length === 0) continue;

    const tierHeader = `\n${tierTitles[t]}\n`;
    if (remainingChars < tierHeader.length + 50) break;

    let tierContent = '';
    let itemsAddedInTier = 0;
    let tierBudgetUsed = tierHeader.length;

    for (const doc of docs) {
      const availableForDoc = remainingChars - tierBudgetUsed;
      if (availableForDoc <= 60) break;

      const docHeader = `\n### ${doc.title} (\`${doc.rel_path}\`)\n`;
      let docBody = doc.content.trim();

      // Tier banner (for example the AU override warning of the narr profile)
      if (context.banners[t]) {
        docBody = `${context.banners[t]}\n\n${docBody}`;
      }

      const totalItemText = docHeader + docBody + '\n';

      if (totalItemText.length <= availableForDoc) {
        tierContent += totalItemText;
        tierBudgetUsed += totalItemText.length;
        sources.push(doc.rel_path);
        itemsAddedInTier++;
      } else {
        // Truncate cleanly to fit within remaining budget
        const truncationNotice = '\n\n*(Truncated to preserve context budget)*\n';
        const overhead = docHeader.length + truncationNotice.length;
        const allowedSnippetLen = availableForDoc - overhead;

        if (allowedSnippetLen > 40) {
          const snippet = docBody.slice(0, allowedSnippetLen) + truncationNotice;
          tierContent += docHeader + snippet;
          tierBudgetUsed += (docHeader.length + snippet.length);
          sources.push(doc.rel_path);
          itemsAddedInTier++;
        }
        break;
      }
    }

    if (itemsAddedInTier > 0) {
      outputText += tierHeader + tierContent;
      remainingChars -= tierBudgetUsed;
      packedTiers.add(t);
    }
  }

  const finalTokenEstimate = estimateTokens(outputText);

  return {
    contextText: outputText.trim(),
    packedTiers: Array.from(packedTiers).sort(),
    tokenEstimate: finalTokenEstimate,
    sources,
  };
}

