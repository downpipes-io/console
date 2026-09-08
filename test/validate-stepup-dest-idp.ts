// TC-stepup-dest-idp: the destination + IdP management screens (plus the session-termination
// levers) route their MUTATING POSTs through the shared step-up / dual-control fetch wrapper, and the
// restore confirm screen labels an intentional WINDOWED partial apply distinctly from a failure.
//
// Run with: node test/validate-stepup-dest-idp.ts
//
// Like validate-api.ts / validate-sessions-passkeys.ts, this drives the REAL EngineClient methods over a
// captured global fetch (it never re-implements the client) and exercises the REAL pure restore-outcome
// classifier from the confirm screen. It does not re-implement either path.
//
// Coverage:
//   STEP-UP (ASVS V7.5.1): each of the destination + IdP + session-termination MUTATION methods, on a 401
//     { stepUpRequired:true }, runs the injected step-up ceremony and RETRIES ONCE carrying the
//     x-downpipes-stepup header; with no ceremony wired the original 401 is surfaced (no retry). The
//     methods covered are exactly those whose engine routes are (or are being made) step-up sensitive:
//     setDestination / addDestination / removeDestination / setDefaultDestination / createIdpConnection /
//     deleteIdpConnection / setIdpConnectionEnabled / terminateOtherSessions / terminateUserSessions /
//     terminateAllSessions (ASVS V7.5.2).
//   DUAL CONTROL (202): a 202 { ownerActionQueued } still resolves to { status:"queued" } AFTER the
//     gatedFetch change (gatedFetch only acts on a step-up 401, so the queued path is unchanged).
//   RESTORE OUTCOME: restoreOutcome classifies an applied RestoreResult into failed /
//     windowed / clean, so a deliberate maxRecords windowed apply (complete:false, no failures) is labelled
//     "applied (windowed)" with the remaining-beyond-window count, NEVER "applied with failures"; an absent
//     complete flag (an engine build that does not emit it) reads as a complete apply (the prior behaviour).

import { EngineClient } from "../src/api.ts";
import type { RestoreResult } from "../src/api.ts";
import { restoreOutcome } from "../src/screens/restore-flow/confirm.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = JSON.stringify(got) === JSON.stringify(want);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!cond) failures++;
}

// A scripted fetch: it answers the first request with `first`, then the second (the step-up retry, if any)
// with `second`. It records every request's headers so the retry's x-downpipes-stepup header is asserted.
// This patches the global fetch in place; calling the returned restore() is mandatory, and the required
// call pattern is `.finally(restore)` so the global is reverted even if the mutation under test rejects.
interface Recorded { path: string; method: string; headers: Record<string, string> }
interface CannedResponse { status: number; body: unknown }
function scriptFetch(first: CannedResponse, second?: CannedResponse): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = async (input: unknown, init?: { method?: string; headers?: unknown }) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v;
    else if (h && typeof h === "object") for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    calls.push({ path: String(input), method: init?.method ?? "GET", headers });
    const which = calls.length === 1 ? first : (second ?? first);
    return {
      ok: which.status >= 200 && which.status < 300,
      status: which.status,
      async text() { return JSON.stringify(which.body); },
      async json() { return which.body; },
      clone() { return this; },
    };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

