// Validate the pure / near-pure audit rendering helpers (the tamper-evidence and accountability
// surface of the product). The audit log is where a logic bug would mislead an auditor with no test
// catching it, so this suite drives the REAL functions under the shared DOM shim and asserts the
// load-bearing outputs:
//
//   - auditFiltersFromQuery: every valid param is seeded; an invalid action/outcome is rejected; an
//     extra/unknown param is ignored; the page limit default is set.
//   - hasActiveAuditFilter: true for each filter field, false for the empty (limit-only) case.
//   - renderChainVerdict: intact / intact-empty / broken variants render the right tone and title (an
//     intact verdict must NEVER read as a break, and a break must NEVER read as intact).
//   - describeTarget: one assertion per target kind, including the default/unknown (newer-engine) case.
//   - actorIdentifier: email is preferred; each method fallback names the actor; an unknown method
//     reads "unknown method" and is never mislabelled as the token break-glass path.
//
// Run with `node test/validate-audit.ts`. It imports AFTER the shim is installed (the audit modules
// pull in lib/dom.ts, which touches document on render). It never re-implements anything under test.

import { installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

import {
  auditFiltersFromQuery,
  hasActiveAuditFilter,
} from "../src/screens/access-security/audit-filters.ts";
import { renderChainVerdict } from "../src/screens/access-security/audit-events.ts";
import { describeTarget, actorIdentifier } from "../src/screens/access-security/audit-display.ts";
import type { AuditEvent, AuditTarget, ChainVerdict } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// ===========================================================================
// 1. auditFiltersFromQuery: URL params seed the SERVER-side filters.
// ===========================================================================
console.log("\n-- auditFiltersFromQuery seeds filters from the route query --");

{
  // All valid params present.
  const f = auditFiltersFromQuery(new URLSearchParams({
    actor: "alice@example.com",
    action: "restore-apply",
    downpipe: "dp-1",
    outcome: "success",
    from: "2026-06-01",
    to: "2026-06-30",
  }));
  eq(f.actor, "alice@example.com", "actor is seeded");
  eq(f.action, "restore-apply", "a valid action is seeded");
  eq(f.downpipe, "dp-1", "downpipe is seeded");
  eq(f.outcome, "success", "a valid outcome is seeded");
  eq(f.from, "2026-06-01", "from is seeded");
  eq(f.to, "2026-06-30", "to is seeded");
  eq(f.limit, 100, "the page-default limit is set");
}

{
  // An invalid action is rejected (it would mislead by silently filtering on a non-existent field).
  const f = auditFiltersFromQuery(new URLSearchParams({ action: "not-a-real-action" }));
  ok("an invalid action is dropped, not passed through", f.action === undefined);
}
{
  // An invalid outcome is rejected.
  const f = auditFiltersFromQuery(new URLSearchParams({ outcome: "maybe" }));
  ok("an invalid outcome is dropped, not passed through", f.outcome === undefined);
}
{
  // An unknown extra param is ignored (no injection into an unrelated filter field).
  const f = auditFiltersFromQuery(new URLSearchParams({ bogus: "x", before: "5" }));
  ok("an unknown param is ignored", !("bogus" in f));
  ok("the non-user 'before' cursor is not seeded as a filter", f.before === undefined);
  eq(Object.keys(f).sort().join(","), "limit", "an all-bogus query yields only the limit");
}
{
  // An empty value string is treated as absent (falsy guard), never an empty-string filter.
  const f = auditFiltersFromQuery(new URLSearchParams({ actor: "" }));
  ok("an empty actor string is not seeded", f.actor === undefined);
}

// ===========================================================================
// 2. hasActiveAuditFilter: the empty-state distinction depends on this being exact.
// ===========================================================================
console.log("\n-- hasActiveAuditFilter is true for each field, false when only the limit is set --");

ok("empty (limit-only) is NOT active", hasActiveAuditFilter({ limit: 100 }) === false);
ok("a bare empty object is NOT active", hasActiveAuditFilter({}) === false);
ok("actor makes it active", hasActiveAuditFilter({ actor: "a" }));
ok("action makes it active", hasActiveAuditFilter({ action: "restore-apply" }));
ok("downpipe makes it active", hasActiveAuditFilter({ downpipe: "dp-1" }));
ok("outcome makes it active", hasActiveAuditFilter({ outcome: "denied" }));
ok("from makes it active", hasActiveAuditFilter({ from: "2026-06-01" }));
ok("to makes it active", hasActiveAuditFilter({ to: "2026-06-30" }));

// ===========================================================================
// 3. renderChainVerdict: intact must never read as a break, and vice versa.
// ===========================================================================
console.log("\n-- renderChainVerdict renders the correct verdict, never the opposite --");

{
  const v: ChainVerdict = { intact: true, checkedThrough: 42 };
  const t = textOf(renderChainVerdict(v));
  ok("intact verdict says 'intact'", t.toLowerCase().includes("intact"));
  ok("intact verdict names the entry it checked through", t.includes("42"));
  ok("intact verdict does NOT say 'break'", !t.toLowerCase().includes("break"));
}
{
  const v: ChainVerdict = { intact: true, checkedThrough: -1 };
  const t = textOf(renderChainVerdict(v));
  ok("intact-empty verdict reads 'no events yet'", t.toLowerCase().includes("no events yet"));
  ok("intact-empty verdict does NOT say 'break'", !t.toLowerCase().includes("break"));
}
{
  const v: ChainVerdict = { intact: false, checkedThrough: 10, brokenAt: 7 };
  const t = textOf(renderChainVerdict(v));
  ok("broken verdict says 'break'", t.toLowerCase().includes("break"));
  ok("broken verdict names the broken entry", t.includes("7"));
  ok("broken verdict does NOT claim 'intact'", !t.toLowerCase().includes("intact"));
}
{
  // A break with no brokenAt falls back to checkedThrough for the entry number.
  const v: ChainVerdict = { intact: false, checkedThrough: 3 };
  const t = textOf(renderChainVerdict(v));
  ok("broken-without-brokenAt falls back to checkedThrough", t.includes("3"));
}

// ===========================================================================
// 4. describeTarget: one assertion per target kind, plus the unknown default.
// ===========================================================================
console.log("\n-- describeTarget renders the safe fields of every target kind --");

const desc = (t: AuditTarget): string => textOf(describeTarget(t));

ok("downpipe (named) shows name and id", desc({ kind: "downpipe", id: "dp-1", name: "Prod KV" }).includes("Prod KV") && desc({ kind: "downpipe", id: "dp-1", name: "Prod KV" }).includes("dp-1"));
ok("downpipe (unnamed) shows the id", desc({ kind: "downpipe", id: "dp-9" }).includes("dp-9"));

// restore-receipt: the audit row is where an auditor reads WHICH restore happened. Its own comment says
// "the restore succeeded" and "the restore succeeded and every restored record re-hashed" are different
// claims, which is why allVerified and complete are called out. Records the apply deliberately did not
// write are different by the same rule: they are in the archive and not in the account, so a bare count
// that omits them reads as a complete restore. The row carried them nowhere until now.
const receipt = (extra: Record<string, unknown>): string =>
  desc({ kind: "restore-receipt", runId: "01RUN", receiptSha384: "sha384:r", recordsRestored: 98, allVerified: true, ...extra } as AuditTarget);
ok("restore-receipt names the run and the count", receipt({}).includes("01RUN") && receipt({}).includes("98 records"));
ok("restore-receipt commits to the receipt hash", receipt({}).includes("sha384:r"));
ok("restore-receipt calls out records not written, with what it means", receipt({ recordsSkipped: 2 }).includes("2 not written, still outstanding"));
ok("restore-receipt stays quiet when nothing was skipped", !receipt({ recordsSkipped: 0 }).includes("not written"));
ok("restore-receipt stays quiet when the field is absent (an older engine)", !receipt({}).includes("not written"));
// The two existing flags: a clean row must not claim either.
ok("restore-receipt flags a failed verification", receipt({ allVerified: false }).includes("NOT all verified"));
ok("restore-receipt flags a windowed apply", receipt({ complete: false }).includes("windowed: incomplete"));
ok("restore-receipt claims neither on a clean apply", !receipt({}).includes("NOT all verified") && !receipt({}).includes("windowed"));
ok("run shows the run id", desc({ kind: "run", runId: "r-123" }).includes("r-123"));
{
  const t = desc({ kind: "restore", runId: "r-1", redirectBinding: "OTHER", planHash: "h", isLatest: false, approverEmail: "bob@x.io" });
  ok("restore shows run, redirect, non-latest and approver", t.includes("r-1") && t.includes("OTHER") && t.includes("non-latest") && t.includes("bob@x.io"));
}
ok("role shows email and role", desc({ kind: "role", email: "a@x.io", role: "operator" }).includes("a@x.io") && desc({ kind: "role", email: "a@x.io", role: "operator" }).includes("operator"));
ok("grouprole shows group and role", desc({ kind: "grouprole", group: "sre", role: "approver" }).includes("sre"));
ok("customrole (with caps) shows the count", desc({ kind: "customrole", name: "Auditor", capabilityCount: 3 }).includes("3"));
ok("customrole (zero caps) shows the name only", desc({ kind: "customrole", name: "Bare", capabilityCount: 0 }).includes("Bare"));
ok("configchange shows kind and id", desc({ kind: "configchange", id: "c-1", changeKind: "downpipe-save" }).includes("downpipe-save"));
ok("key-ceremony reads as an intent", desc({ kind: "key-ceremony" }).toLowerCase().includes("key ceremony"));
ok("access-policy reads as an intent", desc({ kind: "access-policy" }).toLowerCase().includes("access policy"));
ok("supportcredential shows the scope", desc({ kind: "supportcredential", scope: "diagnostics" }).includes("diagnostics"));
ok("engine-state maps the field to a label (not the raw name)", !desc({ kind: "engine-state", field: "secret-present", detail: "yes" }).includes("secret-present"));
{
  // A newer engine can write a kind this build does not know: it must render, not throw or blank.
  const t = desc({ kind: "future-kind" } as unknown as AuditTarget);
  ok("an unknown target kind renders an honest placeholder", t.toLowerCase().includes("unrecognised") && t.includes("future-kind"));
}

// ===========================================================================
// 5. actorIdentifier: email preferred; each method fallback; unknown is never the token path.
// ===========================================================================
console.log("\n-- actorIdentifier prefers the email, else names the method --");

const ev = (over: Partial<AuditEvent>): AuditEvent => ({
  seq: 1, ts: "2026-06-01T00:00:00.000Z", actorEmail: null, actorMethod: "engine",
  sourceIp: null, action: "session-terminate", outcome: "success",
  target: { kind: "key-ceremony" }, prevHash: "", hash: "", ...over,
});

eq(actorIdentifier(ev({ actorEmail: "alice@x.io", actorMethod: "passkey" })), "alice@x.io", "email is preferred over the method");
eq(actorIdentifier(ev({ actorEmail: null, actorMethod: "engine" })), "engine", "engine-observed reads 'engine'");
eq(actorIdentifier(ev({ actorEmail: null, actorMethod: "passkey" })), "passkey", "passkey with no email reads 'passkey'");
eq(actorIdentifier(ev({ actorEmail: null, actorMethod: "token" })), "token", "token break-glass reads 'token'");
eq(actorIdentifier(ev({ actorEmail: null, actorMethod: "access" })), "access", "access with no email reads 'access'");
{
  const id = actorIdentifier(ev({ actorEmail: null, actorMethod: "future" as AuditEvent["actorMethod"] }));
  eq(id, "unknown method", "an unknown method reads 'unknown method'");
  ok("an unknown method is NEVER mislabelled as the token path", id !== "token");
}

console.log(failures === 0 ? "\nVALIDATE-AUDIT VECTORS PASS" : `\nVALIDATE-AUDIT FAILED (${failures})`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
