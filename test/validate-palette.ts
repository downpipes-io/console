// Validate the command-palette actionRoute routing contract.
// Run with: node test/validate-palette.ts
//
// Coverage:
//   actionRoute correctness (regression + full contract):
//     - "Configure alert webhook" (settings.alert-webhook) routes to /settings, NOT /
//     - "View provenance" (licence.view-provenance) routes to /licence, NOT /
//     - every action target that is NOT legitimately Overview routes to a non-"/" route
//     - all previously-correct mappings remain unchanged
//     - the two overview targets (overview.refresh, overview.drill-fleet) legitimately route to /
//     - an unknown target falls through to / (documented default)
//
// Note: command-palette.ts imports DOM modules (lib/dom.ts, components/dialog.ts etc.)
// but none of them execute DOM calls at the module level, so the import succeeds in
// Node.js and actionRoute (a pure string->string function) is callable without a DOM.

import { actionRoute, resolveEntityGroups, type EntityData } from "../src/screens/command-palette.ts";
import type { Caller } from "../src/api.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq(label: string, got: string, want: string): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// CON-H9 regression: the two previously-misrouted targets.
// ---------------------------------------------------------------------------
console.log("\n-- regression: misrouted palette actions --");

eq(
  "settings.alert-webhook routes to /settings (not /)",
  actionRoute("settings.alert-webhook"),
  "/settings",
);
ok(
  "settings.alert-webhook does NOT route to / (Overview)",
  actionRoute("settings.alert-webhook") !== "/",
);

eq(
  "licence.view-provenance routes to /licence (not /)",
  actionRoute("licence.view-provenance"),
  "/licence",
);
ok(
  "licence.view-provenance does NOT route to / (Overview)",
  actionRoute("licence.view-provenance") !== "/",
);

// ---------------------------------------------------------------------------
// Full actionRoute contract: all known targets.
// ---------------------------------------------------------------------------
console.log("\n-- actionRoute: all known targets --");

// Targets that were already correct before CON-H9.
eq("keys.recovery-sheet routes to /keys", actionRoute("keys.recovery-sheet"), "/keys");
eq("access.verify routes to /access", actionRoute("access.verify"), "/access");
eq("licence.check-updates routes to /licence", actionRoute("licence.check-updates"), "/licence");
eq("audit.export routes to /access/audit", actionRoute("audit.export"), "/access/audit");
eq("auth.sign-out routes to /settings", actionRoute("auth.sign-out"), "/settings");

// Targets that legitimately route to Overview (the operator is already on the
// correct screen for these; routing to / is intentional).
eq("overview.refresh legitimately routes to /", actionRoute("overview.refresh"), "/");
eq("overview.drill-fleet legitimately routes to /", actionRoute("overview.drill-fleet"), "/");

// Unknown target falls through to the documented default.
eq("unknown target falls through to /", actionRoute("does.not.exist"), "/");

// ---------------------------------------------------------------------------
// Exhaustive non-Overview assertion: every target that is NOT legitimately
// Overview must route somewhere other than /.
//
// This table is the single source of truth that ties every registered action
// target (from shell/registry.ts COMMANDS + all screen descriptors) to its
// expected owning screen. Extending the palette with a new action target MUST
// add a row here; failing that, the test catches the fall-through silently
// routing to Overview.
// ---------------------------------------------------------------------------
console.log("\n-- exhaustive: non-Overview targets must not route to / --");

// Targets that must route to a non-Overview screen.
const nonOverviewTargets: Array<{ target: string; wantRoute: string }> = [
  // From shell/registry.ts COMMANDS.
  { target: "keys.recovery-sheet",   wantRoute: "/keys"         },
  { target: "access.verify",         wantRoute: "/access"       },
  { target: "licence.check-updates", wantRoute: "/licence"      },
  { target: "audit.export",          wantRoute: "/access/audit" },
  { target: "auth.sign-out",         wantRoute: "/settings"     },
  // From screen action descriptors (not in COMMANDS baseline).
  { target: "settings.alert-webhook",  wantRoute: "/settings" },
  { target: "licence.view-provenance", wantRoute: "/licence"  },
];

for (const { target, wantRoute } of nonOverviewTargets) {
  const got = actionRoute(target);
  ok(`${target} does not fall through to /`, got !== "/");
  eq(`${target} routes to ${wantRoute}`, got, wantRoute);
}

// Targets that legitimately resolve to Overview -- these must remain /.
const overviewTargets = ["overview.refresh", "overview.drill-fleet"];
console.log("\n-- exhaustive: Overview targets must route to / --");
for (const target of overviewTargets) {
  eq(`${target} legitimately routes to /`, actionRoute(target), "/");
}

// ---------------------------------------------------------------------------
// No duplicate "Open recovery sheet" commands.
//
// shell/registry.ts carries "open-recovery-sheet" (target: keys.recovery-sheet).
// keys.ts previously also declared "keys.recovery-sheet" with the same target
// under a different id, so both survived the id-based dedup and both were inert
// in the default dispatch. The keys.ts entry was removed; verify the registry
// still maps the target correctly and that the route is /keys.
// ---------------------------------------------------------------------------
console.log("\n-- no duplicate recovery-sheet commands --");

import { COMMANDS } from "../src/shell/registry.ts";

// The canonical registry entry must still be present.
const recoveryEntries = COMMANDS.filter((c) => c.target === "keys.recovery-sheet");
ok("exactly one COMMANDS entry targets keys.recovery-sheet", recoveryEntries.length === 1);
ok("the single entry id is 'open-recovery-sheet'", recoveryEntries[0]?.id === "open-recovery-sheet");
ok("keys.recovery-sheet still routes to /keys via actionRoute", actionRoute("keys.recovery-sheet") === "/keys");

// Negative control: no other id in COMMANDS shares the keys.recovery-sheet target.
const others = COMMANDS.filter((c) => c.target === "keys.recovery-sheet" && c.id !== "open-recovery-sheet");
ok("no other COMMANDS entry with the same target exists", others.length === 0);

// ---------------------------------------------------------------------------
// A resolved RUN entity routes to /runs/:downpipeId/:index with no preselection
// query string.
//
// The comment in entities.ts previously claimed the run was "preselected by id" in
// the route, which was false: the run route is /runs/:downpipeId/:index with no
// ?run= suffix. Rather than re-asserting a self-built string (tautological), we drive
// the real resolveEntityGroups() over a run fixture and assert the route it builds.
// ---------------------------------------------------------------------------
console.log("\n-- resolved run route is /runs/:downpipeId/:index --");

const paletteOwner: Caller = { method: "access", email: "o@x", role: "owner", groups: [], isOnlyOwner: false };
const runEntityData: EntityData = {
  downpipes: null,
  runs: [{ runId: "run-2026-aaa", index: 7, downpipeId: "dp-alpha" }],
  destinations: null,
  credentials: null,
  auditHeadSeq: null,
};
const runGroup = resolveEntityGroups(runEntityData, paletteOwner, "run-2026-aaa").find((g) => g.key === "runs");
const runRoute = runGroup?.matches[0]?.route;
ok("a matching run resolves to a run group", runGroup !== undefined && runGroup.matches.length === 1);
ok("resolved run route is /runs/dp-alpha/7", runRoute === "/runs/dp-alpha/7");
ok("resolved run route carries no query string", runRoute !== undefined && !runRoute.includes("?"));
ok("resolved run route carries no ?run= param", runRoute !== undefined && !runRoute.includes("run="));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVALIDATE-PALETTE VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
