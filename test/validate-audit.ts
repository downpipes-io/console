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
import { EngineClient, type AuditEvent, type AuditTarget, type ChainVerdict } from "../src/api.ts";
import { auditToBound } from "../src/lib/api/client-audit.ts";
import { importFromEngine } from "./engine-path.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const HERE = new URL(".", import.meta.url).pathname;

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
  // headAnchorUnreadable: the engine could not read its head anchor, so the tail-deletion check did not run.
  // A render that did not read the field would show the plain "Chain intact through entry 42".
  const el = renderChainVerdict({ intact: true, checkedThrough: 42, headAnchorUnreadable: true });
  const t = textOf(el);
  ok("anchor unreadable: the verdict still names the entry it checked through", t.includes("Intact through entry 42"));
  ok("anchor unreadable: the title says the tail is unchecked", t.includes("Intact through entry 42, tail unchecked"));
  ok("anchor unreadable: the body says the check for deleted newest entries could not run", t.includes("the check for deleted newest entries could not run"));
  ok("anchor unreadable: the verdict is a warning, not the calm intact tone", el.className.includes("verdict--warn") && !el.className.includes("verdict--ok"));
  ok("anchor unreadable: it is not called a break", !t.toLowerCase().includes("break"));
  // With a rollover as well, both facts reach the screen.
  const both = textOf(renderChainVerdict({ intact: true, checkedThrough: 900, headAnchorUnreadable: true, rolledOver: true, rolledOverCount: 12, earliestSeq: 13 }));
  ok("anchor unreadable and rolled over: both qualifications are shown", both.includes("could not run") && both.includes("retained chain begins at entry 13"));
  // NEGATIVE CONTROL: the same verdict without the flag keeps the plain intact surface.
  const plain = renderChainVerdict({ intact: true, checkedThrough: 42 });
  ok("negative control: without the flag the verdict is the calm intact tone", plain.className.includes("verdict--ok") && !textOf(plain).includes("could not run"));
  // No entries held and the head record unreadable: the recompute checked nothing, so the verdict must not
  // lead with "Intact" or say that entries recompute.
  const emptyEl = renderChainVerdict({ intact: true, checkedThrough: -1, headAnchorUnreadable: true });
  const emptyText = textOf(emptyEl);
  ok("anchor unreadable over no entries: the title says no entries are held", emptyText.includes("No entries held, chain head unreadable"));
  ok("anchor unreadable over no entries: it does not claim the chain is intact", !/intact/i.test(emptyText));
  ok("anchor unreadable over no entries: it does not claim any entries recompute", !/recompute cleanly|link to one another/i.test(emptyText) && !emptyText.includes("no events yet"));
  ok("anchor unreadable over no entries: the verdict is a warning", emptyEl.className.includes("verdict--warn") && !emptyEl.className.includes("verdict--ok"));
  // A headTruncated verdict still wins: a detected deletion outranks a check that could not run.
  ok("a detected tail deletion still renders as the danger surface", renderChainVerdict({ intact: true, checkedThrough: 40, headTruncated: true, headTruncatedAt: 42, headAnchorUnreadable: true }).className.includes("verdict--danger"));
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
// The two existing flags, previously unasserted: a clean row must not claim either.
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

// ===========================================================================
// 6. The To date includes the day that the operator picked.
// ===========================================================================
// The engine keeps an entry only when its timestamp is not after the To bound, compared as text. A bare
// date sorts before every timestamp on 30 June, so a bare date as the bound leaves the chosen day out.
// The query is read from the REAL listAudit through a fetch stub. When an engine checkout is reachable, the
// bound it sends goes through the engine's own parseAuditFilter and pageEvents, so the grade is the engine's
// answer and not a copy of its rule.
console.log("\n-- the To date includes the whole chosen UTC day --");
{
  eq(auditToBound("2026-06-30"), "2026-06-30T23:59:59.999Z", "a bare To date becomes the last millisecond of that UTC day");
  eq(auditToBound("2026-06-30T12:00:00.000Z"), "2026-06-30T12:00:00.000Z", "a value that is not a bare date passes through unchanged");

  const g = globalThis as unknown as { fetch: unknown };
  const prevFetch = g.fetch;
  const urls: string[] = [];
  g.fetch = async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ events: [], head: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await new EngineClient("https://engine.test").listAudit({ from: "2026-06-01", to: "2026-06-30" });
  } finally {
    g.fetch = prevFetch;
  }
  const sent = new URL(urls[0] ?? "https://engine.test/").searchParams;
  eq(sent.get("to"), "2026-06-30T23:59:59.999Z", "listAudit sends the end of the To day, not the bare date");
  eq(sent.get("from"), "2026-06-01", "listAudit sends From unchanged (a bare date already includes its day)");

  const helpers = await importFromEngine<{ parseAuditFilter: (p: URLSearchParams) => unknown }>(HERE, "src/sched/scheduler-helpers.ts");
  const auditMod = await importFromEngine<{ pageEvents: (all: unknown[], f: unknown) => Array<{ seq: number }> }>(HERE, "src/admin/audit.ts");
  if (helpers === null || auditMod === null) {
    // CANNOT CHECK, not a pass: the engine half answered nothing. npm run validate:workspace sets
    // REQUIRE_ENGINE, and there a missing engine refuses instead of reading as green.
    console.log("  CANNOT CHECK the engine half: no engine checkout reachable (set DOWNPIPES_ENGINE)");
    if (process.env.REQUIRE_ENGINE === "1") verdictCannotCheck("validate-audit: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable, so the To-bound check against the engine's own filter did not run.");
  } else {
    const at = (seq: number, ts: string) => ({ seq, ts, actorEmail: null, actorMethod: "engine", sourceIp: null, action: "engine-version-change", outcome: "success", target: { kind: "engine-state", field: "engineVersion", detail: "x" } });
    const all = [at(1, "2026-05-31T23:59:59.999Z"), at(2, "2026-06-01T00:00:00.000Z"), at(3, "2026-06-30T09:00:00.000Z"), at(4, "2026-06-30T23:59:59.999Z"), at(5, "2026-07-01T00:00:00.000Z")];
    const kept = auditMod.pageEvents(all, helpers.parseAuditFilter(sent)).map((e) => e.seq).sort((a, b) => a - b);
    eq(JSON.stringify(kept), JSON.stringify([2, 3, 4]), "the engine keeps every entry on 1 to 30 June and nothing on 31 May or 1 July");
  }
}

console.log(failures === 0 ? "\nVALIDATE-AUDIT VECTORS PASS" : `\nVALIDATE-AUDIT FAILED (${failures})`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
