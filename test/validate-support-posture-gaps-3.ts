// Validates the client diagnostics ring's support-pack coverage: for each state below, the ring has to tell it
// apart from its neighbour, not merely record that something happened.
//
// THE BAR IS THE DISCRIMINATION TEST. A recorder, a caller and a projection are NOT enough. For every case
// below the suite ENUMERATES the states that would otherwise be indistinguishable, DRIVES each one, and
// asserts they produce DIFFERENT ROWS. Asserting merely that "a row was recorded" proves the plumbing works
// without proving the states it carries are actually told apart.
//
// The coalescing key is the other half of the bar. A field that discriminates two outcomes and is left OUT of
// the ring's tuple key discriminates NOTHING: the two rows collapse into one and the first written wins the
// class. So every assertion here counts ROWS IN THE RING (via snapshot(), which is what the pack carries),
// never a value a recorder was handed.
//
// The no-custody assertions are not decoration either. The pack is SEALED and a support engineer opens it, so a
// leak here is a leak into an artefact the customer signed. Several of these paths handle attacker-influenced or
// key-adjacent strings (a CSP blocked-uri on an injection attempt, a tampered custom-role capability, a
// WebCrypto error out of a key ceremony), and the wire is asserted to carry none of them.
//
// Coverage:
//   - a refused dual-control approve or reject says WHY: the ENGINE'S OWN 403 is the authority axis (never a
//         lifecycle label off a caller-scoped listing), an ARMED second-owner approval is a decision, the
//         break-glass token has its own member, and a 2xx whose body would not parse is an engine that ANSWERED
//   - a custom-role delete says how many grants it silently downgraded, and the zero case is a row too
//   - console/engine vocabulary skew is recorded per FAMILY: an unknown capability, an unknown landing, an
//         unknown owner-action kind, and ONE FAMILY PER TOKEN-SOURCE CAPABILITY the engine did not advertise, so
//         a rolled-back engine offering a strict SUBSET is no longer byte-identical to a healthy one
//   - a corrupt recency stamp no longer reads as healthy, and the three assurances are three rows
//   - a CSP block says which directive and which class, so the console's own stale chunk and a third-party
//         injection are not the same row; an extension-origin block is FILTERED, not recorded
//   - the offboarding IdP-cleanup attestation records BOTH endings, so an absent proof is a fact
//   - a mis-minted licence band, an unparseable notAfter, a corrupt estate figure and a malformed artefact
//         stamp are four rows, not one silent card
//   - a paste that lost part of itself says which paste, how many were kept and how many went
//   - a broken wizard/deep-link hand-off says WHICH, driven through the REAL wizard and the REAL editor, and
//         a spec the wizard SENT is not the same row as a create the editor refused without asking the engine
//   - a browser-side ceremony step says which step, whether it worked, and coarsely why not
//   - a masked engine contract break on the Overview is told apart from ordinary absence
//
// Run with `node test/validate-support-posture-gaps-3.ts`.

import { installDomShim, qs, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

import {
  ceremonyFaultFor,
  cspBlockedFor,
  cspDirectiveFor,
  packPayload,
  recordAdminWrite,
  recordCeremonyStep,
  recordContractSkew,
  recordCspViolation,
  recordHandoffDropped,
  recordInputDropped,
  recordOwnerActionRefusal,
  recordRoleDeleteImpact,
  recordWireAnomaly,
  reset as resetRing,
  setActiveScreen,
  snapshot,
} from "../src/lib/client-diag/ring.ts";
import { noteCspViolation, notePrepaintBlocked } from "../src/lib/client-diag/window-faults.ts";
import { refusalCode, ownerActionFateFromListing, } from "../src/screens/owner-actions.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { sourcesDownpipesScreen } from "../src/screens/sources-downpipes.ts";
import { tokenSourceSkewFamilies } from "../src/lib/token-source.ts";
import { deleteCustomRole } from "../src/lib/api/client-rbac.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { approveOwnerAction } from "../src/lib/api/client-owner-action.ts";
import { isPendingChangeBody, isPendingResult } from "../src/lib/api/types/config-changes.ts";
import { observedCostSeed } from "../src/screens/overview/fleet-data.ts";
import { minutesToTime } from "../src/lib/schedule.ts";
import { runBytes } from "../src/screens/runs/helpers.ts";
import { prefillFromQuery } from "../src/screens/sources-downpipes/editor.ts";
import type { Caller } from "../src/lib/api/types/who.ts";
import type { RunHistoryEntry, SourceDiscovery } from "../src/api.ts";
import { CLIENT_DIAG_KINDS } from "../src/lib/client-diag/vocab.ts";
import { pemBlocksIntended, splitPems } from "../src/screens/idp-connections/shared.ts";
import { inventoryLinesDropped } from "../src/screens/security-centre/coverage.ts";
import { isKnownOwnerActionKind } from "../src/lib/owner-actions.ts";
import { isKnownLandingScreen } from "../src/lib/view-mode.ts";
import { unknownCapabilityCount } from "../src/lib/identity-custom-roles.ts";
import { protectionStatement, type DestinationDescriptor } from "../src/lib/protection-statement.ts";
import { newestDrill } from "../src/screens/overview/shared.ts";
import type { CustomRole, Downpipe, DownpipeState } from "../src/api.ts";
import type { OwnerAction } from "../src/lib/api/types/owner-actions.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

// The nav bridge is stubbed so a wizard/editor Create that ends in navigate() is captured, not executed.
installNav({
  navigate: () => {},
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  signOut: () => {},
});

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}
function eq<T>(label: string, a: T, b: T): void {
  const cond = JSON.stringify(a) === JSON.stringify(b);
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures += 1;
}

// rows() is the ring AS THE PACK WOULD CARRY IT. Every discrimination assertion goes through this, because the
// TUPLE KEY is what decides whether two states are two rows, and a field outside that key tells apart nothing:
// a recorder can be handed a perfect discriminator and the coalescer will destroy it on the way to the pack.
function rows(): ReturnType<typeof snapshot>["records"] {
  return snapshot().records;
}
function wire(): string {
  return JSON.stringify(packPayload());
}
// err builds a thrown engine error in the SHAPE engineFetch actually throws: the status is the trailing token of
// the message ("<verb>: <status>"), which is what errorStatus() keys on. Building it any other way would test a
// mapper against an error the console never sees.
function _err(status: number): Error {
  return new Error(`approve owner action: ${status}`);
}

// realRefusal produces the error the CONSOLE ACTUALLY SEES, by driving the REAL owner-action client through the
// REAL Transport against a response the engine really sends. Nothing here is hand-written: the message, its
// marker and its trailing status are whatever client-transport.ts composes, so the classifier is proved only
// against statuses the engine can actually produce on this route.
async function realRefusal(status: number, body: unknown, contentType = "application/json"): Promise<unknown> {
  const saved = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } }),
    )) as typeof fetch;
  try {
    await approveOwnerAction(new Transport("http://engine.test"), "oa1");
    throw new Error("realRefusal: the call was expected to throw and did not");
  } catch (e) {
    return e;
  } finally {
    globalThis.fetch = saved;
  }
}

// ---- the vocabulary itself ---------------------------------------------------------------------------------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the bare block is this validator's section marker, not dead scope
{
  console.log("\nthe six new kinds exist (a kind the ring does not know is a row it silently drops)");
  for (const k of ["owner-action-refusal", "role-delete-impact", "csp-violation", "input-dropped", "handoff-dropped", "ceremony-step"]) {
    ok(`kind ${k} is in the console vocabulary`, (CLIENT_DIAG_KINDS as readonly string[]).includes(k));
  }
}

