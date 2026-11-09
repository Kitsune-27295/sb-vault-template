/**
 * The ref guard of the publish workflow (ADR 0012): decides which refs of the template repository a
 * publication may write. The default mode writes the dedicated branch and `sbk-v<version>` tags only.
 * Promotion (a fast-forward of the target's default branch) needs the flag AND the exact phrase.
 * `stable`, every `v*` tag and every other tag are refused even then. The tag `stable` is written only in
 * the separate move mode (ADR 0013): its own phrase, `stable` as the only ref, and a target commit that
 * the caller verified as the commit of an existing `sbk-v*` tag whose tree equals the built tree. Pure logic, no I/O.
 */
import { finding } from './report.js';

/** The phrase the curator types into `confirm_promote` to unlock promotion. */
export const PROMOTE_PHRASE = 'promote the template to the default branch';

/** The phrase the curator types into `confirm_stable` to unlock the move of `stable` (ADR 0013). */
export const STABLE_PHRASE = 'move stable to the verified bridge release';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Branch names that are never written without promotion, whatever the target says its default is. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'head']);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PUBLISH_TAG = /^sbk-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} ref a branch name, `refs/heads/<name>` or `refs/tags/<name>`
 * @returns {{ kind: 'branch' | 'tag' | 'other', name: string }}
 */
function parseRef(ref) {
  if (ref.startsWith('refs/heads/')) return { kind: 'branch', name: ref.slice('refs/heads/'.length) };
  if (ref.startsWith('refs/tags/')) return { kind: 'tag', name: ref.slice('refs/tags/'.length) };
  if (ref.startsWith('refs/')) return { kind: 'other', name: ref };
  return { kind: 'branch', name: ref };
}

/** @param {string} name @returns {boolean} whether a ref name is plain enough to reason about */
function isSafeName(name) {
  return SAFE_NAME.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.');
}

/**
 * @param {string[]} refs destination refs of the pushes
 * @param {{ defaultBranch: string, promote: boolean, confirm: string | undefined, targetBranch?: string }} options
 *   `targetBranch` names the dedicated branch of the publication: it is refused when it is the target's default
 *   branch (or main, master, HEAD, stable), in every case, promotion included, because the dedicated branch is
 *   pushed with a lease and the default branch only ever by a fast-forward promotion
 * @returns {import('./report.js').Finding[]} one error per refused ref; empty when every ref may be written
 */
export function guardRefs(refs, { defaultBranch, promote, confirm, targetBranch, moveStable = false, confirmStable, stableTo, releaseCommits = [] }) {
  /** @type {import('./report.js').Finding[]} */
  const findings = [];
  // The stable move is its own mode: it writes the tag `stable` and nothing else, and never unlocks promotion.
  const unlocked = !moveStable && promote && confirm === PROMOTE_PHRASE;
  const deflt = defaultBranch.toLowerCase();
  /** @param {string} ref @param {string} rule @param {string} message */
  const refuse = (ref, rule, message) => findings.push(finding(ref, rule, 'error', message));

  if (targetBranch !== undefined) {
    const { name } = parseRef(targetBranch);
    const lower = name.toLowerCase();
    if (lower === deflt || lower === 'stable' || PROTECTED_BRANCHES.has(lower)) {
      refuse(`refs/heads/${name}`, 'target-branch-is-default', 'the dedicated branch must never be the default branch of the target (nor main, master, HEAD or stable), with or without promotion');
    }
  }

  for (const ref of refs) {
    const { kind, name } = parseRef(ref);
    if (kind === 'other') {
      refuse(ref, 'ref-not-allowed', 'only branches and sbk-v tags may be written');
      continue;
    }
    if (!isSafeName(name)) {
      refuse(ref, 'ref-invalid', 'is not a plain ref name (no force marker, deletion, refspec, empty or odd characters)');
      continue;
    }
    const lower = name.toLowerCase();
    if (lower.startsWith('refs/')) {
      refuse(ref, 'ref-invalid', 'a name that starts with refs/ would hide the real destination');
      continue;
    }
    if (moveStable && kind === 'tag' && ref === 'refs/tags/stable') {
      if (confirmStable !== STABLE_PHRASE) {
        refuse(ref, 'stable-not-confirmed', `moving stable needs the confirmation phrase exactly: "${STABLE_PHRASE}"`);
      } else if (!stableTo || !FULL_SHA.test(stableTo) || !releaseCommits.includes(stableTo)) {
        refuse(ref, 'stable-commit-not-verified', 'stable moves only to a full commit id that is the target of an existing sbk-v tag whose tree equals the built tree');
      }
      continue;
    }
    if (kind === 'tag') {
      if (lower === 'stable') refuse(ref, 'protected-tag-name', 'the moving tag "stable" is never written by the publication');
      else if (lower.startsWith('v')) refuse(ref, 'protected-tag-pattern', 'tags named v* belong to the old sb tool and are never written');
      else if (!PUBLISH_TAG.test(name)) refuse(ref, 'ref-not-allowed', 'only tags named sbk-v<major>.<minor>.<patch> may be written');
      else if (moveStable) refuse(ref, 'move-stable-only-stable', 'the stable move writes the tag "stable" and no other ref');
      continue;
    }
    if (lower === 'stable') refuse(ref, 'protected-default-branch', 'the ref "stable" is never written by the publication');
    else if (lower === deflt || PROTECTED_BRANCHES.has(lower)) {
      if (!unlocked) {
        const why = promote ? 'promote-not-confirmed' : 'protected-default-branch';
        refuse(ref, why, promote ? `promotion needs the confirmation phrase exactly: "${PROMOTE_PHRASE}"` : 'the default branch is only written by an approved promotion (promote and the confirmation phrase)');
      } else if (lower !== deflt) {
        refuse(ref, 'protected-default-branch', 'promotion unlocks only the default branch of the target');
      }
    } else if (moveStable) refuse(ref, 'move-stable-only-stable', 'the stable move writes the tag "stable" and no other ref');
  }
  return findings;
}
