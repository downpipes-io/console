// Validator reachability gate.
//
// A test file that no npm script reaches is not coverage, it is a file: it passes when run by hand, is
// counted when someone lists the suite, and gates nothing. The failure is silent by construction, because a
// validator that never runs never fails.
//
// This gate lists every test/validate-*.ts and fails on any that no chain can reach. Reachability is
// TRANSITIVE: validate-api.ts is named by the chain and imports validate-api-pure.ts and
// validate-api-shared.ts, so those are reached too. Only genuinely orphaned files fail.
//
// Reachability is measured from the GATING chains only, not from any npm script. That distinction is
// the whole point: a validator can be reachable from a narrow target no CI job invokes, so "some script
// mentions it" can be true while "anything gates it" is false. GATING_ENTRYPOINTS below is the set a CI job
// actually runs; a validator reachable only from somewhere else is an orphan.
//
// Usage:
//   node scripts/validator-reachability-gate.mjs            report, exit 0
//   node scripts/validator-reachability-gate.mjs --enforce   exit 1 on any orphan

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TEST_DIR = join(ROOT, "test");
const ENFORCE = process.argv.includes("--enforce");

// Files that are deliberately not in any chain, each with the reason. An entry here is a decision on
// the record, which is the point: the alternative is an orphan nobody ever notices.
const EXEMPT = new Map([
  ["validate-visible-surface-counts.ts", "reachable only via validate:workspace's chain (validate:visible-counts), dropped above"],
  ["validate-update-outcome-vocabulary.ts", "reachable only via validate:workspace's chain (validate:update-outcome-vocabulary), dropped above"],
  ["validate-source-type-parity.ts", "reachable only via validate:workspace's chain (validate:source-type-parity), dropped above"],
  ["validate-restore-reason-vocabulary.ts", "reachable only via validate:workspace's chain (validate:restore-reason-vocabulary), dropped above"],
  ["validate-restore-guards-are-load-bearing.ts", "this IS validate:restore-guards' own entry point, dropped above (needs the engine sibling)"],
  ["validate-provider-mirrors.ts", "reachable only via validate:workspace's chain, dropped above"],
  ["validate-metadata-shed-vocabulary.ts", "reachable only via validate:workspace's chain (validate:metadata-shed-vocabulary), dropped above"],
  ["validate-idp-presets-drift.ts", "reachable only via validate:workspace's chain, dropped above"],
  ["validate-cf-surface-split-parity.ts", "reachable only via validate:workspace's chain (validate:cf-surface-split), dropped above"],
  ["validate-audit-capacity-screen.ts", "reachable only via validate:workspace's chain, dropped above; not orphaned in the private repo"],
  // (empty today; add "validate-x.ts" -> "why it is not chained" as needed)
]);

// The scripts a CI job actually runs. Keep this in step with .github/workflows/ci.yml.
// validate:restore-guards runs in CI as its own step (see .github/workflows/ci.yml). Deliberately NOT
// inside `validate`: it runs a full gate per guard, so chaining it would multiply every validate run.
// Exported tree only: validate:workspace, validate:restore-guards removed here -- validate:workspace runs only via a cross-repo CI job (workspace-token, checks out engine as a sibling) that workflow-transform.mjs correctly drops from a standalone export; validate:restore-guards' own CI step was likewise cross-repo-only. Keeping them in GATING_ENTRYPOINTS would fail reachability against a workflow this tree no longer ships.
const GATING_ENTRYPOINTS = ["validate", "lint", "coverage"];

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

// Expand `npm run x` references transitively so a validator inside a sub-script still counts, while a
// script no gating entrypoint reaches does not.
//
// THE CHAIN RUNNER IS FOLLOWED TOO, and it has to be rather than merely ought to be. Three of the five
// gating entrypoints hold their members indirectly: `validate` is
// `node scripts/run-gate-chain.mjs validate:chain 175`, with its members inside validate:chain, and lint
// and validate:workspace take the same shape. Following only `npm run` would make every validator in all
// three read as an orphan, which would be wrong about membership rather than merely silent about ordering.
// The second matcher is what keeps the claim this gate makes true.
function expand(name, seen = new Set()) {
  if (seen.has(name) || scripts[name] === undefined) return "";
  seen.add(name);
  const body = String(scripts[name]);
  let out = body;
  for (const m of body.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) out += ` ${expand(m[1], seen)}`;
  for (const m of body.matchAll(/run-gate-chain\.mjs ([A-Za-z0-9:_-]+)/g)) out += ` ${expand(m[1], seen)}`;
  return out;
}
const allScriptText = GATING_ENTRYPOINTS.map((e) => expand(e)).join(" && ");

// ANTI-VACUITY. Everything below is computed from this list, and the exit code is the orphan count alone, so
// an empty list reports "every validator is reachable" and exits 0. That is the exact failure this gate was
// written to catch, one level up: a check that cannot fail on an empty input is not a check. A missing test
// directory and a directory whose contents no longer match the naming convention both land here.
if (!existsSync(TEST_DIR)) {
  console.error(`[validator-reachability] FAIL: ${TEST_DIR} does not exist, so there is nothing to check.`);
  process.exit(1);
}
const validators = readdirSync(TEST_DIR)
  .filter((f) => f.startsWith("validate-") && f.endsWith(".ts"))
  .sort();