// ---- a refused dual-control approve or reject says WHY ------------------------------------------------
{
  console.log("\n'I proposed a destination change a fortnight ago and it just vanished; nobody rejected it'");
  resetRing();
  setActiveScreen("security");

  // THIS DRIVES refusalCode, THE CLASSIFIER THAT ACTUALLY RUNS IN THE BROWSER, not the recorder.
  //
  // Handing recordOwnerActionRefusal five LITERAL codes and asserting five rows come back only proves the ring
  // can carry five strings; it does not prove the console is able to PRODUCE them. `self-approval` needs its own
  // producer on the approve path: refusalCode re-derives "am I the proposer" from the SAME mount-time identity
  // that had to have been null for the Approve button to render, or every genuine maker-checker refusal files as
  // a generic engine-refused instead.
  const _action = (proposer: string, subject: string | null): OwnerAction =>
    ({ id: "oa1", kind: "dest-set", status: "pending", proposedBy: proposer, proposedBySubject: subject, proposedAt: "2026-07-01T00:00:00Z", summary: "s" }) as unknown as OwnerAction;
  const owner = (email: string, subject: string): Caller =>
    ({ email, subject, role: "owner", method: "access" }) as unknown as Caller;

  // THE FOUR 403s. "Only an AuthError becomes a 403, and on these routes the AuthError is the OWNER gate, so a
  // 403 IS 'you may not approve'" is not a safe premise: a hand-written body ({ error: "not an owner" }) is not
  // one the engine sends. The engine answers 403 FOUR ways on POST /admin/owner-actions/<id>/approve, and only
  // the first is about the caller's authority. Every body below is the BYTE-EXACT body its producer really
  // sends, and every error is composed by the REAL transport driving the REAL approveOwnerAction against it:
  //
  //   capability  engine src/admin/router-core.ts gate(caller,"keys.ceremony")
  //   authz       engine src/sched/scheduler-do.ts, the AuthError funnel: the PUBLIC body is the bare "forbidden"
  //               (anti-enumeration). On an approve the live producer is a PROPOSER who lost owner between
  //               propose and approve, whom executeOwnerActionDO re-resolves and refuses -- the CALLER is a good
  //               second owner, so a not-owner row about them is a lie.
  //   csrf        engine src/admin/router.ts, before the route dispatch, for EVERY cookie-borne non-GET request:
  //               an engine deployed with CONSOLE_ORIGIN unset 403s every save in the whole console.
  //   edge        a Cloudflare WAF block page (error 1020). The engine never saw the request.
  const engine403 = await realRefusal(403, { error: "forbidden", required: "keys.ceremony", have: "operator" });
  const engine403Authz = await realRefusal(403, { error: "forbidden" });
  const engine403Csrf = await realRefusal(403, { error: "csrf origin check failed" });
  const engine403Waf = await realRefusal(403, "<html><head><title>Attention Required! | Cloudflare</title></head><body>error 1020</body></html>", "text/html");
  const engine400 = await realRefusal(400, { error: "owner action has expired" });

  const live = (id: string, expiresAt: string, status = "pending"): OwnerAction =>
    ({ id, kind: "dest-set", status, proposedBy: "bob@acme.example", proposedBySubject: "sub-bob", proposedAt: "2026-07-01T00:00:00Z", expiresAt, summary: "s" }) as unknown as OwnerAction;
  const NOW = Date.parse("2026-07-13T00:00:00Z");
  const past = live("oa1", "2026-07-12T00:00:00Z");
  const future = live("oa1", "2026-07-14T00:00:00Z");
  const armed = live("oa1", "2026-07-14T00:00:00Z", "approved");
  const mine = (expiresAt: string): OwnerAction => live("oa1", expiresAt);

  // (a) SELF-APPROVAL, the gap's real ticket, and it is a 400. whoami had not resolved when the card rendered, so
  //     the screen offered Approve on the caller's OWN proposal; by click time the identity HAS resolved. The
  //     LISTING is the one the engine would serve an owner: the action is still there, still pending.
  setCaller(owner("bob@acme.example", "sub-bob"));
  const selfCode = refusalCode("owner-action-approve", mine("2026-07-14T00:00:00Z"), engine400, [future], NOW);
  eq("a caller approving their OWN proposal is self-approval", selfCode, "self-approval");

  // (b) NOT-OWNER IS THE CAPABILITY GATE'S 403, AND IT IS NEVER A LIFECYCLE LABEL. THE DEMOTED OWNER is the live
  //     producer: the inbox repaints only when the (id, status) signature changes, so the card survives the
  //     demotion and their Approve still fires, and the route gate turns it down naming the capability it wanted.
  //     Their scoped listing no longer contains the action either, and that emptiness must not read as
  //     `already-decided` -- "a second owner rejected or ran it" -- about an action nobody had touched.
  //
  //     A PURE VIEWER IS NOT TESTED HERE, AND THAT IS DELIBERATE: canRequesterSeeOwnerAction hides other
  //     people's proposals, so a viewer deep-linking the inbox gets an EMPTY listing, no card renders and no
  //     Approve button exists. Asserting the classifier over a state the product cannot reach would be
  //     self-certifying and proves nothing about the real screen.
  setCaller({ email: "dave@acme.example", subject: "sub-dave", role: "operator", method: "access" } as unknown as Caller);
  eq("an owner DEMOTED with the card still on screen is not-owner, not a decision nobody made", refusalCode("owner-action-approve", future, engine403, [], NOW), "not-owner");

  // (b2) THE DO'S OWN AUTHZ FUNNEL, AND IT IS NOT ABOUT THIS CALLER. Ann is a real, current second owner, and the
  //      engine still 403s her approve: executeOwnerActionDO replays the PROPOSER's action and re-resolves the
  //      PROPOSER's live authority, so a proposer demoted between propose and approve is refused with an AuthError
  //      -- a bare { error: "forbidden" }, no capability named. Filed as not-owner it sends support to re-grant
  //      owner to a person who already has it, and the proposer (who does not) is never looked at.
  setCaller(owner("ann@acme.example", "sub-ann"));
  eq(
    "the engine's unnamed authz refusal is NOT the caller's authority, and no longer wears not-owner",
    refusalCode("owner-action-approve", future, engine403Authz, [future], NOW),
    "engine-authz-refused",
  );

  // (b3) THE CSRF-ORIGIN 403: NOBODY'S AUTHORITY IS IN QUESTION AND THE WHOLE CONSOLE IS 403ing. A deploy that
  //      dropped CONSOLE_ORIGIN 403s EVERY cookie-borne mutation before the route is even dispatched. As
  //      not-owner it was a governance fault against an owner, with the console-wide outage invisible.
  eq(
    "the engine's CSRF-origin refusal is the perimeter, not the person",
    refusalCode("owner-action-approve", future, engine403Csrf, [future], NOW),
    "engine-csrf",
  );

  // (b4) THE WAF BLOCK PAGE: the engine NEVER SAW the request, so not even its own auth signals can contradict a
  //      not-owner row. The remedy is the customer's edge and nothing in the pack could say so.
  eq(
    "a 403 carrying no refusal shape this engine emits is an edge block, not a demotion",
    refusalCode("owner-action-approve", future, engine403Waf, [future], NOW),
    "edge-blocked",
  );

  // (c) IDENTITY-UNRESOLVED: whoami never resolved, and the engine answered its ordinary 400. The console holds NO
  //     identity, so it must not claim the caller is not an owner: that asserts a fact it never established and
  //     sends support hunting a permissions problem that may not exist. (A 403 is settled by its body shape BEFORE
  //     the identity is consulted, because three of the four 403s are not about the identity at all.)
  setCaller(null);
  eq("an unresolved identity says so, and does NOT masquerade as not-owner", refusalCode("owner-action-approve", future, engine400, [], NOW), "identity-unresolved");

  // (d) BARE TOKEN: the ADMIN_TOKEN break-glass. canApproveOwnerAction refuses it by design (dual control needs
  //     an attributable approver, reasonCode "bare-token"), the console HOLDS the fact before it calls (a caller
  //     with a null email), and without this class it would be byte-identical to the honest residual.
  setCaller({ email: null, subject: null, role: "owner", method: "token" } as unknown as Caller);
  eq("the break-glass token cannot be a second pair of eyes, and the row says so", refusalCode("owner-action-approve", future, engine400, [future], NOW), "bare-token");

  // (e) ENGINE-REFUSED: a resolved, attributable OWNER, someone else's action, still live in their own inbox, and
  //     the engine still said no with a 400. The honest residual.
  setCaller(owner("ann@acme.example", "sub-ann"));
  eq("an owner refused on a live action they did not propose is the honest residual", refusalCode("owner-action-approve", future, engine400, [future], NOW), "engine-refused");

  // (f) EXPIRED and ALREADY-DECIDED, AND THEY ARE NOT DECIDED BY A STATUS. Asserting a 409 or a 404 mapped to
  // `terminal-state` would test a classifier against inputs the product cannot produce: the engine collapses
  // expired, already-decided, bare-token and self-approval into ONE 400, so the fate is read off an OWNER'S OWN
  // re-read of the inbox, which is the only place it exists.
  eq("gone from an owner's inbox with its expiry passed is EXPIRED", ownerActionFateFromListing(past, [], NOW), "expired");
  eq("gone with its expiry still ahead is a DECISION a second owner made", ownerActionFateFromListing(future, [], NOW), "decided");
  eq("still listed and pending is a live refusal", ownerActionFateFromListing(future, [future], NOW), "still-pending");
  // THE ARMED APPROVAL. The engine LISTS an approved record (the filter keeps pending|approved: it is armed for
  // the proposer's one-shot re-submit), so the re-read hands the console live.status === "approved" -- a second
  // owner's decision, in the engine's own words. Reading only PRESENCE and EXPIRY (as this did) called it
  // still-pending and filed the approve race in the residual.
  eq("a listed record a second owner has APPROVED is a decision, not a pending action", ownerActionFateFromListing(future, [armed], NOW), "decided");
  eq("a failed re-read establishes NOTHING about the fate", ownerActionFateFromListing(past, null, NOW), "unknown");
  eq(
    "an expiresAt that will not parse is a shape-gate miss, not a decision nobody made",
    ownerActionFateFromListing(live("oa1", "not-a-date"), [], NOW),
    "unknown",
  );

  setCaller(owner("ann@acme.example", "sub-ann"));
  eq("the expired proposal is its own code, off the ENGINE'S REAL 400", refusalCode("owner-action-approve", past, engine400, [], NOW), "expired");
  eq("a second owner having decided it is a different code, off the SAME 400", refusalCode("owner-action-approve", future, engine400, [], NOW), "already-decided");
  eq("an ARMED approval is a decision too, and no longer the residual", refusalCode("owner-action-approve", future, engine400, [armed], NOW), "already-decided");
  eq("a throw with no status never got an answer from an engine", refusalCode("owner-action-approve", future, new TypeError("Failed to fetch"), null, NOW), "unreachable");
  // THE 200 THAT DID NOT PARSE. The engine ANSWERED and, on a DO-executed kind, HAS ALREADY REPOINTED THE
  // DESTINATION; only the reply was mangled. The real transport composes this throw ("approve owner action: 200"),
  // errorStatus narrows to 400-599 so it carried no status, and it was landing in `unreachable` -- "nothing
  // establishes that any engine saw it, and no engine-side record of it can exist" -- which sends support away
  // from an approve that ran.
  eq(
    "a 2xx whose body will not parse is an engine that ANSWERED, never an unreachable one",
    refusalCode("owner-action-approve", future, await realRefusal(200, "<<truncated", "application/json"), null, NOW),
    "answer-unreadable",
  );
  eq(
    "a lapsed Cloudflare Access session is the ordinary overnight tab and records NO row",
    refusalCode("owner-action-approve", future, await realRefusal(302, "<html>Cloudflare Access login</html>", "text/html"), null, NOW),
    null,
  );

  // SELF-APPROVAL IS GATED TO THE APPROVE ROUTE. Reject deliberately does NOT require maker != checker: a
  // proposer withdrawing their own action is the designed use of it, so a classifier that fired self-approval
  // there would file a false governance fault against a legitimate state.
  setCaller(owner("bob@acme.example", "sub-bob"));
  const withdrawCode = refusalCode("owner-action-reject", mine("2026-07-14T00:00:00Z"), engine400, [future], NOW);
  ok("a refused WITHDRAW of your own proposal is never labelled a self-approval violation", withdrawCode !== "self-approval");

  // AND THE ROWS DISCRIMINATE. Twelve states, twelve distinct codes, driven through the real classifier over the
  // errors the real transport composes from the real engine bodies, and counted in the ring as the pack would
  // carry them. THE FOUR 403s ARE FOUR ROWS: coalesced into one, three of the four would misname the cause.
  resetRing();
  setActiveScreen("security");
  const note = (a: OwnerAction, e: unknown, listing: OwnerAction[] | null): void => {
    const c = refusalCode("owner-action-approve", a, e, listing, NOW);
    if (c !== null) recordOwnerActionRefusal("owner-action-approve", c);
  };
  setCaller(owner("bob@acme.example", "sub-bob"));
  note(mine("2026-07-14T00:00:00Z"), engine400, [future]); // self-approval
  setCaller({ email: "dave@acme.example", subject: "sub-dave", role: "operator", method: "access" } as unknown as Caller);
  note(future, engine403, []); // not-owner (the demoted owner, the capability gate naming `required`)
  setCaller(owner("ann@acme.example", "sub-ann"));
  note(future, engine403Authz, [future]); // engine-authz-refused (the proposer lost owner; Ann is fine)
  note(future, engine403Csrf, [future]); // engine-csrf (CONSOLE_ORIGIN unset: every save in the console 403s)
  note(future, engine403Waf, [future]); // edge-blocked (a WAF page; the engine never saw it)
  setCaller(null);
  note(future, engine400, []); // identity-unresolved
  setCaller({ email: null, subject: null, role: "owner", method: "token" } as unknown as Caller);
  note(future, engine400, [future]); // bare-token
  setCaller(owner("ann@acme.example", "sub-ann"));
  note(future, engine400, [future]); // engine-refused
  note(past, engine400, []); // expired
  note(future, engine400, [armed]); // already-decided (the armed approval)
  note(future, new TypeError("Failed to fetch"), null); // unreachable
  note(future, await realRefusal(200, "<<truncated", "application/json"), null); // answer-unreadable
  const approveRows = rows().filter((r) => r.kind === "owner-action-refusal");
  eq("twelve refusal states are TWELVE rows, not one", approveRows.length, 12);
  eq(
    "and each carries its own code",
    approveRows.map((r) => r.ownerActionCode).sort(),
    [
      "already-decided", "answer-unreadable", "bare-token", "edge-blocked", "engine-authz-refused", "engine-csrf",
      "engine-refused", "expired", "identity-unresolved", "not-owner", "self-approval", "unreachable",
    ],
  );

  // The ROUTE is a discriminator in its own right and must be in the tuple key: an expired refusal on approve
  // and one on reject are different tickets (the second is a proposer going to withdraw their own proposal and
  // finding it already dead). Without adminOp in the key they are ONE row.
  recordOwnerActionRefusal("owner-action-reject", "expired");
  const terminal = rows().filter((r) => r.ownerActionCode === "expired");
  eq("an expired refusal on APPROVE and on REJECT are two rows", terminal.length, 2);
  eq("told apart by the route, not by prose", terminal.map((r) => r.adminOp).sort(), ["owner-action-approve", "owner-action-reject"]);

  // A repeat of the SAME refusal coalesces into a count rather than a new row.
  setCaller(owner("bob@acme.example", "sub-bob"));
  note(mine("2026-07-14T00:00:00Z"), engine400, [future]);
  note(mine("2026-07-14T00:00:00Z"), engine400, [future]);
  const selfRows = rows().filter((r) => r.ownerActionCode === "self-approval");
  eq("three attempts at the same refusal are one row", selfRows.length, 1);
  ok("carrying the repeat count", (selfRows[0]?.count ?? 0) >= 3);

  ok("no engine prose, action id, proposer email or subject reaches the wire", !/acme\.example|Failed to fetch|sub-bob|oa1/.test(wire()));
  setCaller(null);

  // The half of the inbox: an owner-action kind this build has no label for renders its RAW id in a heading
  // asking an owner to authorise it. The predicate is what lets the screen record it.
  ok("a known owner-action kind is recognised", isKnownOwnerActionKind("dest-set"));
  ok("a kind from a newer engine is not", !isKnownOwnerActionKind("quantum-repoint"));
}

