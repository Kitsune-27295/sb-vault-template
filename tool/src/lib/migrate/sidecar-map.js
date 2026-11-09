/**
 * The sidecar of an imported raw source (ADR 0003, ADR 0011). The Instance requires `sha256`,
 * `captured_at`, `origin` and `original_name`; the old framework's own keys all stay.
 */

/** Marks the fields that were filled from the file, not recorded by the old framework. */
export const DEFAULTS_KEY = 'import_defaults';

/** Holds the hash the old framework recorded when it differs from the Instance's hash of the same bytes. */
export const SOURCE_HASH_KEY = 'source_sha256';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null} the value when it is a plain JSON object
 */
export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {value is string} */
const filled = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Build the Instance sidecar of one raw source.
 * - `sha256` is the Instance's hash of the bytes. The old framework's own value is reused when it is
 *   equal, and kept under `source_sha256` when it differs.
 * - `captured_at` and `original_name` come from the old sidecar, else from the file (its modification
 *   time and its name); `origin` from `origin`, `url` or `source`, else a pointer to the imported path.
 *   A field filled from the file is named in `import_defaults`; nothing is invented about its history.
 * - Every other key is kept as it was.
 * @param {Record<string, unknown>} old the old sidecar
 * @param {object} raw
 * @param {string} raw.sha256 the Instance's hash of the raw source bytes
 * @param {string} raw.mtime ISO modification time of the raw source
 * @param {string} raw.source source-relative path of the raw source
 * @param {string} adapter adapter id, for the default origin
 * @returns {{ sidecar: Record<string, unknown>, defaults: string[] }}
 */
export function mapSidecar(old, { sha256, mtime, source }, adapter) {
  /** @type {string[]} */
  const defaults = [];
  const origin = [old.origin, old.url, old.source].find(filled);
  const capturedAt = filled(old.captured_at) ? old.captured_at : null;
  if (capturedAt === null) defaults.push('captured_at');
  if (origin === undefined) defaults.push('origin');
  if (!filled(old.original_name)) defaults.push('original_name');

  const rest = { ...old };
  for (const key of ['sha256', 'captured_at', 'origin', 'original_name', DEFAULTS_KEY]) delete rest[key];
  const differs = filled(old.sha256) && old.sha256 !== sha256 && !Object.hasOwn(old, SOURCE_HASH_KEY);
  return {
    sidecar: {
      sha256,
      captured_at: capturedAt ?? mtime,
      origin: origin ?? `imported:${adapter}:${source}`,
      original_name: filled(old.original_name) ? old.original_name : (source.split('/').pop() ?? source),
      ...rest,
      ...(differs ? { [SOURCE_HASH_KEY]: old.sha256 } : {}),
      ...(defaults.length > 0 ? { [DEFAULTS_KEY]: defaults } : {}),
    },
    defaults,
  };
}