if (validators.length === 0) {
  console.error(`[validator-reachability] FAIL: no test/validate-*.ts found under ${TEST_DIR}.`);
  console.error("Either the validators are gone or the naming convention changed; a pass here would prove nothing.");
  process.exit(1);
}

// Seed: every validator named directly in any npm script.
const reached = new Set(validators.filter((f) => allScriptText.includes(f)));

// blankComments replaces every comment byte with a space, keeping newlines so nothing else shifts.
//
// WHY THIS IS HERE, because without it this gate lies in the one direction it exists to prevent. If a
// COMMENTED-OUT import counted as a real dependency, then leaving
//   // await import("./validate-thing.ts"); // temporarily disabled while chasing a flake
// behind in a wired validator would mark validate-thing.ts REACHABLE, so an orphan that runs nowhere would
// report as wired: exactly the "a gate that cannot see the gap reads as a pass" failure this gate exists to
// avoid.
//
// Quote-aware, because a `//` inside a string is not a comment.
const blankComments = (src) => {
  const out = [...src];
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    i++;
  }
  return out.join("");
};

// Transitive closure over relative imports, so a helper pulled in by a chained validator counts.
const importsOf = (file) => {
  let src = "";
  try {
    src = blankComments(readFileSync(join(TEST_DIR, file), "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const m of src.matchAll(/from\s+"\.\/([A-Za-z0-9_.-]+\.ts)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*"\.\/([A-Za-z0-9_.-]+\.ts)"\s*\)/g)) out.push(m[1]);
  return out;
};

let grew = true;
while (grew) {
  grew = false;
  for (const f of [...reached]) {
    for (const dep of importsOf(f)) {
      if (validators.includes(dep) && !reached.has(dep)) {
        reached.add(dep);
        grew = true;
      }
    }
  }
}

// GATING_ENTRYPOINTS is a CLAIM about CI, and this section is what checks it. Every validator in this repo
// is reachable from that list, which is only worth anything if CI actually runs each entry. If an entry is
// renamed, or a CI step is dropped, the list can quietly describe a pipeline that no longer exists, and
// every validator behind it is orphaned without a single gate going red.
//
// That risk is not hypothetical: a gate can exist, pass locally, and be invoked by no CI job at all, which
// is the same blind spot mirrored. This closes the loop for the entries this file depends on.
const wfDir = join(HERE, "..", ".github/workflows");
if (existsSync(wfDir)) {
  const ci = readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(wfDir, f), "utf8"))
    .join("\n");
  // escapeForRegex escapes every regex metacharacter in an entrypoint name before it is built into a
  // pattern. Without it, an unescaped `.` matches ANY character, so an entrypoint written `validate.workspace`
  // would match a CI line for `validate:workspace` and report a script CI does not run as run.
  const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unrun = GATING_ENTRYPOINTS.filter((e) => !new RegExp(`npm run ${escapeForRegex(e)}(\\s|"|'|$)`, "m").test(ci));
  if (unrun.length > 0) {
    console.error("");
    console.error("GATING_ENTRYPOINTS names scripts that NO CI workflow runs, so the validators behind them gate nothing:");
    for (const e of unrun) console.error(`  ${e}`);
    console.error("Either add the CI step, or remove the entry and accept those validators are orphaned.");
    process.exit(1);
  }
  console.log(`[validator-reachability] all ${GATING_ENTRYPOINTS.length} gating entrypoints are run by a CI workflow`);
} else {
  // Not a skip that reads as a pass: this repo HAS workflows, so their absence is a broken checkout rather
  // than a repo that never had CI, and the gate says so instead of quietly dropping half of itself.
  console.error("[validator-reachability] FAIL: no .github/workflows here, so the entrypoint-vs-CI check could not run.");
  process.exit(1);
}

const orphans = validators.filter((f) => !reached.has(f) && !EXEMPT.has(f));

console.log(`[validator-reachability] ${validators.length} validators, ${reached.size} reachable from an npm script, ${orphans.length} orphaned, ${EXEMPT.size} exempt`);
if (orphans.length > 0) {
  console.log("\nORPHANED VALIDATORS (no npm script reaches them, directly or by import):");
  for (const f of orphans) console.log(`  test/${f}`);
  console.log("\nWire each into a chain, or add it to EXEMPT in this file with the reason.");
}
if (ENFORCE && orphans.length > 0) {
  console.error(`\n[validator-reachability] FAIL (enforce): ${orphans.length} validator(s) reach no npm script, so they gate nothing.`);
  process.exit(1);
}
console.log(orphans.length === 0 ? "[validator-reachability] OK: every validator is reachable." : "[validator-reachability] report mode: not failing the build.");