// ---- a custom-role delete says how many grants it downgraded, AND whether it happened ------------------
{
  console.log("\n'Bob lost access to restores after we tidied up old roles'");
  resetRing();
  setActiveScreen("access");

  // THIS DRIVES THE REAL API CLIENT against a real 202, because the risk sits IN the client read.
  //
  // custom-role-delete is change-control gated. With the gate armed the engine QUEUES it and writes NOTHING: the
  // role still exists and nobody is floored. A client that reads the response with a plain `!r.ok` test would
  // treat the queued 202 as ok and RESOLVE it as a successful delete, recording a four-person downgrade for a
  // proposal an approver may go on to REJECT. deleteCustomRole instead recognises the queued shape explicitly.
  //
  // ENGINE_GATED_CONFIG_202 IS THE BODY THE ENGINE ACTUALLY SENDS, copied from its one gated-config 202:
  //
  //     engine src/sched/scheduler-do.ts
  //     return this.jsonStatus({ queued: true, id: p.id, status: p.status, contentHash: p.contentHash }, 202);
  //
  // No engine route has ever emitted `{ pending: true, id }`, so the guard is asserted to REJECT that fabricated
  // shape as well as accept the real one: a guard written to a shape the engine never sends would return false
  // for every real 202, take the degrade-to-applied fall-through, and leave the deferred branch dead at every one
  // of its call sites while a test built on the same invention stayed green.
  //
  // So the fixture is pinned to the producer, and the fabricated body is asserted to be REJECTED, which is what
  // keeps that failure mode closed.
  const ENGINE_GATED_CONFIG_202 = { queued: true, id: "chg-1", status: "pending", contentHash: "sha256:abc" };
  ok(
    "the guard accepts the body the ENGINE sends ({queued,id,status,contentHash})",
    isPendingChangeBody(ENGINE_GATED_CONFIG_202),
  );
  ok(
    "the guard REJECTS the fabricated {pending:true} body no engine route emits",
    !isPendingChangeBody({ pending: true, id: "chg-1" }),
  );
  const transportFor = (status: number, body: unknown): Transport => {
    const t = new Transport("http://engine.test");
    (globalThis as { fetch?: unknown }).fetch = async (): Promise<Response> =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return t;
  };

  // STATE C: the gate is OFF. The engine really deleted the role, and four grants really fell to viewer.
  const appliedRes = await deleteCustomRole(transportFor(200, { deleted: true }), "old-role");
  ok("a 200 delete reads as APPLIED", !isPendingResult(appliedRes));
  recordRoleDeleteImpact(4, isPendingResult(appliedRes) ? "queued-for-approval" : "applied");

  // STATE D: the gate is ON. The engine QUEUED it, wrote nothing, and the role still exists. Nobody is floored.
  const pendingRes = await deleteCustomRole(transportFor(202, ENGINE_GATED_CONFIG_202), "old-role");
  ok("a 202 delete reads as PENDING, and no longer as a successful delete", isPendingResult(pendingRes));
  recordRoleDeleteImpact(4, isPendingResult(pendingRes) ? "queued-for-approval" : "applied");

  const impact = rows().filter((r) => r.kind === "role-delete-impact");
  eq("an APPLIED delete and a QUEUED one are TWO rows, not one", impact.length, 2);
  eq(
    "told apart by the fate, which is in the tuple key (outside it they coalesce and the count lies)",
    impact.map((r) => r.deleteFate).sort(),
    ["applied", "queued-for-approval"],
  );
  ok("and the applied row is the ONLY one that asserts four people lost access", impact.find((r) => r.deleteFate === "applied")?.count === 4);

  // The ZERO case is a row too: a tidy-up that broke nobody and one that downgraded four people must not both
  // be an absence in the pack.
  resetRing();
  setActiveScreen("access");
  recordRoleDeleteImpact(0, "applied");
  const zero = rows().filter((r) => r.kind === "role-delete-impact");
  eq("a delete that affected NOBODY is still a row", zero.length, 1);
  eq("carrying a count of zero, which is the fact", zero[0]?.count, 0);

  ok("no email, subject or role name reaches the wire", !/@|old-role|chg-1/.test(wire()));
}

