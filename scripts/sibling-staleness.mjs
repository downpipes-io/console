// HOW OLD IS THE SIBLING THIS GATE IS ABOUT TO GRADE, as a number every caller prints and a refusal
// every caller shares.
//
// WHY IT IS ONE FILE. scripts/workspace-root.mjs exists because three copies of one resolver were
// rewritten together and all three lost the same guard in that edit, so triplication cost a guard rather
// than buying redundancy. This module guards against the same shape one level along: a staleness refusal
// duplicated across a pair of gates reading the same sibling for the same catalogue can end up on only one
// side of the pair, so one gate refuses on a stale checkout while the other reports a clean result over
// the same stale data. Copying the check a second time is how that happens again, so it lives once here
// instead.
//
// NO FETCH. A local gate that reaches the network answers differently depending on who ran it last, and
// makes a check that should work on a plane depend on one that does not. A checkout whose origin/main ref
// is unknown is reported as unknown and does not fail: nothing can be concluded from it either way, and an
// unknown that failed closed would refuse every fresh clone.
//
// THE REFUSAL IS PER-GATE BY NAME. Each caller passes its own environment variable, because console's
// convention is a named escape hatch per gate rather than one switch that turns several off at once.
//
import { execFileSync } from "node:child_process";

/**
 * Both nullable fields are REQUIRED and may hold undefined, rather than optional. This repo builds under
 * `exactOptionalPropertyTypes`, where an optional property may be absent but may not be explicitly
 * undefined, and every caller here wants the field present with an undefined value so that "unreadable" is
 * a state a reader can see rather than a key that quietly is not there.
 *
 * @typedef {object} Staleness
 * @property {boolean} known whether origin/main could be resolved at all
 * @property {number | undefined} behind commits from HEAD to origin/main, undefined when not known
 * @property {string | undefined} head the checkout's HEAD, short, undefined when unreadable
 */

/**
 * How far `repoDir` is behind its own `origin/main`.
 *
 * @param {string} repoDir
 * @returns {Staleness}
 */
export function staleness(repoDir) {
  /** @type {string | undefined} */
  let head;
  try {
    head = execFileSync("git", ["-C", repoDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    head = undefined;
  }
  try {
    const n = Number(execFileSync("git", ["-C", repoDir, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isNaN(n) ? { known: false, behind: undefined, head } : { known: true, behind: n, head };
  } catch {
    return { known: false, behind: undefined, head };
  }
}

/**
 * The one-line statement of which tree was graded, printed on every run whatever the verdict. A count
 * reported against an unnamed tree reads as a fact about the sibling and is a fact about whatever was on
 * disk, which is the whole defect this module was extracted for.
 *
 * @param {string} tag the gate's own bracketed prefix, so the line is greppable per gate
 * @param {string} label the sibling's name
 * @param {string} repoDir
 * @param {Staleness} [s] a measurement already taken, to avoid running git twice
 * @returns {string}
 */
export function treeLine(tag, label, repoDir, s) {
  const m = s ?? staleness(repoDir);
  const head = m.head === undefined ? "HEAD unreadable" : `HEAD ${m.head}`;
  const lag = m.known ? `${m.behind} commit(s) behind its own origin/main` : "lag UNKNOWN, this checkout has no readable origin/main so nothing can be concluded from it";
  return `${tag} tree graded: ${label} at ${repoDir}, ${head}, ${lag}`;
}

/**
 * Refuse, with exit 2, when the sibling is behind its own `origin/main`.
 *
 * Exit 2 is "could not check", kept distinct from each caller's exit 1 for real drift, matching
 * internal-docs/FIELD-CATALOGUE/verify-citations.mjs.
 *
 * @param {object} opts
 * @param {string} opts.repoDir
 * @param {string} opts.label
 * @param {string} opts.tag the gate's own bracketed prefix
 * @param {string} opts.allowEnv the environment variable that lets a deliberate old tree through
 * @param {string[]} opts.why lines saying what this gate's numbers would mean against an old tree
 * @param {Staleness} [opts.measured]
 */
export function refuseIfStale({ repoDir, label, tag, allowEnv, why, measured }) {
  if (process.env[allowEnv] === "1") return;
  const s = measured ?? staleness(repoDir);
  if (!s.known || s.behind === 0) return;
  console.error(`\n${tag} FATAL: ${label} at ${repoDir} is ${s.behind} commit(s) behind its own origin/main.`);
  for (const line of why) console.error(`  ${line}`);
  console.error(`  Update the checkout, or set ${allowEnv}=1 if an old tree is deliberate.\n`);
  process.exit(2);
}
