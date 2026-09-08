// Route-to-caller contract guard: every critical engine admin route must have a caller in src/api.ts.
// Run with: node test/validate-route-callers.ts
//
// THE DEFECT THIS CATCHES: the engine repeatedly ships an admin route (a new capability returned by the
// engine) that the console never wires a caller for, so the capability is built-but-unsurfaced and goes
// unnoticed because every existing test still passes. This guard asserts that a curated ALLOWLIST of
// CRITICAL engine admin routes each have a CALLER in src/api.ts (the single typed client every screen
// goes through). It is intentionally a SOURCE-STRING presence check over src/api.ts, not a full router
// parser: a caller is recognised by the route's path string appearing in the api.ts source (the same
// `${this.base}/admin/...` fetch idiom every method uses), which is reliable, dependency-free, and cannot
// drift the way a parser would. A route with no matching string FAILS with a clear message naming it, so
// a newly-shipped engine route is wired in the console (or explicitly added here) before the suite goes
// green.
//
// It does NOT assert the call is correct end-to-end (that is the per-feature validators' job); it asserts
// the wiring EXISTS, which is precisely the gap that recurs. No network, no DOM, no secret: it reads one
// source file off disk.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks } from "./validate-checks.ts";

const checks = makeChecks();
const { ok } = checks;

// Read the typed client source (npm run validate sets cwd to the console package root). The typed
// client is the src/api.ts barrel plus the per-resource modules it re-exports from src/lib/api/
// (including nested folders such as src/lib/api/types/), so the presence check spans every file that
// makes up the single client surface. It stays a source-string check, not a router parser: a caller
// is recognised by the route's path string appearing anywhere in that client source.
//
// COMMENTS ARE BLANKED FIRST, and that is load-bearing rather than tidy. Every wire type in
// src/lib/api/types/ documents the route it mirrors ("the GET /admin/x response"), so a plain read of
// this tree would satisfy the guard from prose alone: deleting the only real caller while its type
// comment survives would leave this check green.
const API_BARREL = join("src", "api.ts");
const API_LIB_DIR = join("src", "lib", "api");

// stripComments blanks whole-line and block comments, conservatively: it drops only lines that OPEN with
// // or /* or *, plus block interiors. Whatever it misses stays in the text, so its error direction is a
// guard that still passes on prose, never one that fails on real code.
function stripComments(code: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      out.push("");
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      out.push("");
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function readTsTreeConcat(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out += readTsTreeConcat(full);
    else if (entry.name.endsWith(".ts")) out += `\n${stripComments(readFileSync(full, "utf8"))}`;
  }
  return out;
}
let api = "";
try {
  api = stripComments(readFileSync(API_BARREL, "utf8")) + readTsTreeConcat(API_LIB_DIR);
} catch (e) {
  ok(`could not read the typed client source (${API_BARREL} + ${API_LIB_DIR}) (${(e as Error).message})`, false);
}

console.log("-- Route-to-caller contract guard (critical engine admin routes have a caller in src/api.ts) --");

ok(`the typed client source (${API_BARREL} + ${API_LIB_DIR}) is non-empty`, api.length > 0);

// The curated allowlist of CRITICAL routes a console MUST call. Each entry is the admin path string the
// engine exposes (engine src/admin/router.ts) and that the console's typed client embeds in its fetch.
// `why` is the human reason the route is load-bearing, shown in the failure message so the fix is obvious.
// Add a route here the moment the engine ships a critical capability, and the guard then requires the
// console caller before the suite passes.
interface RouteCaller {
  path: string;
  why: string;
}
const REQUIRED_ROUTES: RouteCaller[] = [
  { path: "/admin/idp/test", why: "the read-only pre-save IdP test-connection probe (catch a misconfigured trust root before save)" },
  { path: "/admin/rto", why: "the RTO recovery-time estimate (the recovery-time companion to the RPO/freshness signal)" },
  { path: "/admin/runs/at", why: "point-in-time run resolution (turn a recovery-timeline pick into a runId for restore)" },
  { path: "/admin/restore", why: "the dry-run -> dual-control -> apply restore path (the recovery hero)" },
  { path: "/admin/coverage/inventory", why: "in-console populate of the coverage reference inventory (no-CLI rule): an operator must be able to record what exists without dropping to a curl" },
  { path: "/admin/config/history", why: "in-console config version-history timeline (the engine versions its own governance config as signed, verifiable snapshots; without a caller the history is built-but-unsurfaced)" },
  { path: "/admin/otlp-push", why: "the OTLP/HTTP metrics push destination (monitoring integrations): without a caller the zero-agent metrics push is built-but-unsurfaced" },
  { path: "/admin/keys/vintages", why: "the keyless key-vintage inventory: the engine can say which runs are stranded to a key it no longer holds, and with no caller an owner who rotated and kept only the latest key could not see it" },
  { path: "/admin/policy/require-access", why: "the lock-out pre-flight: the engine's authoritative verdict on whether closing the shared-token path would lock the operator out, which the console must consult before it advises the out-of-band act" },
];

