/**
 * Secret detection: offline and pattern-based. `SECRET_PATTERNS` is the one
 * documented list of what counts as a secret; add a pattern there and every
 * consumer (`capture`, `scan-secrets`, the `secret-scan` doctor check) picks it
 * up.
 *
 * Hard rule: a matched value never leaves this module. A finding carries the
 * line number and the pattern name only, so no report, log entry or console
 * line can leak the secret. Do not add the matched text, the line text or any
 * excerpt to `SecretFinding`.
 *
 * Known limits: only text files are scanned (a NUL byte in the first 8 KB marks
 * a file as binary, the same rule the hashing uses), only UTF-8 is decoded, and
 * the patterns are heuristics. They lean towards false positives because the
 * response to a match (quarantine) never deletes anything.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listFiles } from './files.js';
import { isText } from './hashing.js';
import { finding } from './report.js';
import { ZONES } from './zones.js';

/**
 * @typedef {object} SecretPattern
 * @property {string} name stable identifier, reported as the finding rule
 * @property {string} description what the pattern detects
 * @property {RegExp} regex tested against one line at a time (no `g` flag)
 * @property {(match: RegExpExecArray) => boolean} [accept] extra test on the match
 *
 * @typedef {object} SecretFinding
 * @property {number} line 1-based line number
 * @property {string} pattern name of the matching pattern
 * @property {string} [field] set when the match is in metadata (such as the file name) rather than in file content
 */

/** Values that are placeholders, not secrets, in an assignment. */
const PLACEHOLDER = /changeme|change-me|example|placeholder|redacted|your[-_ ]|xxxx|dummy|sample/i;

/**
 * An assignment value counts as a non-trivial literal when it is at least 8
 * characters, is not a variable reference, call or placeholder, and holds a
 * digit or a symbol (so plain words and identifiers such as `process.env.KEY`
 * are ignored).
 * @param {RegExpExecArray} match group 1 is the value
 * @returns {boolean}
 */
function isNonTrivialLiteral(match) {
  const value = match[1];
  if (/^[$%{[*]/.test(value)) return false; // ${VAR}, %VAR%, {{ var }}, [REDACTED], ****
  if (/^[\w.]+\(/.test(value)) return false; // function call
  if (PLACEHOLDER.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false; // one repeated character
  return /[^A-Za-z_.-]/.test(value);
}

/**
 * The documented list of secret patterns, in report order.
 * @type {readonly SecretPattern[]}
 */
export const SECRET_PATTERNS = Object.freeze([
  {
    name: 'aws-access-key-id',
    description: 'cloud access key id (AWS style: AKIA, ASIA and similar prefixes plus 16 characters)',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'gcp-api-key',
    description: 'cloud API key (Google style: AIza plus 35 characters)',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_ or github_pat_ prefixes)',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    name: 'slack-token',
    description: 'Slack token (xoxa-, xoxb-, xoxp-, xoxr-, xoxs- prefixes)',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: 'api-token-prefix',
    description: 'generic API key with a well-known prefix (sk-..., sk_live_..., rk_live_..., pk_live_...)',
    regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|[spr]k_(?:live|test)_[A-Za-z0-9]{16,})/,
  },
  {
    name: 'private-key-block',
    description: 'PEM private key block header (-----BEGIN ... PRIVATE KEY-----)',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: 'jwt',
    description: 'JSON Web Token shape (three base64url parts, the first two starting with eyJ)',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    name: 'credential-assignment',
    description: 'password, passwd, secret or token assigned a non-trivial literal value (key=value, key: value)',
    regex: /(?:password|passwd|secret|token)["']?\s*(?:=(?!=)|:(?!:))\s*["']?([^\s"'`,;<>=]{8,})/i,
    accept: isNonTrivialLiteral,
  },
]);

/** Global copies of the pattern regexes, so every match on a line is tested. */
const GLOBAL = SECRET_PATTERNS.map((p) => ({ pattern: p, regex: new RegExp(p.regex.source, `${p.regex.flags}g`) }));

/**
 * Scan text, one line at a time. Reports each pattern at most once per line.
 * @param {string} text
 * @returns {SecretFinding[]} sorted by line, then pattern order; never holds the matched value
 */
export function scanText(text) {
  /** @type {SecretFinding[]} */
  const findings = [];
  text.split(/\r\n|\n|\r/).forEach((line, i) => {
    for (const { pattern, regex } of GLOBAL) {
      for (const match of line.matchAll(regex)) {
        if (pattern.accept === undefined || pattern.accept(match)) {
          findings.push({ line: i + 1, pattern: pattern.name });
          break;
        }
      }
    }
  });
  return findings;
}

/**
 * Scan file content. Binary content is not scanned.
 * @param {Uint8Array} bytes
 * @returns {SecretFinding[]}
 */
export function scanBytes(bytes) {
  if (!isText(bytes)) return [];
  return scanText(Buffer.from(bytes).toString('utf8'));
}

/**
 * @param {string} path absolute file path
 * @returns {Promise<SecretFinding[]>}
 */
export async function scanFile(path) {
  return scanBytes(await readFile(path));
}

/** Zones whose files are scanned: raw sources and compiled notes. */
export const SCANNED_ZONES = Object.freeze([ZONES.sources, ZONES.compiled]);

/**
 * Scan the raw sources and compiled notes of a vault. Quarantine is not
 * scanned: it holds material already known to match.
 * @param {string} vault absolute vault path
 * @returns {Promise<Array<SecretFinding & { path: string }>>} `path` is vault-relative with forward slashes
 */
export async function scanVault(vault) {
  /** @type {Array<SecretFinding & { path: string }>} */
  const results = [];
  for (const zone of SCANNED_ZONES) {
    const folder = join(vault, zone);
    for (const file of await listFiles(folder)) {
      const path = `${zone}/${file}`;
      for (const finding of await scanFile(join(folder, ...file.split('/')))) results.push({ path, ...finding });
    }
  }
  return results;
}

/**
 * Turn scan results into report findings. The message names the pattern and
 * line only.
 * @param {Array<SecretFinding & { path: string }>} results
 * @returns {import('./report.js').Finding[]}
 */
export function toReportFindings(results) {
  return results.map((r) =>
    finding(
      r.path,
      r.pattern,
      'error',
      r.field === undefined ? `secret pattern "${r.pattern}" matched at line ${r.line}` : `secret pattern "${r.pattern}" matched in the ${r.field}`,
      r.line,
    ),
  );
}