// runMutation invokes a named mutation on a fresh client with the ceremony wired, returning the recorded
// calls. The ceremony returns a fixed token, so the retry MUST carry it.
// A fixed fake token (not a real token shape): the test asserts only that this exact value is forwarded
// in the retry header.
const STEPUP_TOKEN = "stepuptoken-deadbeef";
async function runMutation(name: string, invoke: (e: EngineClient) => Promise<unknown>): Promise<Recorded[]> {
  const engine = new EngineClient("https://engine.test");
  let ceremonyRuns = 0;
  engine.onStepUpRequired = async () => { ceremonyRuns++; return STEPUP_TOKEN; };
  // First call: 401 stepUpRequired. Retry: 200 with a benign applied body.
  const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } }, { status: 200, body: { ok: true } });
  await invoke(engine).catch(() => undefined).finally(restore);
  ok(`${name}: the step-up ceremony ran exactly once`, ceremonyRuns === 1);
  return calls;
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- STEP-UP (V7.5.1): destination + IdP mutations route through gatedFetch --");
  // ------------------------------------------------------------------------
  const mutations: Array<{ name: string; invoke: (e: EngineClient) => Promise<unknown>; pathEnds: string }> = [
    { name: "setDestination", invoke: (e) => e.setDestination(null), pathEnds: "/admin/destination" },
    { name: "addDestination", invoke: (e) => e.addDestination({} as never, "label"), pathEnds: "/admin/destinations" },
    { name: "removeDestination", invoke: (e) => e.removeDestination("d1"), pathEnds: "/admin/destinations/remove" },
    { name: "setDefaultDestination", invoke: (e) => e.setDefaultDestination("d1"), pathEnds: "/admin/destinations/default" },
    { name: "createIdpConnection", invoke: (e) => e.createIdpConnection({} as never), pathEnds: "/admin/idp/connections" },
    { name: "deleteIdpConnection", invoke: (e) => e.deleteIdpConnection("c1"), pathEnds: "/admin/idp/connections/delete" },
    { name: "setIdpConnectionEnabled", invoke: (e) => e.setIdpConnectionEnabled("c1", false), pathEnds: "/admin/idp/connections/enabled" },
    // The session-termination levers were the one destructive-action family NOT routed
    // through gatedFetch (client-session.ts); this is their step-up-retry coverage extension point.
    { name: "terminateOtherSessions", invoke: (e) => e.terminateOtherSessions(), pathEnds: "/admin/sessions/terminate-others" },
    { name: "terminateUserSessions", invoke: (e) => e.terminateUserSessions("person@example.com"), pathEnds: "/admin/sessions/terminate-user" },
    { name: "terminateAllSessions", invoke: (e) => e.terminateAllSessions(), pathEnds: "/admin/sessions/terminate-all" },
    // These four notify-config routes must route through gatedFetch too, or the engine's 401
    // { stepUpRequired } reaches the SCREEN and a notify save fails closed with a visible error, no
    // ceremony ever running. They govern the availability of EVIDENCE (deleting or narrowing the rule that
    // carries a critical alert silences an account with no visible effect and no undo), which is why both
    // directions are gated, set as well as delete. Asserted here rather than in the notifications validator
    // so the whole step-up family is read in one place.
    { name: "upsertNotifyChannel", invoke: (e) => e.upsertNotifyChannel({} as never), pathEnds: "/admin/notify/channels" },
    { name: "deleteNotifyChannel", invoke: (e) => e.deleteNotifyChannel("c1"), pathEnds: "/admin/notify/channels/delete" },
    { name: "upsertNotifyRule", invoke: (e) => e.upsertNotifyRule({} as never), pathEnds: "/admin/notify/rules" },
    { name: "deleteNotifyRule", invoke: (e) => e.deleteNotifyRule("r1"), pathEnds: "/admin/notify/rules/delete" },
    // restore's apply call must route through gatedFetch like every other sensitive write, or a
    // maker-checker restore that is fully approved and perfectly valid could not be applied at all: a real
    // review takes longer than the 300-second freshness window, the engine answers 401 { stepUpRequired },
    // and on a bare engineFetch that 401 is final. The console would then tell the operator to approve a
    // passkey prompt that this call path cannot raise, with the credential API never called at all. The
    // only escape would be outside the flow, and for the in-console break-glass restore the per-run master
    // is decapsulated in the tab and lost with it.
    { name: "restore", invoke: (e) => e.restore({ runId: "01JBRESTORE00000000000000", confirm: true } as never), pathEnds: "/admin/restore" },
    // Every POST call site that reaches a step-up-gated engine route must go through gatedFetch, or on a
    // cookie-borne session the engine's 401 { stepUpRequired } is the final answer and the action fails
    // rather than prompting.
    //
    // WHY A HAND-WRITTEN LIST CAN NEVER BE ENOUGH ON ITS OWN: requireStepUp opens with
    // `if (method === "token" || method === "access") return null`. A caller authenticated by bearer token
    // is exempt by construction, so an environment exercised only that way reports every one of these
    // calls working regardless of whether it is actually gated. Behaviour is worth asserting directly here,
    // and it is worth deriving the same question from the engine's own set elsewhere too, so a route
    // joining it cannot wait to be added to this list.
    { name: "setRole", invoke: (e) => e.setRole("person@example.com", "admin" as never), pathEnds: "/admin/roles" },
    { name: "deleteRole", invoke: (e) => e.deleteRole("person@example.com"), pathEnds: "/admin/roles/delete" },
    { name: "setGroupRole", invoke: (e) => e.setGroupRole("engineers", "admin" as never), pathEnds: "/admin/group-roles" },
    { name: "deleteGroupRole", invoke: (e) => e.deleteGroupRole("engineers"), pathEnds: "/admin/group-roles/delete" },
    { name: "createCustomRole", invoke: (e) => e.createCustomRole({} as never), pathEnds: "/admin/custom-roles" },
    { name: "deleteCustomRole", invoke: (e) => e.deleteCustomRole("auditor"), pathEnds: "/admin/custom-roles/delete" },
    { name: "assignCustomRole", invoke: (e) => e.assignCustomRole("person@example.com", "auditor"), pathEnds: "/admin/roles" },
    { name: "assignGroupCustomRole", invoke: (e) => e.assignGroupCustomRole("engineers", "auditor"), pathEnds: "/admin/group-roles" },
    { name: "rotateBreakGlass", invoke: (e) => e.rotateBreakGlass("one-shot-token", "age1breakglasspublic"), pathEnds: "/admin/keys/rotate" },
    { name: "setBreakGlassOnly", invoke: (e) => e.setBreakGlassOnly("one-shot-token"), pathEnds: "/admin/keys/break-glass-only" },
    { name: "retireBreakGlassToken", invoke: (e) => e.retireBreakGlassToken(), pathEnds: "/admin/policy/retire-break-glass-token" },
    { name: "unacceptPostureRisk", invoke: (e) => e.unacceptPostureRisk("check-1"), pathEnds: "/admin/posture/unaccept" },
    { name: "mintSupportCredential", invoke: (e) => e.mintSupportCredential("runs" as never), pathEnds: "/admin/support/credentials" },
    // The two dual-control APPROVE routes. Their sub carries a per-request ULID, so they can never be
    // STEPUP_SUBS members and the engine gates their PARSED action instead (router.ts). A reader checking
    // the Set alone would find nothing to check. Approve applies the change and is gated; reject only
    // discards a pending record and stays exempt in the engine, so it is deliberately not here.
    { name: "approveConfigChange", invoke: (e) => e.approveConfigChange("01JBCONFIGCHANGE00000000"), pathEnds: "/approve" },
    { name: "approveOwnerAction", invoke: (e) => e.approveOwnerAction("01JBOWNERACTION000000000"), pathEnds: "/approve" },
  ];
  for (const m of mutations) {
    const calls = await runMutation(m.name, m.invoke);
    ok(`${m.name}: made two requests (original + step-up retry)`, calls.length === 2);
    ok(`${m.name}: both requests hit ${m.pathEnds}`, calls.every((c) => c.path.endsWith(m.pathEnds)));
    ok(`${m.name}: the FIRST request carried NO step-up header`, calls[0]?.headers["x-downpipes-stepup"] === undefined);
    eq(`${m.name}: the RETRY carried the single-use step-up token`, calls[1]?.headers["x-downpipes-stepup"], STEPUP_TOKEN);
  }

  // THE BREAK-GLASS MASTER MUST SURVIVE THE RETRY. The generic loop above cannot assert this, and it is the
  // detail that decides whether gating restore() helps or hurts. The in-console break-glass restore hands
  // the browser-decapsulated per-run master on the x-downpipes-restore-master header, never in the body.
  // gatedFetch rebuilds the retry's headers from the SAME init with `new Headers(init.headers)`, so the
  // header rides the second attempt; a retry that dropped it would send a restore the engine cannot open,
  // which is a worse failure than the 401 this change removes. That key is lost with the tab, so there is
  // no second chance to get it right.
  {
    const engine = new EngineClient("https://engine.test");
    engine.onStepUpRequired = async () => STEPUP_TOKEN;
    const MASTER = "bWFzdGVyLTMyLWJ5dGVzLWZha2UtdmFsdWUtZm9yLXRlc3Q";
    const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } }, { status: 200, body: { ok: true } });
    await engine
      .restore({ runId: "01JBRESTORE00000000000000", confirm: true } as never, undefined, { restoreMasterB64: MASTER })
      .catch(() => undefined)
      .finally(restore);
    ok("break-glass restore: the ceremony ran and the call was retried", calls.length === 2);
    eq("break-glass restore: the FIRST request carried the master header", calls[0]?.headers["x-downpipes-restore-master"], MASTER);
    eq("break-glass restore: the RETRY still carries the master header", calls[1]?.headers["x-downpipes-restore-master"], MASTER);
    eq("break-glass restore: the RETRY also carries the step-up token", calls[1]?.headers["x-downpipes-stepup"], STEPUP_TOKEN);
  }

  // With NO ceremony wired, a step-up 401 is surfaced and there is NO retry.
  {
    const engine = new EngineClient("https://engine.test");
    const { calls, restore } = scriptFetch({ status: 401, body: { stepUpRequired: true } });
    let threw = false;
    await engine.setDestination(null).catch(() => { threw = true; }).finally(restore);
    ok("no ceremony wired: a step-up 401 does NOT retry (one request)", calls.length === 1);
    ok("no ceremony wired: the 401 surfaces to the caller", threw);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- DUAL CONTROL (202): the queued path is unchanged by the gatedFetch routing --");
  // ------------------------------------------------------------------------
  {
    const engine = new EngineClient("https://engine.test");
    // A 202 ownerActionQueued must still resolve to { status:"queued" }: gatedFetch only acts on a 401.
    const { restore } = scriptFetch({ status: 202, body: { ownerActionQueued: true, id: "oa-1", status: "pending" } });
    const res = await engine.setDestination(null).finally(restore) as { status: string; queued?: { id: string } };
    eq("setDestination: a 202 still resolves to status:queued", res.status, "queued");
    eq("setDestination: the queued owner-action id is carried through", res.queued?.id, "oa-1");
  }
  {
    const engine = new EngineClient("https://engine.test");
    const { restore } = scriptFetch({ status: 202, body: { ownerActionQueued: true, id: "oa-2", status: "pending" } });
    const res = await engine.createIdpConnection({} as never).finally(restore) as { status: string };
    eq("createIdpConnection: a 202 still resolves to status:queued", res.status, "queued");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- RESTORE OUTCOME: windowed labelled distinctly from a failure --");
  // ------------------------------------------------------------------------
  const base: RestoreResult = {
    ok: true, runId: "r1", mode: "applied", recordsVerified: 100, recordsRestored: 100,
    bytesRestored: 1024, isLatest: true, failures: [],
  };
  {
    // A clean, complete apply.
    const o = restoreOutcome(base);
    eq("clean apply: kind=clean", o.kind, "clean");
    ok("clean apply: not partial", o.partial === false);
    eq("clean apply: headline=applied", o.headline, "applied");
  }
  {
    // Records deliberately not written (a secrets record has no runtime write path, an incompleteness
    // marker is a sentinel rather than real bytes). The classifier used to ignore skipped[] entirely, so
    // this reported "clean" with an unexplained shortfall in the N-of-M line: the dry-run plan showed the
    // operator WHY each record would be skipped, and the receipt then dropped that at the exact moment the
    // apply made it real. Those records are in the archive and are not in the account.
    const o = restoreOutcome({ ...base, recordsRestored: 98, skipped: [{ name: "s1", reason: "secrets have no runtime write path" }, { name: "s2", reason: "the captured value is an incompleteness marker" }] });
    eq("skipped apply: kind=skipped", o.kind, "skipped");
    ok("skipped apply: partial (it is NOT a clean full restore)", o.partial === true);
    eq("skipped apply: count carried for the receipt", o.skippedCount, 2);
    eq("skipped apply: headline names the outstanding records", o.headline, "applied, with records outstanding");
    ok("skipped apply: remaining stays 0 (that field means beyond-the-window, not skipped)", o.remaining === 0);
  }
  {
    // Precedence: a failure is the larger fact, so skips must not mask it.
    const o = restoreOutcome({ ...base, recordsRestored: 90, failures: [{ name: "k", reason: "denied" }], skipped: [{ name: "s1", reason: "secrets have no runtime write path" }] });
    eq("failure outranks skipped", o.kind, "failed");
  }
  {
    // And an intentional window outranks skips too.
    const o = restoreOutcome({ ...base, recordsRestored: 50, complete: false, skipped: [{ name: "s1", reason: "secrets have no runtime write path" }] });
    eq("windowed outranks skipped", o.kind, "windowed");
  }
  {
    // An empty skipped[] is not a skip. Guards against the count being read as a presence check.
    const o = restoreOutcome({ ...base, skipped: [] });
    eq("empty skipped[] stays clean", o.kind, "clean");
    ok("empty skipped[] is not partial", o.partial === false);
  }
  {
    // An apply with per-record failures: failed (NEVER windowed).
    const o = restoreOutcome({ ...base, recordsRestored: 90, failures: [{ name: "k", reason: "denied" }] });
    eq("failed apply: kind=failed", o.kind, "failed");
    ok("failed apply: partial", o.partial === true);
    eq("failed apply: headline=applied with failures", o.headline, "applied with failures");
  }
  {
    // An apply ok:false top-level: failed.
    const o = restoreOutcome({ ...base, ok: false, recordsRestored: 0, reason: "aborted" });
    eq("ok:false apply: kind=failed", o.kind, "failed");
  }
  {
    // The intentional windowed-apply case (complete:false, no failures). Distinct from a failure.
    const o = restoreOutcome({ ...base, recordsRestored: 50, complete: false });
    eq("windowed apply: kind=windowed", o.kind, "windowed");
    ok("windowed apply: partial", o.partial === true);
    eq("windowed apply: headline=applied (windowed)", o.headline, "applied (windowed)");
    eq("windowed apply: title=Restore applied (windowed)", o.title, "Restore applied (windowed)");
    eq("windowed apply: remaining beyond the window = verified - restored", o.remaining, 50);
  }
  {
    // FIDELITY: a restore that wrote every record but did not carry it across in full is NOT clean.
    // Each of these fields exists in the engine because the shortfall used to be silent, and the console
    // was not declaring any of them, so the evidence arrived on the wire and was discarded at the type
    // boundary while this classifier went on returning "clean" with a success tick.
    const shed = restoreOutcome({ ...base, metadataFieldsDropped: { cacheExpiry: 12 } });
    eq("dropped metadata: kind=reduced, not clean", shed.kind, "reduced");
    ok("dropped metadata: partial", shed.partial === true);
    ok("dropped metadata: the shortfall NAMES the field and the count", shed.shortfalls.some((x) => x.includes("cacheExpiry") && x.includes("12")));

    const d1 = restoreOutcome({ ...base, d1SchemaObjectsFiltered: 5 });
    eq("filtered D1 schema objects: kind=reduced", d1.kind, "reduced");
    ok("filtered D1 schema objects: named", d1.shortfalls.some((x) => x.includes("5") && /index/i.test(x)));

    const media = restoreOutcome({ ...base, mediaFaults: { upload: 3 } });
    eq("media faults: kind=reduced", media.kind, "reduced");

    // A FAILURE still outranks a fidelity shortfall: the two are different problems and the worse one
    // must not be masked by the milder label.
    const both = restoreOutcome({ ...base, failures: [{ name: "k", reason: "denied" }], metadataFieldsDropped: { cacheExpiry: 1 } });
    eq("failures outrank a fidelity shortfall", both.kind, "failed");
    ok("but the shortfall is still reported alongside the failure", both.shortfalls.length === 1);

    // And a full-fidelity restore must stay clean, or every restore would carry a warning.
    ok("a full-fidelity restore has no shortfalls", restoreOutcome(base).shortfalls.length === 0);
    ok("empty shed maps do not count as a shortfall", restoreOutcome({ ...base, metadataFieldsDropped: {}, mediaFaults: {} }).kind === "clean");
  }
  {
    // A windowed apply whose remainder is not derivable (verified <= restored) still classes windowed,
    // with remaining clamped to 0 so the copy degrades to the generic wording rather than a negative count.
    const o = restoreOutcome({ ...base, recordsRestored: 100, complete: false });
    eq("windowed apply (no derivable remainder): kind=windowed", o.kind, "windowed");
    eq("windowed apply (no derivable remainder): remaining clamped to 0", o.remaining, 0);
  }
  {
    // The engine's AUTHORITATIVE outOfWindow is preferred over the derivation. For a pure maxRecords
    // window the two agree (verified 100 - restored 50 = 50 = outOfWindow 50).
    const o = restoreOutcome({ ...base, recordsRestored: 50, complete: false, windowed: true, outOfWindow: 50 });
    eq("windowed apply: remaining = authoritative outOfWindow when present", o.remaining, 50);
  }
  {
    // When records are skipped for NON-window reasons the engine's outOfWindow diverges from the
    // derivation (verified 100 - restored 50 = 50, but only 30 are truly beyond the window). The
    // console must report the engine's 30, not the derived 50.
    const o = restoreOutcome({ ...base, recordsRestored: 50, complete: false, windowed: true, outOfWindow: 30 });
    eq("windowed apply: authoritative outOfWindow beats the derivation when they diverge", o.remaining, 30);
  }
  {
    // outOfWindow:0 (explicit) is honoured (not treated as absent): remaining is 0, never the derived 50.
    const o = restoreOutcome({ ...base, recordsRestored: 50, complete: false, outOfWindow: 0 });
    eq("windowed apply: explicit outOfWindow:0 honoured over the derivation", o.remaining, 0);
  }
  {
    // An older engine that omits outOfWindow still derives from verified - restored (backward compatible).
    const o = restoreOutcome({ ...base, recordsRestored: 70, complete: false });
    eq("windowed apply (outOfWindow absent): falls back to the derivation", o.remaining, 30);
  }
  {
    // An ABSENT complete flag (an engine build that does not emit it) reads as a complete apply (prior
    // behaviour preserved): clean, never windowed.
    const o = restoreOutcome({ ...base });
    eq("absent complete flag: reads as clean (backward compatible)", o.kind, "clean");
  }
  {
    // complete:true with no failures is clean (the explicit complete signal).
    const o = restoreOutcome({ ...base, complete: true });
    eq("complete:true apply: kind=clean", o.kind, "clean");
  }
  {
    // A windowed flag NEVER overrides a real failure: failures take precedence (failed, not windowed).
    const o = restoreOutcome({ ...base, recordsRestored: 40, complete: false, failures: [{ name: "k", reason: "denied" }] });
    eq("windowed + failures: a failure dominates (kind=failed)", o.kind, "failed");
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

void main();