// ---- console/engine vocabulary skew is recorded per family ----------------------------------------------
{
  console.log("\n'our Workers source disappeared after the update'");
  resetRing();
  setActiveScreen("overview");

  // THIS DRIVES tokenSourceSkewFamilies, THE REAL PREDICATE, against the discovery responses the ENGINE actually
  // returns across its own history. Two failure modes matter here and both are pinned:
  //
  //   NOISE from testing the capability flags ALONE: the engine's no-token branch returns none of them, so
  //   every operator on an account that had simply never stored a read-only Cloudflare token (the OPT-IN default,
  //   i.e. the healthy majority) would stamp "version skew" into the sealed pack on every mount of Add a source.
  //
  //   BLINDNESS from firing only when the engine advertised NOT ONE capability. The four flags landed on four
  //   different dates, so every engine build in between advertises a strict SUBSET -- and a subset is not zero.
  //   An engine offering cf-config but not Workers is exactly what an engine ROLLBACK lands on, and exactly the
  //   ticket this predicate exists for ("our Workers source disappeared after the update"), and a predicate keyed
  //   on "zero capabilities" produces NO ROW AT ALL for it: byte-identical in the pack to a healthy, current
  //   engine. Only a two-day slice of engine history would ever have recorded.
  //
  // So the discriminator is WHICH capability is missing, one family per capability, and fieldFamily is part
  // of the ring's tuple key so they cannot coalesce.
  const disco = (over: Record<string, unknown>): SourceDiscovery =>
    ({ bound: { kv: [], r2: [], d1: [], secrets: [] }, ...over }) as unknown as SourceDiscovery;
  const surfaces = [{ id: "dns_records", label: "DNS", category: "dns", scope: "zone" }];
  const currentEngineNoToken = disco({ tokenPresent: false });
  const currentEngineWithToken = disco({ tokenPresent: true, cfConfigSurfaces: surfaces, workersSupported: true, streamSupported: true, imagesSupported: true });
  const engineZeroFlags = disco({ tokenPresent: true }); // 11-13 Jun: tokenPresent shipped, no capability had
  const engineCfConfigOnly = disco({ tokenPresent: true, cfConfigSurfaces: surfaces }); // 13-18 Jun
  const engineCfConfigWorkers = disco({ tokenPresent: true, cfConfigSurfaces: surfaces, workersSupported: true }); // 18-20 Jun
  const enginePreAccountTier = disco({}); // older than tokenPresent itself: the field is ABSENT, not false

  eq("a CURRENT engine with no discovery token is silent (the opt-in default, and it cried wolf)", tokenSourceSkewFamilies(currentEngineNoToken), []);
  eq("a CURRENT engine WITH a token advertises every source, so it is silent too", tokenSourceSkewFamilies(currentEngineWithToken), []);
  eq("a FAILED discovery read is its own state and records nothing here", tokenSourceSkewFamilies(undefined), []);
  eq(
    "an engine advertising NOTHING names all four capabilities",
    tokenSourceSkewFamilies(engineZeroFlags),
    ["token-source-cf-config", "token-source-workers", "token-source-stream", "token-source-images"],
  );
  eq(
    "an engine offering ONLY cf-config names the three that vanished (a zero-capability check would have recorded nothing here)",
    tokenSourceSkewFamilies(engineCfConfigOnly),
    ["token-source-workers", "token-source-stream", "token-source-images"],
  );
  eq(
    "an engine offering cf-config + Workers names the two that vanished",
    tokenSourceSkewFamilies(engineCfConfigWorkers),
    ["token-source-stream", "token-source-images"],
  );
  eq(
    "an engine that omits tokenPresent ENTIRELY is the oldest skew there is (a zero-capability check would have missed it)",
    tokenSourceSkewFamilies(enginePreAccountTier),
    ["token-source-tier"],
  );
  // DISCRIMINATION, stated as the bar states it: hold ONLY the pack, and tell the states apart.
  const reading = (d: SourceDiscovery | undefined): string => tokenSourceSkewFamilies(d).join("+") || "(silent)";
  const readings = [currentEngineWithToken, currentEngineNoToken, engineZeroFlags, engineCfConfigOnly, engineCfConfigWorkers, enginePreAccountTier].map(reading);
  eq("the six engine builds produce five DISTINCT pack readings (the two healthy ones share silence)", new Set(readings).size, 5);

  // The families, each its own row, every one driven off a REAL predicate (never a hand-made record).
  for (const family of tokenSourceSkewFamilies(engineCfConfigOnly)) recordContractSkew("legacy-path-taken", family);
  recordContractSkew("unknown-enum-member", "role-capability"); // buttons vanish for a custom-role holder
  recordContractSkew("unknown-enum-member", "landing-screen"); // an executive lands on Overview instead
  recordContractSkew("unknown-enum-member", "owner-action-kind"); // the inbox shows a raw kind id
  const skew = rows().filter((r) => r.kind === "contract-skew");
  eq("the three vanished sources plus the three other families are SIX rows", skew.length, 6);
  eq(
    "each names the family that broke",
    skew.map((r) => r.fieldFamily).sort(),
    ["landing-screen", "owner-action-kind", "role-capability", "token-source-images", "token-source-stream", "token-source-workers"],
  );
  ok(
    "and a token-source degrade is a LEGACY PATH, not an unknown member (a different remedy)",
    skew.find((r) => r.fieldFamily === "token-source-workers")?.contractClass === "legacy-path-taken",
  );

  // The predicates the screens gate on. Each is what turns a silent normalisation into a recordable fact.
  const role = (caps: string[], landing: string): CustomRole =>
    ({ name: "r", label: "R", capabilities: caps, surface: {}, presentation: "technical", landing }) as unknown as CustomRole;
  eq("a role carrying only known capabilities is not skew", unknownCapabilityCount(role(["downpipe.read"], "overview")), 0);
  eq("a capability from a newer engine is counted", unknownCapabilityCount(role(["downpipe.read", "quantum.entangle"], "overview")), 1);
  ok("a landing this console routes is known", isKnownLandingScreen("downpipes"));
  ok("a landing from a newer engine is not", !isKnownLandingScreen("quantum-lab"));

  // NO-CUSTODY. A tampered custom role could carry ANY string in its capability list, and it is the one input
  // here an attacker chooses. The count travels; the string does not.
  ok("the unrecognised capability id never reaches the wire", !/quantum/.test(wire()));
}

