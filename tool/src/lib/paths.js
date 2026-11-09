import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.js';
import { listFiles } from './files.js';

/** Absolute path of the framework repository root (the folder holding `package.json`). */
export const FRAMEWORK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve a folder argument given on the command line to an absolute path. On Windows a
 * POSIX-style drive path such as `/c/Users/x` (what Git Bash prints) would resolve against the
 * current drive as `C:\c\Users\x`, a wrong folder that is silently created or read, so it is
 * refused with a hint to write `C:/<folder>` instead.
 * @param {string} path path as given
 * @returns {string} absolute path
 * @throws {UsageError} on Windows, for a POSIX-style drive path
 */
export function resolveUserPath(path) {
  if (process.platform === 'win32' && /^[\\/][A-Za-z](?:[\\/]|$)/.test(path)) {
    const drive = path[1].toUpperCase();
    throw new UsageError(
      `looks like a POSIX drive path, which Windows would read as ${drive}:\\${path[1]}\\...: write ${drive}:/${path.slice(3).replace(/\\/g, '/')} instead`,
    );
  }
  return resolve(path);
}

/**
 * The vault base: `template/` inside the framework root (the source repository), otherwise `template/`
 * beside it (the published tree, where the tool lives at `tool/` and the template at `template/`).
 * @param {string} root framework root
 * @returns {string} absolute path
 */
function defaultTemplateDir(root) {
  const inside = join(root, 'template');
  return existsSync(inside) ? inside : resolve(root, '..', 'template');
}

/** Absolute path of the vault base copied by `init`. */
export const TEMPLATE_DIR = defaultTemplateDir(FRAMEWORK_ROOT);

/**
 * Framework version, read from `package.json`.
 * @returns {string}
 */
export function frameworkVersion() {
  const pkg = JSON.parse(readFileSync(join(FRAMEWORK_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * Vault-relative path with forward slashes, the form used in reports on every platform.
 * @param {string} vault absolute vault path
 * @param {string} absolute absolute path inside the vault
 * @returns {string}
 */
export function toVaultPath(vault, absolute) {
  return relative(vault, absolute).split(sep).join('/');
}

/**
 * The inverse of `toVaultPath`: the absolute path of a vault-relative path.
 * @param {string} vault absolute vault path
 * @param {string} vaultPath vault-relative path with forward slashes
 * @returns {string}
 */
export function fromVaultPath(vault, vaultPath) {
  return join(vault, ...vaultPath.split('/'));
}

/** Folders that are never part of the knowledge base. */
const SKIPPED_FOLDERS = new Set(['node_modules']);

/**
 * Every file below `vault`, skipping hidden folders (`.git`, `.obsidian`, ...)
 * and `node_modules`. Symbolic links are not followed.
 * @param {string} vault absolute vault path
 * @returns {Promise<string[]>} vault-relative paths with forward slashes, sorted
 */
export function listVaultFiles(vault) {
  return listFiles(vault, { skip: (name, isDirectory) => isDirectory && (name.startsWith('.') || SKIPPED_FOLDERS.has(name)) });
}

/**
 * @param {string} path
 * @returns {string} the path with forward slashes, the form used in blocks, rules and reports (a backslash is a separator on Windows only)
 */
export function slash(path) {
  return sep === '\\' ? path.split('\\').join('/') : path;
}

/**
 * The real, long form of a path, so that 8.3 short names, case differences, `..` segments and links
 * all give the same string. A path that does not exist (a deleted Instance) is resolved through its
 * nearest existing parent.
 * @param {string} path
 * @returns {string} absolute path in the platform's own separators
 */
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/** @param {string} path @returns {string} the canonical path with forward slashes */
export const canonicalSlash = (path) => slash(canonicalPath(path));

/** @param {string} path @returns {string} the absolute path with forward slashes, without resolving links */
export const absoluteSlash = (path) => slash(resolve(path));
