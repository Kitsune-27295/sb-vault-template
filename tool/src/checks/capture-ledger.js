import { exists } from '../lib/files.js';
import { CAPTURE_ACTIONS, LOG_DIR, parseHeader, readLog } from '../lib/log.js';
import { finding } from '../lib/report.js';
import { loadRawSources } from '../lib/sources.js';
import { ZONES } from '../lib/zones.js';

export const id = 'capture-ledger';

/**
 * The log is the ledger of what was captured: every `capture` and `supersede`
 * entry is titled with the source id it sealed, and that source must still
 * exist in `10-sources/` with its sidecar. A source deleted together with its
 * sidecar leaves nothing for `raw-source-integrity` to compare, but the log
 * entry, which cannot be edited without breaking the hash chain, still names it.
 * Quarantined material is not checked: the curator decides what happens to it.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  const log = await readLog(vault);
  /** @type {import('../lib/report.js').Finding[]} */
  const findings = [];
  /** @type {Map<string, import('../lib/sources.js').RawSourceEntry> | null} */
  let sources = null;
  for (const file of log.files) {
    for (const entry of file.entries) {
      const header = parseHeader(entry.header);
      if (header === null || !CAPTURE_ACTIONS.includes(header.action)) continue;
      sources ??= new Map((await loadRawSources(vault)).map((s) => [s.id, s]));
      const sourceId = header.title.trim();
      const source = sources.get(sourceId);
      const problem =
        source === undefined
          ? `has no raw source file in ${ZONES.sources}/`
          : (await exists(source.sidecarPath))
            ? null
            : `has no sidecar in ${ZONES.sources}/`;
      if (problem === null) continue;
      findings.push(
        finding(
          `${LOG_DIR}/${file.name}`,
          'source-missing',
          'error',
          `the ${header.action} entry "${entry.header}" names source ${sourceId}, which ${problem}; a source was deleted or moved`,
          entry.line,
        ),
      );
    }
  }
  return findings;
}
