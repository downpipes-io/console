// Validate the global command-palette SEARCH providers (no global search across runs / audit /
// destinations / credentials, before these providers existed). Run with:
//   node test/validate-palette-search.ts
//
// The palette's entity index gained four capability-gated result PROVIDERS on top of the
// pre-existing downpipes-by-name + run-id index, each reusing the SAME fuzzy matcher and
// navigate() route (no parallel search UI). This validator proves, for EACH provider:
//   1. ROUTE: a matching entity resolves to the correct deep-link route
//        - Downpipe name   -> /downpipes/:id
//        - Run id          -> /runs/:downpipeId/:index   (the real run drawer route)
//        - Destination      -> /destinations              (no per-destination deep-link today)
//        - Credential label -> /credentials/:id           (the detail-drawer deep-link)
//        - Audit entry seq  -> /access/audit              (no per-entry deep-link today)
//   2. GATE: the provider is HIDDEN when the caller lacks the capability the owning screen
//      reads, proven via: a null caller hides EVERY provider; a custom role that
//      omits downpipe.read hides downpipes/runs/destinations/credentials; a custom role that
//      omits audit.read hides audit; and the gate predicate and the resolver agree.
//
// resolveEntityGroups / entityProviderEnabled are PURE (DOM-free) exports of
// command-palette.ts, so this runs in Node without a DOM exactly like validate-palette.ts
// (the palette's DOM modules execute nothing at import time).

import {
  resolveEntityGroups,
  entityProviderEnabled,
  type EntityData,
} from "../src/screens/command-palette.ts";
import type { Caller, DownpipeState, DestinationStatus, ExpiryStatus } from "../src/api.ts";
import { type Capability, type CustomRole, ALL_CAPABILITIES } from "../src/lib/identity.ts";

let failures = 0;

function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function eq(label: string, got: unknown, want: unknown): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Fixtures: minimal, redaction-safe entity data + callers.
// ---------------------------------------------------------------------------

// A built-in OWNER holds every capability (downpipe.read + audit.read both in the read floor).
const owner: Caller = { method: "access", email: "o@x", role: "owner", groups: [], isOnlyOwner: false };
// A built-in VIEWER also holds the read floor (downpipe.read + audit.read), so it can search
// every entity (the honest model; these reads are universal to authenticated callers).
const viewer: Caller = { method: "access", email: "v@x", role: "viewer", groups: [], isOnlyOwner: false };

