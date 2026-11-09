/**
 * The `template-framework` entry: DETECT-ONLY, the fanfiction vault template (research note
 * `other-frameworks-vault-formats.md`, section 1.6). Discovered like an adapter and part of
 * `--from auto`, but with no `plan`: when it wins detection the engine reports "no adapter yet" and
 * `import --apply` refuses unless `--from generic` is given (ADR 0011).
 *
 * Detection (confidence 0 to 1, capped at 0.98):
 *
 * - `vault.yaml` at the root: 0.3;
 * - numbered domain folders (`00_Cockpit`, `30_Canon`, `40_Bible`, ...): 0.3 when at least three of the
 *   known ones are present, so one stray `30_Notes` folder is not taken for the template;
 * - `30_Canon/<franchise>/Sources/` with `.json` sidecars: 0.2;
 * - a note whose `uid` (or `id`, the key its module templates use) starts with a listed prefix
 *   such as `CAN-`, `SRC-`, `CHR-`: 0.2.
 *
 * Why `--apply` is refused: the vault mixes frozen captures, append-only ledgers and several
 * franchises that the generic adapter keeps verbatim but cannot interpret, so the choice to import
 * it that way must be explicit.
 */
import { finalConfidence, sampleHeads } from '../detect-kit.js';

export const id = 'template-framework';
export const summary = 'fanfiction template-framework: vault.yaml, numbered domains with 30_Canon/ sidecars, uid prefixes (detect only)';
export const detectOnly = true;
export const applyRefusal =
  'it mixes frozen captures, append-only ledgers and several franchises that only the generic adapter can carry across (verbatim, uninterpreted), so choose that explicitly with --from generic';

const DOMAINS = ['00_Cockpit', '10_Context', '11_Memory', '20_Specification', '21_Templates', '22_Guidelines', '23_Examples', '30_Canon', '31_Research', '40_Bible', '50_Manuscript', '51_Craft', '60_Ledgers', '61_Sandbox', '90_System'];
const UID_PREFIXES = ['CAN', 'SRC', 'DIV', 'CHR', 'FAC', 'LOC', 'ITM', 'PWR', 'TEC', 'REL', 'TML', 'ARC', 'TRM', 'LDG', 'SBX', 'CRT', 'AUD', 'RES', 'CTX', 'MEM', 'MSP', 'SYS', 'TPL'];
const UID = new RegExp(`^(?:uid|id):\\s*["']?(?:${UID_PREFIXES.join('|')})-`, 'm');

/**
 * @param {string} root
 * @param {{ files: string[] }} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(root, { files }) {
  /** @type {string[]} */
  const evidence = [];
  let confidence = 0;
  if (files.includes('vault.yaml')) {
    confidence += 0.3;
    evidence.push('vault.yaml');
  }
  const domains = DOMAINS.filter((d) => files.some((f) => f.startsWith(`${d}/`)));
  if (domains.length >= 3) {
    confidence += 0.3;
    evidence.push(`numbered domains: ${domains.join(', ')}`);
  }
  if (files.some((f) => /^30_Canon\/[^/]+\/Sources\/[^/]+\.json$/.test(f))) {
    confidence += 0.2;
    evidence.push('30_Canon/<franchise>/Sources/ with .json sidecars');
  }
  const heads = await sampleHeads(root, files);
  const uids = heads.filter((h) => UID.test(h)).length;
  if (uids > 0) {
    confidence += 0.2;
    evidence.push(`${uids} note(s) with a listed uid prefix`);
  }
  return { confidence: finalConfidence(confidence), evidence: evidence.length > 0 ? evidence : ['no template-framework marks'] };
}