// ---- malformed engine wire values are machine-flagged, not masked at render time -----------------------
{
  console.log("\nOverview reads 'covered' and 'integrity-checked' off a stamp nobody can read");
  resetRing();
  setActiveScreen("overview");

  // THE STATES the gap says are indistinguishable. Three stamps, three DIFFERENT assurances the customer is
  // relying on. A generic `timestamp` row would coalesce all three into one count on the Overview screen and
  // support could not say WHICH assurance the customer has lost.
  const dest: DestinationDescriptor = { id: "d1", label: "d1", configured: true } as unknown as DestinationDescriptor;
  const base = {
    config: { id: "dp", enabled: true, cadenceSeconds: 3600, restoreTestCadenceSeconds: 86_400, destinationIds: ["d1"], source: { type: "kv", binding: "B" } },
    lastRunAt: "2026-07-01T00:00:00Z",
    lastRunOk: true,
  } as unknown as DownpipeState;

  protectionStatement({ ...base, lastIntegrityVerifiedAt: "not-a-date", lastIntegrityVerifiedOk: true } as DownpipeState, dest, Date.parse("2026-07-10T00:00:00Z"));
  protectionStatement({ ...base, lastRestoreTestAt: "2026-13-45T99:99:99Z", lastRestoreTestOk: true } as DownpipeState, dest, Date.parse("2026-07-10T00:00:00Z"));
  protectionStatement({ ...base, lastRestoreProvenAt: "" as unknown as string, lastRestoreProvenBy: "x" } as DownpipeState, dest, Date.parse("2026-07-10T00:00:00Z"));

  const anomalies = rows().filter((r) => r.kind === "wire-anomaly");
  const classes = anomalies.map((r) => r.fieldClass).sort();
  ok("a corrupt integrity stamp is recorded", classes.includes("integrity-verified-at"));
  ok("a corrupt restore-test stamp is recorded", classes.includes("restore-test-at"));
  ok("a corrupt restore-proven stamp is recorded", classes.includes("restore-proven-at"));
  eq("and the three assurances are THREE rows, not one 'timestamp' count", new Set(classes).size, 3);

  // NOISE: a downpipe whose stamps all parse is a healthy downpipe and records nothing at all.
  resetRing();
  setActiveScreen("overview");
  protectionStatement(
    { ...base, lastIntegrityVerifiedAt: "2026-07-09T00:00:00Z", lastIntegrityVerifiedOk: true, lastRestoreTestAt: "2026-07-09T00:00:00Z", lastRestoreTestOk: true } as DownpipeState,
    dest,
    Date.parse("2026-07-10T00:00:00Z"),
  );
  eq("a downpipe whose stamps all parse records NOTHING (no cry-wolf)", rows().filter((r) => r.kind === "wire-anomaly").length, 0);

  // THE TWO STATES THE GAP NAMES IN ITS OWN TICKET AND THE LAST ROUND LEFT OPEN.
  //
  // (4) A RUN ROW WITH A CORRUPT SIZE vs one with NO size. `typeof NaN === "number"`, so a non-finite byte
  //     figure walked through the render guard, reached humanBytes and drew "-", the IDENTICAL glyph a
  //     legitimately absent figure draws. Two states, one dash, no row anywhere. Driven through runBytes, the
  //     real reader the runs table and the run drawer now both call.
  resetRing();
  setActiveScreen("runs");
  eq("an ABSENT byte figure is an honest absence and records nothing", runBytes(undefined), null);
  eq("a real size passes through untouched", runBytes(4096), 4096);
  eq("a CORRUPT (non-finite) size is refused, not rendered as an absence", runBytes(Number.NaN), null);
  eq("an infinite size too", runBytes(Number.POSITIVE_INFINITY), null);
  eq("a negative size is its own fault class", runBytes(-1), null);
  const byteRows = rows().filter((r) => r.fieldClass === "bytes");
  eq("a corrupt size and a negative size are TWO rows, and an absent one is NONE", byteRows.length, 2);
  eq("told apart by the anomaly", byteRows.map((r) => r.anomaly).sort(), ["negative", "non-finite"]);

  // (5) A BLACKOUT WINDOW SILENTLY CLAMPED TO 24:00 vs an operator who genuinely chose 24:00. The clamp EDITS
  //     the customer's schedule: the corrupt bound renders as a plausible time and the next save writes the
  //     clamped value back over the real one. Driven through minutesToTime, the function that does the coercion.
  resetRing();
  setActiveScreen("downpipes");
  eq("a legitimate end-of-day bound renders 24:00 and records NOTHING", minutesToTime(1440), "24:00");
  eq("an ordinary bound too", minutesToTime(510), "08:30");
  eq("midnight too", minutesToTime(0), "00:00");
  eq("no legitimate bound anywhere in range cries wolf", rows().filter((r) => r.fieldClass === "blackout-minute").length, 0);

  eq("an OUT-OF-RANGE bound is still clamped for render (a form cannot show an illegal time)", minutesToTime(3000), "24:00");
  const clamped = rows().filter((r) => r.fieldClass === "blackout-minute");
  eq("but the silent edit of the customer's schedule is now a row", clamped.length, 1);
  eq("naming the coercion, so 'we clamped it' and 'they chose it' are not the same 24:00", clamped[0]?.anomaly, "out-of-range");

  ok("the malformed stamp, size and minute never reach the wire", !/not-a-date|2026-13-45|3000/.test(wire()));
}

// ---- a CSP block says which directive, which class, and WHOSE inline script ------------------------------
{
  console.log("\nthe console loads broken after an update, or a security team asks whether an injection was tried");
  resetRing();
  setActiveScreen("overview");
  const origin = "https://console.example.com";

  // THE PAIR THAT ACTUALLY OCCURS, AND THE ONE THE LAST ROUND GOT WRONG.
  //
  // The console's policy is `script-src 'self' '<sha256 of the one sanctioned pre-paint>'` and `style-src
  // 'self'`. 'self' is in BOTH, so a same-origin FILE can never be blocked: the claimed headline row
  // {script-src, self} was an UNREACHABLE state, proved only by a synthetic call feeding the recorder an input
  // the browser cannot produce. The two states that DO occur are both INLINE, and both report blockedURI
  // "inline":
  //
  // the stale pre-paint hash after a deploy  -> a BROKEN DEPLOY   (the documented incident)
  //   an injected inline script                -> a SECURITY INCIDENT
  //
  // They coalesced into one row. The splitter is the page's OWN state: the sanctioned pre-paint sets a marker
  // when it EXECUTES. Absent marker => it was the thing blocked. Present marker => it ran, so the blocked inline
  // payload is not ours.

  // (a) THE BROKEN DEPLOY. The marker is absent, so the pre-paint never ran. notePrepaintBlocked is the producer,
  //     and it has to be: the violation fires while <head> parses, long before app.js can register a listener, so
  //     an event-driven recorder would have had NO PRODUCER for this class at all.
  document.documentElement.removeAttribute("data-prepaint");
  ok("a blocked pre-paint is WITNESSED (no listener could ever have heard it)", notePrepaintBlocked());

  // (b) THE ATTACK. The pre-paint ran, and an inline script was blocked anyway.
  document.documentElement.setAttribute("data-prepaint", "ran");
  ok("an ordinary healthy load witnesses NOTHING (no cry-wolf on every visit)", !notePrepaintBlocked());
  noteCspViolation("script-src", "inline", origin);

  const inlineRows = rows().filter((r) => r.kind === "csp-violation" && r.cspBlocked === "inline");
  eq("a broken deploy and an injection are TWO rows, not one coalesced count", inlineRows.length, 2);
  eq(
    "told apart by WHOSE inline script it was, which is in the tuple key",
    inlineRows.map((r) => r.cspInlineOrigin).sort(),
    ["sanctioned-prepaint", "unsanctioned"],
  );

  // The other directives still discriminate.
  noteCspViolation("script-src", "https://evil.example/x.js", origin);
  noteCspViolation("style-src", "inline", origin);
  const csp = rows().filter((r) => r.kind === "csp-violation");
  ok("a third-party script is its own external row", csp.some((r) => r.cspDirective === "script-src" && r.cspBlocked === "external"));
  ok("a blocked inline STYLE is not a blocked inline SCRIPT", csp.some((r) => r.cspDirective === "style-src" && r.cspBlocked === "inline"));

  // The mappers read the report and COPY NOTHING. This is the one path in the ring where the input string is
  // ATTACKER-CHOSEN on the case that matters most, and it is being written into a sealed bundle.
  eq("a directive with a source expression still resolves to its member", cspDirectiveFor("script-src 'nonce-abc123'"), "script-src");
  eq("a directive this build does not know is 'other', never the string", cspDirectiveFor("trusted-types-sink"), "other");
  eq("eval is its own class", cspBlockedFor("eval", origin), "eval");
  eq("anything with a scheme is external", cspBlockedFor("data:text/html,<script>", origin), "external");

  // NOISE: an extension that injects a script into the page fires a violation against the PAGE's policy, and it
  // is the operator's browser, not Downpipes. A signal dominated by extensions is worthless, so it is FILTERED.
  const before = rows().filter((r) => r.kind === "csp-violation").length;
  ok("an extension-origin block is dropped, not recorded", !noteCspViolation("script-src", "chrome-extension://abcdef/inject.js", origin));
  ok("a moz-extension block too", !noteCspViolation("script-src", "moz-extension://abcdef/inject.js", origin));
  eq("so the ring is unchanged by an extension-heavy browser", rows().filter((r) => r.kind === "csp-violation").length, before);

  ok("no blocked-uri, host or script sample reaches the wire", !/evil\.example|nonce|chrome-extension/.test(wire()));
}

