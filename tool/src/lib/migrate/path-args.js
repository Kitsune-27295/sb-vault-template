import { isAbsolute, relative, sep } from 'node:path';
import { UsageError } from '../errors.js';
import { canonicalPath } from '../paths.js';

/**
 * Refuse a path argument that is hostile, before any file is touched. A POSIX-style drive path on
 * Windows is refused by `resolveUserPath`, which the caller uses next.
 * @param {string} value path as given on the command line
 * @param {string} what what it is called in the message, such as `source`
 * @returns {void}
 * @throws {UsageError}
 */
export function assertSafePathArgument(value, what) {
  if (value.trim() === '') throw new UsageError(`the ${what} path is empty`);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UsageError(`the ${what} path holds a control character (a line break or similar); nothing was written`);
  }
  if (process.platform === 'win32' && /^[\\/]{2}[.?][\\/]/.test(value)) {
    throw new UsageError(`the ${what} path is a Windows device path, which is refused; nothing was written`);
  }
}

/**
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean} whether `inner` is `outer` or lies inside it
 */
export function isInside(outer, inner) {
  const path = relative(canonicalPath(outer), canonicalPath(inner));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Refuse a target that is the source or lies inside it (the engine would read what it writes), or a
 * source that lies inside the target.
 * @param {string} source absolute source path
 * @param {string} target absolute target path
 * @returns {void}
 * @throws {UsageError}
 */
export function assertSeparate(source, target) {
  if (isInside(source, target)) {
    throw new UsageError(`the target is the source or lies inside the source, so the import would read what it writes; choose a folder outside it: ${target}`);
  }
  if (isInside(target, source)) {
    throw new UsageError(`the source lies inside the target; choose a target outside the source: ${target}`);
  }
}