// A custom role is the only way to OMIT a read-floor capability, so it is how we prove a
// provider genuinely disappears when its capability is absent. customRole wins over role.
function callerWithCaps(caps: Capability[]): Caller {
  const role: CustomRole = {
    name: "scoped",
    label: "Scoped",
    capabilities: caps,
    surface: {},
    presentation: "technical",
    landing: "audit",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  // role is the viewer floor; customRole carries the real (restricted) authority.
  return { method: "access", email: "c@x", role: "viewer", groups: [], isOnlyOwner: false, customRole: role };
}

// A downpipe fixture (only the fields the provider reads).
function dp(id: string, name: string, type = "kv"): DownpipeState {
  // Cast through unknown: the provider reads only config.id / config.name / config.source.type.
  return { config: { id, name, source: { type } } } as unknown as DownpipeState;
}

const FIXTURE_DOWNPIPES: DownpipeState[] = [
  dp("dp-alpha", "Alpha backups", "kv"),
  dp("dp-beta", "Beta archive", "r2"),
];

const FIXTURE_RUNS: NonNullable<EntityData["runs"]> = [
  { runId: "run-2026-aaa", index: 7, downpipeId: "dp-alpha" },
  { runId: "run-2026-bbb", index: 3, downpipeId: "dp-beta" },
];

const FIXTURE_DESTINATIONS: DestinationStatus[] = [
  { present: true, id: "dest-1", label: "Sydney cold store", isDefault: true } as DestinationStatus,
  { present: true, id: "dest-2", label: "Frankfurt mirror", isDefault: false } as DestinationStatus,
];

const FIXTURE_CREDENTIALS: ExpiryStatus[] = [
  { id: "cred-1", label: "R2 access key", kind: "credential", state: "ok", source: "manual" } as ExpiryStatus,
  { id: "cred-2", label: "TLS certificate", kind: "certificate", state: "approaching", source: "observed" } as ExpiryStatus,
];

const FULL: EntityData = {
  downpipes: FIXTURE_DOWNPIPES,
  runs: FIXTURE_RUNS,
  destinations: FIXTURE_DESTINATIONS,
  credentials: FIXTURE_CREDENTIALS,
  auditHeadSeq: 42,
};

// Helper: find the single match for an entity group key in a resolve, or undefined.
function groupOf(caller: Caller, query: string, key: string) {
  return resolveEntityGroups(FULL, caller, query).find((g) => g.key === key);
}
function routeFor(caller: Caller, query: string, key: string): string | undefined {
  const g = groupOf(caller, query, key);
  return g?.matches[0]?.route;
}

// ---------------------------------------------------------------------------
// 1. ROUTE: each provider resolves a matching entity to the correct route.
// ---------------------------------------------------------------------------
console.log("\n-- providers resolve a matching entity to the correct route --");

// Downpipe by name -> /downpipes/:id
eq("downpipe name 'Alpha' -> /downpipes/dp-alpha", routeFor(owner, "Alpha", "downpipes"), "/downpipes/dp-alpha");
ok("downpipe match is under the 'Downpipes' group", groupOf(owner, "Alpha", "downpipes")?.label === "Downpipes");

// Run by run id -> /runs/:downpipeId/:index (the REAL run drawer route, not /downpipes/:id)
eq("run id 'run-2026-aaa' -> /runs/dp-alpha/7", routeFor(owner, "run-2026-aaa", "runs"), "/runs/dp-alpha/7");
ok("run match is under the 'Runs' group", groupOf(owner, "run-2026-aaa", "runs")?.label === "Runs");
ok("run route uses the /runs/:downpipeId/:index drawer route (not /downpipes/:id)",
  (routeFor(owner, "run-2026-aaa", "runs") ?? "").startsWith("/runs/"));

// Destination by label -> /destinations (no per-destination deep-link today)
eq("destination 'Sydney' -> /destinations", routeFor(owner, "Sydney", "destinations"), "/destinations");
ok("destination match is under the 'Destinations' group", groupOf(owner, "Sydney", "destinations")?.label === "Destinations");
// id-only match also resolves (typed the id, not the label).
eq("destination id 'dest-2' -> /destinations", routeFor(owner, "dest-2", "destinations"), "/destinations");

// Credential by label -> /credentials/:id (the detail-drawer deep-link the registry supports)
eq("credential 'R2 access key' -> /credentials/cred-1", routeFor(owner, "R2 access", "credentials"), "/credentials/cred-1");
ok("credential match is under the 'Credentials' group", groupOf(owner, "R2 access", "credentials")?.label === "Credentials");
ok("credential route is the /credentials/:id detail-drawer deep-link",
  (routeFor(owner, "R2 access", "credentials") ?? "").startsWith("/credentials/"));

// Audit entry by seq -> /access/audit (no per-entry deep-link today; only an existing seq resolves)
eq("audit seq '42' (== headSeq) -> /access/audit", routeFor(owner, "42", "audit"), "/access/audit");
ok("audit match is under the 'Audit' group", groupOf(owner, "42", "audit")?.label === "Audit");
ok("audit seq '0' (below 1) resolves nothing", groupOf(owner, "0", "audit") === undefined);
ok("audit seq '43' (above headSeq) resolves nothing (no such entry)", groupOf(owner, "43", "audit") === undefined);
ok("a non-numeric query never triggers the audit provider", groupOf(owner, "Alpha", "audit") === undefined);

// A viewer (read floor) resolves every provider too (the reads are universal).
console.log("\n-- a viewer (read floor) sees every provider (universal reads) --");
ok("viewer resolves the downpipe", routeFor(viewer, "Alpha", "downpipes") === "/downpipes/dp-alpha");
ok("viewer resolves the run", routeFor(viewer, "run-2026-aaa", "runs") === "/runs/dp-alpha/7");
ok("viewer resolves the destination", routeFor(viewer, "Sydney", "destinations") === "/destinations");
ok("viewer resolves the credential", routeFor(viewer, "R2 access", "credentials") === "/credentials/cred-1");
ok("viewer resolves the audit entry", routeFor(viewer, "42", "audit") === "/access/audit");

// ---------------------------------------------------------------------------
// 2. GATE: a provider is hidden when the caller lacks the capability.
// ---------------------------------------------------------------------------

// 2a. Null caller (whoami pending / signed out): EVERY provider fails closed.
console.log("\n-- null caller: every provider is hidden (fail closed) --");
for (const key of ["downpipes", "runs", "destinations", "credentials"]) {
  ok(`null caller: provider '${key}' is disabled`, entityProviderEnabled(null, key as never) === false);
}
ok("null caller: provider 'audit' is disabled", entityProviderEnabled(null, "audit") === false);
{
  const groups = resolveEntityGroups(FULL, null, "Alpha");
  ok("null caller: resolveEntityGroups returns nothing for a name query", groups.length === 0);
  const auditGroups = resolveEntityGroups(FULL, null, "42");
  ok("null caller: resolveEntityGroups returns nothing for an audit seq query", auditGroups.length === 0);
}

// 2b. A custom role that OMITS downpipe.read hides downpipes/runs/destinations/credentials,
// but a separate role that holds ONLY downpipe.read still shows them, proving the gate is
// the downpipe.read capability, not membership-by-default.
console.log("\n-- custom role omitting downpipe.read hides the downpipe-gated providers --");
const noDownpipeRead = callerWithCaps(["audit.read"]); // holds audit.read only
for (const key of ["downpipes", "runs", "destinations", "credentials"] as const) {
  ok(`omit downpipe.read: provider '${key}' is disabled`, entityProviderEnabled(noDownpipeRead, key) === false);
  ok(`omit downpipe.read: '${key}' resolves no rows`, groupOf(noDownpipeRead, key === "runs" ? "run-2026-aaa" : key === "downpipes" ? "Alpha" : key === "destinations" ? "Sydney" : "R2 access", key) === undefined);
}
// ...but THIS same role still sees audit (it holds audit.read):
ok("omit downpipe.read: audit STILL resolves (role holds audit.read)", routeFor(noDownpipeRead, "42", "audit") === "/access/audit");

const onlyDownpipeRead = callerWithCaps(["downpipe.read"]);
ok("hold downpipe.read: downpipes resolves", routeFor(onlyDownpipeRead, "Alpha", "downpipes") === "/downpipes/dp-alpha");
ok("hold downpipe.read: runs resolves", routeFor(onlyDownpipeRead, "run-2026-aaa", "runs") === "/runs/dp-alpha/7");
ok("hold downpipe.read: destinations resolves", routeFor(onlyDownpipeRead, "Sydney", "destinations") === "/destinations");
ok("hold downpipe.read: credentials resolves", routeFor(onlyDownpipeRead, "R2 access", "credentials") === "/credentials/cred-1");

// 2c. A custom role that OMITS audit.read hides ONLY the audit provider; the rest survive.
console.log("\n-- custom role omitting audit.read hides ONLY the audit provider --");
const noAuditRead = callerWithCaps(["downpipe.read"]); // downpipe.read but NOT audit.read
ok("omit audit.read: provider 'audit' is disabled", entityProviderEnabled(noAuditRead, "audit") === false);
ok("omit audit.read: audit seq '42' resolves nothing", groupOf(noAuditRead, "42", "audit") === undefined);
ok("omit audit.read: downpipes STILL resolves", routeFor(noAuditRead, "Alpha", "downpipes") === "/downpipes/dp-alpha");
ok("omit audit.read: runs STILL resolves", routeFor(noAuditRead, "run-2026-aaa", "runs") === "/runs/dp-alpha/7");

// ---------------------------------------------------------------------------
// 3. Honest partial data: a null list for a provider yields no rows (skipped), and a
//    gated-OFF provider returns nothing even if data is (defensively) present.
// ---------------------------------------------------------------------------
console.log("\n-- honest partial data + defensive gating --");
{
  // Credentials data missing (fetch failed / not loaded): credentials group absent, others fine.
  const partial: EntityData = { ...FULL, credentials: null };
  ok("null credentials list -> no credentials group", resolveEntityGroups(partial, owner, "R2 access").find((g) => g.key === "credentials") === undefined);
  ok("null credentials list -> downpipes still resolves", resolveEntityGroups(partial, owner, "Alpha").find((g) => g.key === "downpipes") !== undefined);
}
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  // Defensive: even if a list is passed for a provider the caller is gated OFF for, the
  // resolver re-checks the gate and yields nothing (the gate is enforced in resolve, not
  // only in fetch, so stale data cannot leak).
  ok("gated-off provider with data present still yields nothing", groupOf(noDownpipeRead, "Alpha", "downpipes") === undefined);
}

// ---------------------------------------------------------------------------
// 4. Empty query yields no entity groups (the static commands own the empty state).
// ---------------------------------------------------------------------------
console.log("\n-- empty query yields no entity groups --");
ok("empty query -> no entity groups", resolveEntityGroups(FULL, owner, "").length === 0);
ok("whitespace query -> no entity groups", resolveEntityGroups(FULL, owner, "   ").length === 0);

// ---------------------------------------------------------------------------
// 5. Sanity: the gate capabilities are real members of the Capability union (no typo that
//    would make a gate always-false).
// ---------------------------------------------------------------------------
console.log("\n-- gate capabilities are valid Capability members --");
ok("downpipe.read is a known capability", (ALL_CAPABILITIES as readonly string[]).includes("downpipe.read"));
ok("audit.read is a known capability", (ALL_CAPABILITIES as readonly string[]).includes("audit.read"));

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nVALIDATE-PALETTE-SEARCH VECTORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