// ---- the offboarding IdP-cleanup attestation records both endings -----------------------------------------
{
  console.log("\n'the console said IdP removal was recorded, but the audit export has no entry'");
  resetRing();
  setActiveScreen("access");

  // THE STATE THE PACK IS SILENT ON BY CONSTRUCTION. A failed intent write is exactly the audit entry that never
  // exists, so no amount of engine-side logging can prove it was attempted. The console is the only witness.
  recordAdminWrite("idp-cleanup-attest", "applied");
  recordAdminWrite("idp-cleanup-attest", "denied-role");
  recordAdminWrite("idp-cleanup-attest", "unreachable");
  recordAdminWrite("idp-cleanup-attest", "server-error");
  const attest = rows().filter((r) => r.adminOp === "idp-cleanup-attest");
  eq("four attestation endings are FOUR rows", attest.length, 4);
  eq(
    "including the APPLIED one, which is the PROOF the control was in force",
    attest.map((r) => r.writeOutcome).sort(),
    ["applied", "denied-role", "server-error", "unreachable"],
  );
  ok(
    "an attestation the engine never saw is told apart from one it refused",
    attest.some((r) => r.writeOutcome === "unreachable") && attest.some((r) => r.writeOutcome === "denied-role"),
  );
}

// ---- malformed licence and estate values are flagged, not silently disarmed ---------------------------------
{
  console.log("\n'we never saw a renewal warning before our Enterprise token lapsed'");
  resetRing();
  setActiveScreen("settings");

  // THE STATES. Every one of these rides RAW in the pack today (licence.notAfter and licence.features verbatim in
  // 4.29, the estate figures in 4.23, engine.artefactSha384 in section 3) and NOTHING flags any of them, so
  // neither the bot nor a support engineer is prompted to look at a card that reads as an ordinary quiet one.
  recordWireAnomaly("licence-not-after", "unparseable"); // the renews-soon machinery is silently disarmed
  recordWireAnomaly("licence-band", "unparseable"); // a MIS-MINTED volume licence
  recordWireAnomaly("estate-figure", "non-finite"); // a corrupt estate size and over-band check
  recordWireAnomaly("artefact-sha", "unparseable"); // a build-provenance stamp that is not a digest
  const lic = rows().filter((r) => r.kind === "wire-anomaly");
  eq("four malformations are FOUR rows", lic.length, 4);
  eq(
    "each names WHICH field, because each disarms a different cue",
    lic.map((r) => r.fieldClass).sort(),
    ["artefact-sha", "estate-figure", "licence-band", "licence-not-after"],
  );
  ok(
    "a renewal fault and a billing fault are not the same row (they go to different people)",
    lic.some((r) => r.fieldClass === "licence-not-after") && lic.some((r) => r.fieldClass === "licence-band"),
  );
}

// ---- a paste that lost part of itself says so ---------------------------------------------------------------
{
  console.log("\n'sign-in broke at cert rotation; we pasted both certs'");
  resetRing();
  setActiveScreen("idp");

  // The PARSE, first. splitPems keeps only what matched end to end; a block whose END line an editor mangled is
  // silently discarded, and the submission is smaller than the paste.
  const good = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  const mangled = "-----BEGIN CERTIFICATE-----\nBBBB\n----END CERTIFICATE---"; // an editor ate the END line
  eq("splitPems keeps the intact certificate", splitPems(`${good}\n${mangled}`).length, 1);
  eq("and the operator meant to paste two", pemBlocksIntended(`${good}\n${mangled}`), 2);

  // THE STATES. Without the accepted count beside the dropped one, "one of two was dropped" (half the rollover
  // pair, and sign-in WILL break) and "one of nine was dropped" are the same evidence.
  recordInputDropped("idp-cert-paste", 1, 1);
  const certRows = rows().filter((r) => r.dropSurface === "idp-cert-paste");
  eq("a lossy cert paste writes BOTH numbers, as two rows", certRows.length, 2);
  eq("accepted and dropped", certRows.map((r) => `${r.dropFact}=${r.count}`).sort(), ["accepted=1", "dropped=1"]);

  // A DIFFERENT paste surface is a different row: a dropped certificate and a dropped inventory line are not the
  // same ticket, and without dropSurface in the tuple they would be one.
  recordInputDropped("coverage-inventory-paste", 3, 2);
  const invRows = rows().filter((r) => r.dropSurface === "coverage-inventory-paste");
  eq("the coverage-inventory drop is its own pair of rows", invRows.length, 2);
  eq("with its own counts", invRows.map((r) => `${r.dropFact}=${r.count}`).sort(), ["accepted=3", "dropped=2"]);
  eq("so the two surfaces never coalesce", rows().filter((r) => r.kind === "input-dropped").length, 4);

  // The inventory parse: a line that is only a comma or only a label has no id and is skipped.
  const groups = { kv: "a\n, orphan-label\nb", r2: "", d1: "", secrets: "" } as Record<"kv" | "r2" | "d1" | "secrets", string>;
  eq("the inventory parse counts what it kept and what it dropped", inventoryLinesDropped(groups), { accepted: 2, dropped: 1 });

  // NOISE: a CLEAN paste is the ordinary state on every save and records nothing. A row that fires on the healthy
  // path devalues every true one.
  resetRing();
  setActiveScreen("idp");
  recordInputDropped("idp-cert-paste", 2, 0);
  eq("a clean paste records NOTHING", rows().filter((r) => r.kind === "input-dropped").length, 0);

  ok("no certificate body or inventory id reaches the wire", !/BEGIN CERTIFICATE|orphan-label|AAAA/.test(wire()));
}

