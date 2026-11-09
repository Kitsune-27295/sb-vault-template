/**
 * The identity and the invocation `attach` writes: the key of an Instance (its readable name plus a
 * short hash of its canonical path, so two folders with the same name never collide), the absolute
 * call of the CLI, and the one validation every path must pass before it is written into a block,
 * a printed block or a permission rule.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { FRAMEWORK_ROOT, canonicalSlash, slash } from './paths.js';

/** Characters that can start a shell expansion, a glob, a quote break-out or a marker break-out. */
const UNSAFE = /[$`\\"'*?[\]<>|&;!#{}%\r\n]/;

/**
 * The shared validation: a path written into a block, a `--print` block or a permission rule has no
 * shell, glob, quote, comment or line-break character. Parentheses and spaces are allowed.
 * @param {string} path a path with forward slashes
 * @param {string} what what the path is called in the message
 * @throws {UsageError} when the path cannot be written safely
 */
export function assertSafePath(path, what) {
  if (UNSAFE.test(path) || path.includes('-->')) {
    throw new UsageError(
      `the ${what} cannot be written into a block or a permission rule: ${JSON.stringify(path)} has one of $ \` \\ " ' * ? [ ] < > | & ; ! # { } % or a line break; rename the folder; nothing was written`,
    );
  }
}

/**
 * @typedef {object} Identity
 * @property {string} name readable name: the folder's base name, with every character outside [A-Za-z0-9._ -] replaced by `_`
 * @property {string} key `<name>-<8 hex of the sha256 of the canonical path>`, the key of the marker and of the permission record
 * @property {string} path the canonical path with forward slashes
 */

/**
 * @param {string} canonical canonical path with forward slashes, from `canonicalSlash`
 * @returns {Identity}
 */
export function identityOf(canonical) {
  const base = canonical.replace(/\/+$/, '').split('/').pop() ?? '';
  const name = base.replace(/[^A-Za-z0-9._ -]/g, '_') || 'instance';
  // Windows paths are case-insensitive: hash the lower-case form so a differently cased spelling gives the same key.
  const text = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return { name, key: `${name}-${hash}`, path: canonical };
}

/** @param {string} path an Instance path as given @returns {Identity} the identity of the Instance at that path, which need not exist */
export const identityForPath = (path) => identityOf(canonicalSlash(path));

/**
 * The call the block tells the agent to make: the absolute Node executable and the absolute CLI entry
 * of the running framework, so no PATH lookup is needed.
 * @returns {{ node: string, cli: string }} paths with forward slashes
 */
export function invocation() {
  return { node: slash(process.execPath), cli: canonicalSlash(join(FRAMEWORK_ROOT, 'bin', 'sbk.js')) };
}
