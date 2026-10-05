// The customer deploy preflight and the developer chains must not drift apart.
//
// WHY THIS EXISTS. scripts/deploy.sh used to run `npm run validate` and `npm run lint` as its preflight.
// Those are the developer's chains: several members compare this repo with the engine, docs,
// and other sibling checkouts beside it, and test/validate-client-diag.ts refuses when the engine
// beside it is behind its own origin/main. A customer following /deploy checks out a release tag in
// engine and in console, and a release tag is behind main as soon as anything lands after it, so every
// such deploy stopped with CANNOT CHECK. The preflight now runs validate:customer:chain instead: the
// members that guard the customer's keys in the browser, classified member by member in
// scripts/customer-preflight.json.
//
// WHAT THIS GRADES, so the split cannot rot:
//   1. every member of validate:chain and of the validate script's tail is classified in the manifest,
//      every lint:chain member the manifest keeps is in lint:chain, and the rest of lint:chain is left out
//      under the manifest's lintChainRule. The manifest names no member that still exists outside those
//      chains; an entry whose script or file is absent from this tree (a public export drops some
//      developer gates) is noted, not failed;
//   2. every left-out member carries a category with a one-line reason;
//   3. validate:customer:chain is exactly the kept members, in chain order, and validate:customer runs
//      it with a floor equal to its length;
//   4. deploy.sh builds, then runs the customer preflight (dependencies, typecheck, validate:customer),
//      does not run the developer chains, and prints the duration the manifest records.
//
// Run: node test/validate-customer-preflight.ts

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictReached } from "./lib/verdict-guard.ts";

let failures = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!cond) failures++;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
type Manifest = {
  dropReasons: Record<string, string>;
  lintChainRule: string;
  measured: { seconds: number; text: string } | null;
  members: Record<string, string>;
};
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts", "customer-preflight.json"), "utf8")) as Manifest;
const split = (s: string | undefined): string[] => (s ?? "").split("&&").map((m) => m.trim()).filter(Boolean);

const vchain = split(pkg.scripts["validate:chain"]);
const vtail = split(pkg.scripts.validate).slice(1);
const lchain = split(pkg.scripts["lint:chain"]);
const validateSide = [...vchain, ...vtail];
const all = [...validateSide, ...lchain];
// present says whether a member's target exists in THIS tree: its npm script, or the file node runs.
function present(member: string): boolean {
  const script = member.match(/^npm run (\S+)$/)?.[1];
  if (script !== undefined) return script in pkg.scripts;
  const file = member.match(/^node (\S+)/)?.[1];
  return file !== undefined && existsSync(join(ROOT, file));
}
const custChain = split(pkg.scripts["validate:customer:chain"]);
const classified = Object.keys(manifest.members);

console.log("-- every member of the developer chains is classified, and nothing else is --");
{
  const unclassified = validateSide.filter((m) => !(m in manifest.members));
  const outside = classified.filter((m) => !all.includes(m));
  const stale = outside.filter(present);
  for (const m of outside.filter((x) => !present(x))) console.log(`  note ${m} is classified but absent from this tree, so it is not graded here`);
  ok(`the developer chains have members to classify (${all.length})`, vchain.length > 100 && lchain.length > 10);
  ok("every member of validate:chain and validate is classified", unclassified.length === 0, unclassified.join(", "));
  const lintKept = classified.filter((m) => manifest.members[m] === "keep" && !validateSide.includes(m));
  const lintKeptMissing = lintKept.filter((m) => !lchain.includes(m) && present(m));
  ok("every lint member the manifest keeps is a member of lint:chain", lintKeptMissing.length === 0, lintKeptMissing.join(", "));
  const lintNamedDropped = classified.filter((m) => lchain.includes(m) && manifest.members[m] !== "keep");
  ok("lint:chain members are named only when kept; the rest fall under lintChainRule", lintNamedDropped.length === 0, lintNamedDropped.join(", "));
  ok("lintChainRule is one non-empty line", typeof manifest.lintChainRule === "string" && manifest.lintChainRule.trim() !== "" && !manifest.lintChainRule.includes("\n"));
  ok("the manifest names no member that still exists outside those chains", stale.length === 0, stale.join(", "));
}

console.log("\n-- every left-out member has a category with a one-line reason --");
{
  const cats = new Set(Object.values(manifest.members));
  const noReason = [...cats].filter((c) => c !== "keep" && !(c in manifest.dropReasons));
  ok("every category a member uses has a reason", noReason.length === 0, noReason.join(", "));
  const badReason = Object.entries(manifest.dropReasons).filter(([, r]) => typeof r !== "string" || r.trim() === "" || r.includes("\n"));
  ok("every reason is one non-empty line", badReason.length === 0, badReason.map(([c]) => c).join(", "));
  const unused = Object.keys(manifest.dropReasons).filter((c) => !cats.has(c));
  ok("no reason is left over from a category nothing uses", unused.length === 0, unused.join(", "));
}

console.log("\n-- validate:customer:chain is exactly the kept members, in order --");
{
  const kept = all.filter((m) => manifest.members[m] === "keep");
  ok(`the preflight keeps members (${kept.length})`, kept.length > 0);
  ok("validate:customer:chain equals the kept members in chain order", JSON.stringify(custChain) === JSON.stringify(kept), `chain has ${custChain.length}, manifest keeps ${kept.length}`);
  ok("validate:customer runs that chain with a floor equal to its length", pkg.scripts["validate:customer"] === `node scripts/run-gate-chain.mjs validate:customer:chain ${custChain.length}`, pkg.scripts["validate:customer"]);
  ok("validate still runs the whole developer chain with a floor equal to its length", (pkg.scripts.validate ?? "").startsWith(`node scripts/run-gate-chain.mjs validate:chain ${vchain.length} `), pkg.scripts.validate);
}

console.log("\n-- deploy.sh runs the customer preflight, not the developer chains --");
{
  const deploy = readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8");
  const code = deploy.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const steps = [...code.matchAll(/^\s*(npm run [A-Za-z0-9:_-]+|npx wrangler deploy)\b/gm)].map((m) => m[1]);
  const want = ["npm run build", "npm run lint:deps-installed", "npm run typecheck", "npm run validate:customer", "npx wrangler deploy"];
  ok("deploy.sh builds, runs dependencies, typecheck and validate:customer, then deploys", JSON.stringify(steps) === JSON.stringify(want), JSON.stringify(steps));
  ok("deploy.sh does not run the developer chains (npm run validate, npm run lint)", !/^\s*npm run (validate|lint)\s*$/m.test(code));
  ok("deploy.sh stops on the first failure (set -e)", /^set -e$/m.test(deploy));
  ok("the manifest records a measured duration", manifest.measured !== null && manifest.measured.seconds > 0 && manifest.measured.text !== "");
  if (manifest.measured !== null) {
    ok("deploy.sh prints the measured duration the manifest records", deploy.includes(manifest.measured.text), manifest.measured.text);
  }
  ok("deploy.sh carries no unfilled duration placeholder", !deploy.includes("MEASURED_DURATION"));
}

verdictReached(failures);
if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nCUSTOMER PREFLIGHT AND DEVELOPER CHAINS AGREE");