console.log("\n-- required routes each have a caller --");
for (const r of REQUIRED_ROUTES) {
  // The fetch idiom is always `${this.base}<path>` (optionally with a query suffix), so the bare path
  // string is the reliable marker that a caller exists. A route with no occurrence is an unwired engine
  // capability: fail loudly and NAME it, so the fix (wire a caller in src/api.ts) is unambiguous.
  const present = api.includes(r.path);
  ok(
    present
      ? `${r.path} has a caller in src/api.ts`
      : `${r.path} has NO caller in src/api.ts: wire one (${r.why}).`,
    present,
  );
}

// The POST /admin/restore caller must pass recordName, so a GRANULAR single-record restore is reachable
// (the engine plans + applies EXACTLY one record when recordName is set; without the field on the request
// the console can never scope a restore to one record, and the single-record affordance is dead). The
// restore() method sends the whole RestoreRequest via JSON.stringify, so the load-bearing wiring is that
// recordName is a FIELD on the console's RestoreRequest type AND is bound into the client-side
// restorePlanHash (which must match the engine byte-for-byte, or a single-record apply's dual-control gate
// never arms). Both are asserted as source-string presence over src/api.ts.
console.log("\n-- POST /admin/restore carries recordName (granular single-record restore) --");

// The console RestoreRequest type (the wire shape restore() serialises) must declare recordName.
const restoreReqMatch = /export interface RestoreRequest\s*\{[\s\S]*?\n\}/.exec(api);
const restoreReqBlock = restoreReqMatch ? restoreReqMatch[0] : "";
ok("the console RestoreRequest interface is present in src/api.ts", restoreReqBlock.length > 0);
ok(
  restoreReqBlock.includes("recordName")
    ? "RestoreRequest declares recordName (a single-record restore is expressible)"
    : "RestoreRequest is MISSING recordName: a granular single-record restore cannot be requested. Add `recordName?: string` to the console RestoreRequest (mirror engine src/admin/restore-types.ts).",
  restoreReqBlock.includes("recordName"),
);

// The client-side restorePlanHash must bind recordName, or a single-record apply's plan hash will not
// match the engine's and the dual-control gate can never arm. Assert recordName appears inside the
// exported restorePlanHash function body.
const planHashMatch = /export async function restorePlanHash\([\s\S]*?\n\}/.exec(api);
const planHashBlock = planHashMatch ? planHashMatch[0] : "";
ok("the client restorePlanHash function is present in src/api.ts", planHashBlock.length > 0);
ok(
  planHashBlock.includes("recordName")
    ? "restorePlanHash binds recordName (a single-record apply hashes distinctly, matching the engine)"
    : "restorePlanHash does NOT bind recordName: a single-record apply's plan hash will not match the engine and the dual-control gate will never arm. Bind recordName in restorePlanHash (mirror engine src/admin/approvals.ts).",
  planHashBlock.includes("recordName"),
);

console.log(checks.failures === 0 ? "\nROUTE-CALLER CONTRACT GUARD PASS" : `\n${checks.failures} FAILURE(S)`);
if (checks.failures > 0) process.exitCode = 1;
if (checks.failures > 0) process.exit(1);