// ---- a broken hand-off says WHICH, and whether the engine ever heard about it -----------------------------
{
  console.log("\n'I clicked through to the wizard and it opened with nothing selected'");
  resetRing();
  setActiveScreen("sources");

  // THE VOCABULARY HOLDS FEWER MEMBERS THAN THE HAND-OFF SURFACE SUGGESTS, AND THAT IS DELIBERATE, NOT A GAP.
  //
  // A class for a deep link that NAMES a zone or an account the discovery catalogue no longer returns has no
  // producer: no console screen has ever emitted such a link, since every in-app route to /downpipes/new carries
  // the source TYPE alone. A recorder wearing that name would in fact fire on the `else` of the type-only
  // hand-off -- which is to say on the ordinary Add-a-source click, on any estate with more than one zone or
  // account. That would stamp "broken product journey" into the sealed pack for the designed journey, and
  // coalesce it with the fault the class exists to name.
  //
  // A class needing chosenType kv/r2/d1 for a lost wizard binding has no producer either: the wizard's radio rows
  // write only workers/stream/images/artifacts, so no wizard control can reach it.
  //
  // Nor does a class for a lost wizard account asserted by handing buildWizardSource a HAND-BUILT WizardState
  // ({ chosenBinding: "Workers", chosenWorkersAccountId: null }): no wizard control can produce that state, since
  // every discovered-row apply() writes the account id in the same block as the binding, and Continue stays
  // disabled until a row is picked. A test built that way proves the BUILDER can record the class, never that the
  // PRODUCT can reach the state. The one state that DOES reach it is not a loss between the wizard's steps at
  // all -- it is a malformed inbound URL where no account was ever picked.
  //
  // So the wizard and the editor are BOTH DRIVEN THROUGH THEIR REAL ENTRY POINTS below (the create route, the real
  // radio rows, the real Continue and Create buttons, the real "Use the advanced editor" control), and the wire
  // the wizard actually sent is read off the stubbed engine. No recorder is called by hand anywhere in this block.

  // THIS DRIVES prefillFromQuery, THE REAL PREFILL READER, on the links the console actually emits.
  prefillFromQuery(new URLSearchParams("")); // a bare /downpipes/new: the ordinary way the wizard is opened
  prefillFromQuery(new URLSearchParams("type=cf-config")); // the designed Add-a-source hand-off
  prefillFromQuery(new URLSearchParams("type=workers")); // ... and for a token source
  prefillFromQuery(new URLSearchParams("binding=SRC_KV&type=kv")); // the attach-success bridge
  eq("not one link the console EMITS records a dropped hand-off (the noise is gone)", rows().filter((r) => r.kind === "handoff-dropped").length, 0);

  // The one prefill state that DOES have a producer: a link naming a source type this build cannot honour. Every
  // console build emits ?type= links, so a bookmark from a newer build, or a rolled-back console, produces it.
  prefillFromQuery(new URLSearchParams("type=quantum-store"));
  const typeRows = rows().filter((r) => r.kind === "handoff-dropped");
  eq("a link naming a type this build does not know IS recorded", typeRows.length, 1);
  eq("and names where the intent was lost", typeRows[0]?.handoffClass, "prefill-type-invalid");

  // ---- the REAL wizard, the REAL editor -------------------------------------------------------------------
  // THREE REAL ESTATES, because the account the operator never picked has to actually be missing. The wizard HEALS
  // a type-only hand-off on a single-account estate (the row auto-selects and its apply() writes the account), and
  // so does the cf-config hand-off, which is exactly why neither of these rows fires on the designed journey.
  const acct = (id: string, name: string): unknown => ({ accountId: id, accountName: name, kv: [], r2: [], d1: [], secrets: [], zones: [], errors: [] });
  const SURFACES = [{ id: "dns", label: "DNS records", category: "Zone", scope: "zone", restoreTier: "out-of-band" }];
  // ONE account: the designed journey. The Workers row auto-selects and carries the account with it.
  const DISC: SourceDiscovery = {
    bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, workersSupported: true,
    engineAccountId: "acct-1", accounts: [acct("acct-1", "Acme")], cfConfigSurfaces: SURFACES,
  } as unknown as SourceDiscovery;
  // TWO accounts: the wizard cannot disambiguate, so a hand-off that named no account leaves it unpicked. This is
  // the estate on which a malformed inbound link (a binding + an account-scoped type) reaches the spec builder.
  const DISC_MULTI: SourceDiscovery = {
    bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, workersSupported: true,
    accounts: [acct("acct-1", "Acme"), acct("acct-2", "Beta")], cfConfigSurfaces: SURFACES,
  } as unknown as SourceDiscovery;
  // NO account the token could read (the catalogued cf-no-accounts state), so the cf-config hand-off carries no
  // account into the advanced editor and the editor refuses the save itself.
  const DISC_NOACCT: SourceDiscovery = {
    bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, workersSupported: true,
    accounts: [], cfConfigSurfaces: SURFACES,
  } as unknown as SourceDiscovery;

  // openCreate renders the REAL create route (which is what opens the wizard) with a stub engine, and captures the
  // spec the wizard SENDS. Nothing here is hand-built but the discovery payload the engine would have returned.
  const openCreate = async (query: string, found: SourceDiscovery = DISC): Promise<{ sent: () => Downpipe | null; click: (label: RegExp) => Promise<boolean> }> => {
    (document.body as { replaceChildren: (...n: never[]) => void }).replaceChildren();
    const engine = connect("https://engine.test");
    const stub = engine as unknown as Record<string, unknown>;
    let sent = null as Downpipe | null;
    stub.listDownpipes = async (): Promise<DownpipeState[]> => [];
    stub.status = async (): Promise<unknown> => ({ service: "engine", engineVersion: "t", ready: true, downpipeCount: 0, destConfigured: true });
    stub.getDestination = async (): Promise<unknown> => ({ present: true, bucket: "archive" });
    stub.listDestinations = async (): Promise<unknown> => ({ destinations: [{ present: true, id: "d1", label: "Archive", bucket: "archive", isDefault: true }], defaultId: "d1" });
    stub.discoverSources = async (): Promise<SourceDiscovery> => found;
    stub.addDownpipe = async (dp: Downpipe): Promise<{ status: string }> => { sent = dp; return { status: "ok" }; };
    setCaller({ method: "passkey", email: "o@test", role: "owner", groups: [], isOnlyOwner: true } as unknown as Caller);
    const root = sourcesDownpipesScreen.render({ params: {}, query: new URLSearchParams(query), pattern: "/downpipes/new" } as never);
    (root as { connectedRoot_?: boolean }).connectedRoot_ = true;
    document.body.appendChild(root as never);
    await flushAsync(20);
    const click = async (label: RegExp): Promise<boolean> => {
      const btn = qsa(document.body, "button").find((b) => label.test(textOf(b)) && !(b as unknown as { disabled?: boolean }).disabled);
      if (!btn) return false;
      (btn as unknown as { click: () => void }).click();
      await flushAsync(20);
      return true;
    };
    return { sent: () => sent, click };
  };
  const setName = (name: string): void => {
    const input = qs(document.body, "#dp-name") ?? qs(document.body, "#wiz-name");
    if (input) (input as unknown as { value: string }).value = name;
  };

  // W-OK: THE DESIGNED JOURNEY. ?type=workers, the operator picks the discovered Workers row, Create. The account
  // rides in the spec and the wizard records NOTHING. (The account is written by the row's apply(), which is why
  // the wizard cannot lose it.)
  resetRing();
  setActiveScreen("sources");
  {
    const w = await openCreate("type=workers");
    const row = qs(document.body, "#wiz-wk-account-acct-1");
    if (row) (row as unknown as { click: () => void }).click();
    await flushAsync(20);
    await w.click(/^Continue$/);
    setName("Workers backup");
    await w.click(/Create downpipe/);
    const spec = (w.sent()?.source ?? {}) as { accountId?: string };
    eq("the wizard's designed journey bakes the picked account into the spec", spec.accountId, "acct-1");
    eq("and records nothing at all (a healthy journey is silent)", rows().filter((r) => r.kind === "handoff-dropped").length, 0);
  }

  // W-SENT: THE MALFORMED INBOUND LINK. ?binding=Workers&type=workers pairs a binding with an account-scoped type
  // and names no account, so the prefill (the ONLY writer that can) seeds chosenBinding with a null account. The
  // wizard SENDS a spec with no accountId and the engine answers a shape 400 the operator cannot attribute to
  // anything. The row must say the request WAS made.
  resetRing();
  setActiveScreen("sources");
  {
    const w = await openCreate("binding=Workers&type=workers", DISC_MULTI);
    await w.click(/^Continue$/);
    setName("Handoff backup");
    await w.click(/Create downpipe/);
    const sent = w.sent();
    ok("the wizard SENT the spec (there is a real engine 400 to go and find)", sent !== null);
    ok("and it carries no account id (the unattributable engine 400)", !("accountId" in ((sent?.source ?? {}) as Record<string, unknown>)));
    const r = rows().filter((x) => x.kind === "handoff-dropped");
    eq("one row, and it names the spec the wizard sent", r.map((x) => x.handoffClass), ["wizard-spec-account-absent"]);
  }

  // E-REFUSED: THE DESIGNED cf-config LINK, through the wizard's own "Use the advanced editor" control. The editor
  // refuses the create LOCALLY and MAKES NO REQUEST. Under the old single class this was byte-identical to W-SENT
  // and coalesced with it -- the same kind, the same screen, the same class -- and it is by far the commoner of
  // the two, so it buried the one that leaves a 400 behind.
  resetRing();
  setActiveScreen("sources");
  {
    const w = await openCreate("type=cf-config", DISC_NOACCT);
    const opened = await w.click(/Use the advanced editor/);
    ok("the wizard's advanced-editor control is offered on the cf-config hand-off", opened);
    setName("Config backup");
    await w.click(/Create downpipe/);
    eq("the editor made NO request to the engine (there is nothing in any log to find)", w.sent(), null);
    const r = rows().filter((x) => x.kind === "handoff-dropped");
    eq("one row, and it names the local refusal", r.map((x) => x.handoffClass), ["editor-refused-account-absent"]);
  }

  // AND THE TWO DISCRIMINATE. Both journeys in one session: two rows, not one count of two, because a support
  // engineer holding only the pack has to know whether the engine ever saw the request.
  resetRing();
  setActiveScreen("sources");
  {
    const w1 = await openCreate("binding=Workers&type=workers", DISC_MULTI);
    await w1.click(/^Continue$/);
    setName("Handoff backup");
    await w1.click(/Create downpipe/);
    const w2 = await openCreate("type=cf-config", DISC_NOACCT);
    await w2.click(/Use the advanced editor/);
    setName("Config backup");
    await w2.click(/Create downpipe/);
    const r = rows().filter((x) => x.kind === "handoff-dropped");
    eq("a spec the wizard SENT and a create the editor REFUSED are TWO rows", r.length, 2);
    eq(
      "and each says whether the engine heard about it",
      r.map((x) => x.handoffClass).sort(),
      ["editor-refused-account-absent", "wizard-spec-account-absent"],
    );
  }

  ok("the query string, zone id, account id and binding name never reach the wire", !/quantum-store|SRC_KV|acct-1|Workers/.test(wire()));
}

