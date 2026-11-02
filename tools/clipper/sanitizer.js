import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import crypto from 'node:crypto';

/**
 * Common selectors for noisy, non-content elements found on fandom/media wikis
 */
const PRUNE_SELECTORS = [
  'nav',
  'footer',
  'header',
  'aside',
  'script',
  'style',
  'noscript',
  'iframe',
  '.ad-container',
  '.advertisement',
  '.ad-slot',
  '#mw-navigation',
  '#mw-head',
  '#mw-panel',
  '#siteNotice',
  '.mw-editsection',
  '.reference',
  '.reflist',
  '.citation',
  '.navbox',
  '.vertical-navbox',
  '.wikia-bar',
  '.page-footer',
  '.global-footer',
  '.notifications-placeholder',
  '#catlinks',
  '.wds-global-navigation',
  '.wds-community-header',
  '.toc',
  '#toc',
];

/**
 * Configure Turndown with GFM tables and clean code blocks
 */
function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  // Keep tables intact
  service.addRule('table', {
    filter: ['table'],
    replacement: function (_content, node) {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      const tableData = rows.map(row => {
        const cells = Array.from(row.querySelectorAll('th, td'));
        return cells.map(c => c.textContent.trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|'));
      });

      if (tableData.length === 0 || tableData[0].length === 0) return '';

      const colCount = Math.max(...tableData.map(r => r.length));
      // Normalize rows to same column count
      const normalized = tableData.map(row => {
        while (row.length < colCount) row.push('');
        return row;
      });

      const headerRow = normalized[0];
      const separatorRow = new Array(colCount).fill('---');
      const bodyRows = normalized.slice(1);

      const headerMd = `| ${headerRow.join(' | ')} |`;
      const separatorMd = `| ${separatorRow.join(' | ')} |`;
      const bodyMd = bodyRows.map(r => `| ${r.join(' | ')} |`).join('\n');

      return `\n\n${headerMd}\n${separatorMd}\n${bodyMd}\n\n`;
    },
  });

  // Remove empty links or anchors
  service.addRule('emptyLinks', {
    filter: function (node) {
      return node.nodeName === 'A' && !node.textContent.trim();
    },
    replacement: function () {
      return '';
    },
  });

  return service;
}

/**
 * Extracts structured infobox data from portable-infobox or standard table infoboxes
 */
export function extractInfoboxData(doc) {
  const infoboxData = {};

  // 1. Fandom portable-infobox
  const piItems = doc.querySelectorAll('.portable-infobox .pi-item');
  piItems.forEach(item => {
    const label = item.querySelector('.pi-data-label')?.textContent?.trim();
    const value = item.querySelector('.pi-data-value')?.textContent?.trim();
    if (label && value) {
      infoboxData[label] = value.replace(/\s+/g, ' ');
    }
  });

  // 2. Standard table.infobox
  const standardInfobox = doc.querySelector('table.infobox');
  if (standardInfobox) {
    const rows = standardInfobox.querySelectorAll('tr');
    rows.forEach(tr => {
      const th = tr.querySelector('th')?.textContent?.trim();
      const td = tr.querySelector('td')?.textContent?.trim();
      if (th && td && !infoboxData[th]) {
        infoboxData[th] = td.replace(/\s+/g, ' ');
      }
    });
  }

  return infoboxData;
}

/**
 * Extracts page categories
 */
export function extractCategories(doc) {
  const categories = [];
  const catLinks = doc.querySelectorAll('#mw-normal-catlinks ul li a, .page-header__categories-links a');
  catLinks.forEach(link => {
    const cat = link.textContent?.trim();
    if (cat && !categories.includes(cat)) {
      categories.push(cat);
    }
  });
  return categories;
}

/**
 * Main DOM sanitizer and HTML-to-Markdown converter
 */
export function sanitizeAndConvertHtml(htmlString, url = '') {
  const { document } = parseHTML(htmlString);

  // Extract Title
  let title = document.querySelector('#firstHeading, .page-header__title, h1')?.textContent?.trim();
  if (!title) {
    title = document.querySelector('title')?.textContent?.split('|')[0]?.split('-')[0]?.trim() || 'Untitled';
  }

  // Extract Infobox before pruning
  const infobox = extractInfoboxData(document);
  const categories = extractCategories(document);

  // Prune noise elements
  PRUNE_SELECTORS.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => el.remove());
  });

  // Find primary main content element
  const mainContent = document.querySelector(
    '#mw-content-text .mw-parser-output, #mw-content-text, #content, main, article, body'
  );

  const targetNode = mainContent || document.body;

  // Also remove the infobox from main text if already extracted so it doesn't duplicate
  const infoboxElements = targetNode.querySelectorAll('.portable-infobox, table.infobox');
  infoboxElements.forEach(el => el.remove());

  const turndown = createTurndownService();
  let markdown = turndown.turndown(targetNode.innerHTML);

  // Prepend title as H1 if not already present
  if (!markdown.startsWith('# ')) {
    markdown = `# ${title}\n\n${markdown}`;
  }

  // Normalize excessive blank lines
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  // Compute SHA-256 for idempotency
  const contentHash = crypto.createHash('sha256').update(markdown).digest('hex');

  return {
    title,
    markdown,
    infobox,
    categories,
    contentHash,
  };
}

