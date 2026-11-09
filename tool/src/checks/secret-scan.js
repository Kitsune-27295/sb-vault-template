import { scanVault, toReportFindings } from '../lib/secrets.js';

export const id = 'secret-scan';

/**
 * No raw source or compiled note holds a secret. Matches are reported by file,
 * line and pattern name only; the value never appears. Quarantined material
 * (`50-ops/quarantine/`) is outside the scan on purpose.
 * @param {{ vault: string }} ctx
 * @returns {Promise<import('../lib/report.js').Finding[]>}
 */
export async function run({ vault }) {
  return toReportFindings(await scanVault(vault));
}