// ---- a browser-side ceremony step says which step and how it ended ---------------------------------------
{
  console.log("\nthe M-of-N split keeps failing, or the recovery codes were never saved");
  resetRing();

  // THE STATES. This is the product's deliberate no-custody blind spot: all of this happens in the browser and
  // NOTHING about it has ever left it, so support debugs from screenshots and a paper backup that turns out
  // corrupt years later has no record that the console warned them at the time.
  recordCeremonyStep("shamir-split", false, "webcrypto"); // a locked-down browser: the split never ran
  recordCeremonyStep("tier12-encrypt", false, "oom"); // a large allocation the tab could not make
  recordCeremonyStep("paper-roundtrip-check", false, "decode"); // the printable payload is TRUNCATED
  recordCeremonyStep("recovery-codes-copy", false, "clipboard-denied"); // the codes were never saved
  const failed = rows().filter((r) => r.kind === "ceremony-step");
  eq("four failing ceremony steps are FOUR rows", failed.length, 4);
  eq(
    "each names the step and coarsely why",
    failed.map((r) => `${r.ceremonyStep}/${r.ceremonyFault}`).sort(),
    ["paper-roundtrip-check/decode", "recovery-codes-copy/clipboard-denied", "shamir-split/webcrypto", "tier12-encrypt/oom"],
  );

  // THE OK ROW IS THE OTHER HALF, and the gap turns on it. "The recovery codes were never saved because the copy
  // silently failed" is answered by WHICH row exists: a ceremony that ran and worked must be tellable from one
  // that was never run at all, and both would otherwise be an absence.
  recordCeremonyStep("recovery-codes-copy", true);
  const copy = rows().filter((r) => r.ceremonyStep === "recovery-codes-copy");
  eq("a copy that worked and a copy that was refused are TWO rows", copy.length, 2);
  eq("told apart by the outcome", copy.map((r) => r.ceremonyOutcome).sort(), ["failed", "ok"]);

  // The same step failing for two DIFFERENT reasons is two rows: a browser that has no SubtleCrypto and one that
  // ran out of memory on a big key file are different remedies down the phone.
  recordCeremonyStep("shamir-split", false, "oom");
  eq("one step, two fault classes, two rows", rows().filter((r) => r.ceremonyStep === "shamir-split").length, 2);

  // The fault mapper reads the CONSTRUCTOR NAME and nothing else. A WebCrypto or decoder message can carry a byte
  // offset or a length, and both are fingerprints of the key material the whole ceremony exists to keep here.
  eq("a RangeError out of a big allocation is 'oom'", ceremonyFaultFor(new RangeError("Array buffer allocation failed")), "oom");
  eq("anything unrecognised is 'other', never the message", ceremonyFaultFor(new Error("split failed at share 3 of 5, offset 0x40")), "other");

  // NO MATERIAL, AND THAT INCLUDES N AND THE THRESHOLD. They are in scope at the split site, they would be
  // genuinely useful, and they are the customer's own custody design and a fingerprint of it.
  const w = wire();
  ok("no key material, share bytes or payload fragment reaches the wire", !/share|offset|0x40|allocation/.test(w));
  ok("and no N or threshold", !/"n":|threshold/.test(w));
  ok("the row is filed under the keys ceremony, not whatever route was active", rows().every((r) => r.kind !== "ceremony-step" || r.screen === "keys"));
}

// ---- a masked contract break is told apart from ordinary absence -------------------------------------------
{
  console.log("\na paying customer's licence tile reads 'Community / Fail-open'");
  resetRing();
  setActiveScreen("overview");

  // THE STATES. A defensive default masks each of these, and the mask is INDISTINGUISHABLE from an ordinary
  // absence: a partial licence payload reads as a community licence, a run list with no byte fields reads as a
  // young estate, and a downpipe list that is not an array reads as an honest unknown. Every one of them is an
  // engine-console contract break, which is a DEFECT SIGNAL.
  // THE RUN-COST ROW IS DRIVEN THROUGH observedCostSeed, THE REAL FUNCTION, because that is where it went wrong.
  //
  // The predicate was `all.length > 0 && withFields.length === 0` over runs of ANY status. But the engine stamps
  // the throughput fields at COMPLETION and nowhere else: an in-flight row is appended at trigger with none, a
  // failed completion posts none, and an abandoned run never completes. So the row fired on three ordinary,
  // LEGITIMATE states -- a first backup still running, an estate whose every backup is failing (the commonest
  // support state there is), an abandoned run -- and produced the SAME row as the defect it was written for.
  // Four states, one row, three of them healthy, on every Overview render.
  const run = (status: string, fields: boolean): RunHistoryEntry =>
    ({
      runId: "r", index: 1, startedAt: "2026-07-01T00:00:00Z", status,
      ...(fields ? { archiveBytesWritten: 1024, segmentsWritten: 2 } : {}),
    }) as unknown as RunHistoryEntry;
  const seedRows = (byDownpipe: Record<string, RunHistoryEntry[]>): number => {
    resetRing();
    setActiveScreen("overview");
    observedCostSeed(byDownpipe);
    return rows().filter((r) => r.fieldFamily === "run-cost-fields").length;
  };

  eq("L1 a first backup still IN FLIGHT is legitimate and records NOTHING", seedRows({ dp: [run("in-flight", false)] }), 0);
  eq("L2 an estate whose every backup FAILED is legitimate and records NOTHING", seedRows({ dp: [run("failed", false), run("failed", false)] }), 0);
  eq("L3 an ABANDONED run is legitimate and records NOTHING", seedRows({ dp: [run("abandoned", false)] }), 0);
  eq("an estate with NO runs at all records NOTHING", seedRows({}), 0);
  eq("a healthy run carrying its byte fields records NOTHING", seedRows({ dp: [run("ok", true)] }), 0);
  eq("D a SUCCEEDED run with its byte fields dropped IS the contract break, and IS recorded", seedRows({ dp: [run("ok", false)] }), 1);
  eq("and a mixed ring with at least one good ok run does not cry wolf", seedRows({ dp: [run("ok", false), run("ok", true)] }), 0);

  resetRing();
  setActiveScreen("overview");
  recordContractSkew("missing-field", "licence-payload");
  observedCostSeed({ dp: [run("ok", false)] }); // the REAL producer of the run-cost row
  recordContractSkew("wrong-shape", "downpipe-list");
  const overview = rows().filter((r) => r.kind === "contract-skew");
  eq("three masked contract breaks are THREE rows", overview.length, 3);
  eq(
    "each names the family the engine broke",
    overview.map((r) => `${r.contractClass}/${r.fieldFamily}`).sort(),
    ["missing-field/licence-payload", "missing-field/run-cost-fields", "wrong-shape/downpipe-list"],
  );

  // The downpipe list ABSENT and the downpipe list MALFORMED are two rows, not one: they are different engine
  // bugs and, without contractClass in the tuple, they would coalesce into whichever fired first.
  recordContractSkew("missing-field", "downpipe-list");
  const dpRows = rows().filter((r) => r.fieldFamily === "downpipe-list");
  eq("an ABSENT list and a MALFORMED one are two rows", dpRows.length, 2);
  eq("told apart by the contract class", dpRows.map((r) => r.contractClass).sort(), ["missing-field", "wrong-shape"]);

  // The drill-evidence stamp: an entry whose recordedAt will not parse is SKIPPED by the newest-wins pick, so an
  // older drill is quietly promoted and the card shows stale evidence dressed as current.
  resetRing();
  setActiveScreen("overview");
  const drill = (recordedAt: string) => ({ recordedAt, downpipeId: "dp", ok: true }) as never;
  const picked = newestDrill([drill("2026-07-01T00:00:00Z"), drill("not-a-date")]);
  ok("a corrupt drill stamp is skipped by the pick (the older evidence wins)", picked !== null);
  const drillRows = rows().filter((r) => r.fieldClass === "drill-recorded-at");
  eq("and the corruption is recorded, so the stale card is explicable", drillRows.length, 1);
  eq("as an unparseable stamp", drillRows[0]?.anomaly, "unparseable");

  // NOISE: a drill list whose stamps all parse records nothing.
  resetRing();
  setActiveScreen("overview");
  newestDrill([drill("2026-07-01T00:00:00Z"), drill("2026-07-02T00:00:00Z")]);
  eq("a clean drill list records NOTHING", rows().filter((r) => r.kind === "wire-anomaly").length, 0);
}

// ---- the whole ring, once more, on the wire ---------------------------------------------------------------------
{
  console.log("\nno-custody: the whole group-3 wire, end to end");
  resetRing();
  setActiveScreen("security");
  recordOwnerActionRefusal("owner-action-approve", "self-approval");
  recordRoleDeleteImpact(4, "applied");
  recordCspViolation(cspDirectiveFor("script-src"), cspBlockedFor("https://evil.example/x.js", "https://c.example"));
  recordInputDropped("idp-cert-paste", 1, 1);
  recordHandoffDropped("wizard-spec-account-absent");
  recordCeremonyStep("shamir-split", false, "webcrypto");
  recordWireAnomaly("licence-not-after", "unparseable");
  const w = wire();
  ok("every string on the wire is a frozen vocabulary member or a key name", !/https?:|@|\.example|BEGIN|Error|Failed/.test(w));
  ok("and the payload is well within the engine's pre-parse body cap", new TextEncoder().encode(w).length < 32_768);
}

console.log(failures === 0 ? "\nsupport posture gaps (group 3): all checks passed" : `\nsupport posture gaps (group 3): ${failures} FAILED`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
process.exit(failures === 0 ? 0 : 1);
