/**
 * The `open-second-brain` entry: DETECT-ONLY. It is discovered like an adapter and takes part in
 * `--from auto`, but it has no `plan`: when it wins detection the engine reports "no adapter yet" and
 * `import --apply` refuses unless `--from generic` is given (ADR 0011; research note
 * `other-frameworks-vault-formats.md`, section 1.3).
 *
 * Detection (confidence 0 to 1, capped at 0.98):
 *
 * - `Brain/_brain.yaml`: 0.6 (the framework's own marker);
 * - `Brain/_BRAIN.md` or `Brain/active.md`: 0.1; files under `.open-second-brain/`: 0.15;
 * - a Markdown file whose frontmatter has `kind: brain-signal`, `brain-preference` or `brain-log`: 0.3
 *   (the files are the evidence even where the marker file is gone).
 *
 * Why `--apply` is refused: the `Brain/` tree is agent-owned machine state that an agent keeps
 * writing, so a copy taken while it runs is stale at once. Freeze it first (stop the agent, or move
 * the store out of the vault with `o2b brain migrate-store`), then import with `--from generic`.
 */
import { finalConfidence, sampleHeads } from '../detect-kit.js';

export const id = 'open-second-brain';
export const summary = 'open-second-brain: Brain/_brain.yaml and kind: brain-signal files (detect only)';
export const detectOnly = true;
export const applyRefusal =
  'its Brain/ folder is agent-owned machine state that an agent keeps writing, so freeze it first (stop the agent that writes it, or move the store out of the vault), then run again with --from generic';

const KIND = /^kind:\s*["']?brain-(?:signal|preference|log)["']?\s*$/m;

/**
 * @param {string} root
 * @param {{ files: string[] }} context
 * @returns {Promise<{ confidence: number, evidence: string[] }>}
 */
export async function detect(root, { files }) {
  /** @type {string[]} */
  const evidence = [];
  let confidence = 0;
  if (files.includes('Brain/_brain.yaml')) {
    confidence += 0.6;
    evidence.push('Brain/_brain.yaml');
  }
  if (files.includes('Brain/_BRAIN.md') || files.includes('Brain/active.md')) {
    confidence += 0.1;
    evidence.push('Brain/_BRAIN.md or Brain/active.md');
  }
  if (files.some((f) => f.startsWith('.open-second-brain/'))) {
    confidence += 0.15;
    evidence.push('.open-second-brain/ state');
  }
  const heads = await sampleHeads(root, files);
  const kinds = heads.filter((h) => KIND.test(h)).length;
  if (kinds > 0) {
    confidence += 0.3;
    evidence.push(`${kinds} file(s) with kind: brain-signal, brain-preference or brain-log`);
  }
  return { confidence: finalConfidence(confidence), evidence: evidence.length > 0 ? evidence : ['no open-second-brain marks'] };
}
