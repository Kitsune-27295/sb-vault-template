/**
 * The paths a Git working tree tracks, read from its index file (`.git/index`). Git is not spawned: the
 * framework core uses no child processes (tests/standards.test.js). The layout is Git's index format,
 * versions 2 and 3: a 12-byte header ("DIRC", version, entry count), then one entry per path, each padded
 * to a multiple of 8 bytes, then extensions in any order, then a 20-byte checksum. What this reader does
 * not understand is refused, never read as "nothing is tracked".
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SIGNATURE = 'DIRC';
const HEADER_BYTES = 12;
const CHECKSUM_BYTES = 20;
const EXTENSION_HEADER_BYTES = 8;
/** Bytes of a version 2 entry before its name, flags included. */
const FIXED_BYTES = 62;
/** A version 3 entry carries two more bytes of extended flags when this bit is set. */
const EXTENDED_FLAG = 0x4000;
const NAME_LENGTH_MASK = 0xfff;
const SPLIT_INDEX_EXTENSION = 'link';

/**
 * Where the index of a working tree is.
 * @param {string} repo working tree root
 * @returns {Promise<{ gitDir: string, indexPath: string } | null>} null when there is no `.git` at all
 * @throws {Error} when there is a `.git` that does not lead to a Git folder: a broken worktree is never
 *   taken for a folder with nothing tracked
 */
export async function indexLocation(repo) {
  const dotGit = join(repo, '.git');
  let info;
  try {
    info = await stat(dotGit);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
  let gitDir = dotGit;
  if (!info.isDirectory()) {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
    if (pointer === null) throw new Error('the .git file has no "gitdir:" line, so the Git folder cannot be found');
    gitDir = resolve(repo, pointer[1]);
    const target = await stat(gitDir).catch(() => null);
    if (target === null || !target.isDirectory()) throw new Error(`the .git file points to a folder that does not exist: ${pointer[1]}`);
  }
  return { gitDir, indexPath: join(gitDir, 'index') };
}

/**
 * The distinct paths of an index, in index order. Conflicted entries (several stages) share one path.
 * @param {Buffer} bytes the index file
 * @returns {string[]}
 * @throws {Error} when the bytes are not an index this reader supports
 */
export function parseIndex(bytes) {
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES || bytes.toString('latin1', 0, 4) !== SIGNATURE) throw new Error('the index file is not a Git index');
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`Git index version ${version} is not read by this framework (use index version 2 or 3)`);
  const count = bytes.readUInt32BE(8);
  const end = bytes.length - CHECKSUM_BYTES;
  const paths = new Set();
  let offset = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (offset + FIXED_BYTES > end) throw new Error('the index file is truncated inside an entry');
    const flags = bytes.readUInt16BE(offset + 60);
    const base = FIXED_BYTES + (version === 3 && (flags & EXTENDED_FLAG) !== 0 ? 2 : 0);
    const nameStart = offset + base;
    const length = flags & NAME_LENGTH_MASK;
    const nameEnd = length < NAME_LENGTH_MASK ? nameStart + length : bytes.indexOf(0, nameStart);
    if (nameEnd < 0 || nameEnd > end) throw new Error('the index file is truncated inside an entry');
    paths.add(bytes.toString('utf8', nameStart, nameEnd));
    offset += (base + (nameEnd - nameStart) + 8) & ~7;
  }
  // Extensions follow the entries in no fixed order (a cache tree may come first), so every one is walked.
  while (offset < end) {
    if (offset + EXTENSION_HEADER_BYTES > end) throw new Error('the index file is truncated inside an extension');
    if (bytes.toString('latin1', offset, offset + 4) === SPLIT_INDEX_EXTENSION) {
      throw new Error('the index is split (core.splitIndex): its shared part is not read by this framework');
    }
    offset += EXTENSION_HEADER_BYTES + bytes.readUInt32BE(offset + 4);
  }
  if (offset !== end) throw new Error('the index file is truncated inside an extension');
  return [...paths];
}

/**
 * The tracked paths of a working tree.
 * @param {string} repo working tree root
 * @returns {Promise<string[] | null>} the paths (empty when Git has nothing staged yet); null when there is no
 *   `.git` at all
 * @throws {Error} when the Git entry or the index cannot be read
 */
export async function trackedPaths(repo) {
  const location = await indexLocation(repo);
  if (location === null) return null;
  let bytes;
  try {
    bytes = await readFile(location.indexPath);
  } catch (error) {
    // A repository with nothing staged has no index file yet: it tracks nothing.
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  return parseIndex(bytes).sort();
}
