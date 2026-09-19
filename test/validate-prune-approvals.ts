// The dual-control retention-prune inbox (/restore/prune-approvals), driven against the REAL screen code
// under the shared DOM shim (no jsdom, no network; the engine is a recording stub), the same way
// validate-restore-approvals.ts drives its restore sibling.
//
// Covers, against the real code:
//   - every PruneApprovalStatus renders its own sentence (requested, approved, applying, consumed, expired,
//     rejected with a closed reason, rejected with none), and a card names the downpipe by its friendly name
//     when the live list resolves it and falls back to the raw id when it does not
//   - maker is not checker: Approve and Reject are HIDDEN on the caller's own request (the banner shows
//     instead) and PRESENT on someone else's
//   - the restore.approve capability gate: a Viewer sees the capability note and no Approve, even on a
//     request that is not theirs
//   - the approve path: card button -> confirm modal (which names the passkey prompt the operator may see)
//     -> engine.retentionPruneApprove(planHash) with the request's EXACT plan hash; a dismissed confirm
//     calls nothing
//   - the reject path: the confirm is the fixed reason picker over the closed PRUNE_REJECT_REASONS (no bare
//     confirm to skip it with), the chosen member reaches the engine, and Cancel records nothing
//   - a failed approve reaches the operator as a toast, not a silent nothing
//   - the 404/501 degrade renders the pending-engine note (an older engine build), a 500 the block error
//   - the empty inbox renders the honest "no pending prune approvals" state
//   - the 15 s poll: an unchanged response does not repaint, a changed one does, and a detached root stops
//     the interval
//   - pruneApprovalsEntryNote navigates to the inbox
//
// Run with `node test/validate-prune-approvals.ts`.

import { flushAsync, installDomShim, markConnected, qsa, textOf } from "./dom-shim.ts";
installDomShim();

const g = globalThis as unknown as { location: unknown; MutationObserver: unknown };
g.location = g.location ?? { origin: "https://console.test" };
g.MutationObserver = g.MutationObserver ?? class { observe(): void {} disconnect(): void {} };

import type { Caller, EngineClient, PruneApproval, PruneRejectReason } from "../src/api.ts";
import { PRUNE_REJECT_REASON_COPY, PRUNE_REJECT_REASONS } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { pruneApprovalsEntryNote, renderPruneApprovalsInbox } from "../src/screens/restore-flow/prune-approvals.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const DP_ID = "dp_prune_inbox_test";
const DP_NAME = "Payments KV";

function makeRecord(over: Partial<PruneApproval> = {}): PruneApproval {
  const now = Date.now();
  return {
    planHash: over.planHash ?? "sha384:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    downpipeId: over.downpipeId ?? DP_ID,
    retainedRuns: over.retainedRuns ?? 12,
    supersededRuns: over.supersededRuns ?? 1345,
    requestedBy: over.requestedBy ?? "maker@example.com",
    requestedAt: over.requestedAt ?? new Date(now - 60_000).toISOString(),
    reason: over.reason ?? "Quarterly cleanup of superseded runs.",
    status: over.status ?? "requested",
    expiresAt: over.expiresAt ?? new Date(now + 24 * 3600 * 1000).toISOString(),
    ...(over.approvedBy !== undefined ? { approvedBy: over.approvedBy } : {}),
    ...(over.approvedAt !== undefined ? { approvedAt: over.approvedAt } : {}),
    ...(over.rejectReason !== undefined ? { rejectReason: over.rejectReason } : {}),
  };
}

const callerOf = (email: string, role: Caller["role"]): Caller => ({ method: "access", email, role, groups: [], isOnlyOwner: false });

function docBody(): unknown {
  return (globalThis as unknown as { document: { body: unknown } }).document.body;
}
function buttonsOf(root: unknown): Array<{ text: string; node: { click: () => void; disabled?: boolean } }> {
  return qsa(root, "button").map((b) => ({ text: textOf(b), node: b as unknown as { click: () => void; disabled?: boolean } }));
}
function clickButton(root: unknown, label: string): boolean {
  const hit = buttonsOf(root).find((b) => b.text.includes(label) && !b.node.disabled);
  if (!hit) return false;
  hit.node.click();
  return true;
}
function regionText(root: unknown): string {
  const region = qsa(root, "div").find((d) => String((d as unknown as { className?: string }).className ?? "").includes("async-region"));
  return region ? textOf(region) : "";
}
async function waitFor(cond: () => boolean, rounds = 200): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await flushAsync(3);
  }
  return cond();
}

// The poll is captured rather than left to the real clock: the screen schedules a production 15 s
// interval, and the test wants to drive the tick body directly and to see clearInterval called.
interface CapturedInterval { fn: () => void; ms: number; id: number; cleared: boolean }
const intervals: CapturedInterval[] = [];
let intervalSeq = 0;
{
  const w = (globalThis as unknown as { window: { setInterval: unknown; clearInterval: unknown } }).window;
  w.setInterval = (fn: () => void, ms: number): number => {
    const id = ++intervalSeq;
    intervals.push({ fn, ms, id, cleared: false });
    return id;
  };
  w.clearInterval = (id: number): void => {
    const hit = intervals.find((i) => i.id === id);
    if (hit) hit.cleared = true;
  };
}

interface EngineCalls { approve: string[]; reject: Array<{ planHash: string; reason: PruneRejectReason }>; lists: number }
interface Rendered { root: unknown; calls: EngineCalls; setNext: (records: PruneApproval[]) => void }

async function renderInbox(
  caller: Caller,
  listResult: PruneApproval[] | (() => Promise<never>),
  options: { downpipes?: "resolve" | "throw"; approveThrows?: boolean } = {},
): Promise<Rendered> {
  setCaller(caller);
  const engine = connect("https://engine.test");
  const calls: EngineCalls = { approve: [], reject: [], lists: 0 };
  let current: PruneApproval[] = Array.isArray(listResult) ? listResult : [];
  const e = engine as unknown as {
    retentionPruneApprovals: () => Promise<PruneApproval[]>;
    retentionPruneApprove: (planHash: string) => Promise<PruneApproval>;
    retentionPruneReject: (planHash: string, reason: PruneRejectReason) => Promise<PruneApproval>;
    listDownpipes: () => Promise<Array<{ config: { id: string; name: string } }>>;
  };
  e.retentionPruneApprovals = async () => {
    calls.lists++;
    if (typeof listResult === "function") return listResult();
    return current;
  };
  e.retentionPruneApprove = async (planHash: string) => {
    calls.approve.push(planHash);
    if (options.approveThrows) throw new Error("engine said no");
    return makeRecord({ planHash, status: "approved", approvedBy: caller.email ?? "" });
  };
  e.retentionPruneReject = async (planHash: string, reason: PruneRejectReason) => {
    calls.reject.push({ planHash, reason });
    return makeRecord({ planHash, status: "rejected", rejectReason: reason });
  };
  e.listDownpipes = async () => {
    if (options.downpipes === "throw") throw new Error("list unavailable");
    return [{ config: { id: DP_ID, name: DP_NAME } }];
  };
  const root = renderPruneApprovalsInbox(engine as unknown as EngineClient);
  markConnected(root);
  await waitFor(() => regionText(root).length > 0 && !regionText(root).includes("skeleton"));
  await flushAsync(5);
  return { root, calls, setNext: (records) => { current = records; } };
}

async function main(): Promise<void> {
  const navigations: string[] = [];
  let signedOut = 0;
  installNav({
    navigate: (to: string) => { navigations.push(to); },
    onUnauthorised: () => { signedOut++; },
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => { signedOut++; },
  });
  void signedOut;

  // ------------------------------------------------------------------------
  console.log("\n-- the empty inbox --");
  // ------------------------------------------------------------------------
  {
    const { root } = await renderInbox(callerOf("checker@example.com", "approver"), []);
    ok("an empty inbox renders the honest 'no pending prune approvals' state", textOf(root).includes("No pending prune approvals"));
    ok("the page header names the maker-is-not-checker rule", textOf(root).includes("maker is not checker"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- every status renders its own sentence, and the card names the downpipe --");
  // ------------------------------------------------------------------------
  {
    const records: PruneApproval[] = [
      makeRecord({ planHash: "sha384:req0000000000000000000000000000000000000000000000000000000000000", status: "requested" }),
      makeRecord({ planHash: "sha384:app0000000000000000000000000000000000000000000000000000000000000", status: "approved", approvedBy: "second@example.com" }),
      makeRecord({ planHash: "sha384:apl0000000000000000000000000000000000000000000000000000000000000", status: "applying" }),
      makeRecord({ planHash: "sha384:con0000000000000000000000000000000000000000000000000000000000000", status: "consumed" }),
      makeRecord({ planHash: "sha384:exp0000000000000000000000000000000000000000000000000000000000000", status: "expired" }),
      makeRecord({ planHash: "sha384:rej0000000000000000000000000000000000000000000000000000000000000", status: "rejected", approvedBy: "second@example.com", rejectReason: "too-broad" }),
      makeRecord({ planHash: "sha384:rejnone00000000000000000000000000000000000000000000000000000000", status: "rejected" }),
      makeRecord({ planHash: "sha384:other000000000000000000000000000000000000000000000000000000000", status: "requested", downpipeId: "dp_not_in_list" }),
    ];
    const { root } = await renderInbox(callerOf("checker@example.com", "approver"), records);
    const text = textOf(root);
    ok("a requested card carries the Awaiting approval badge", text.includes("Awaiting approval"));
    ok("an approved card tells the requester where to apply", text.includes("Approved by second@example.com. The requester can now apply this exact plan"));
    ok("an applying card explains the transient state instead of a bare badge", text.includes("This plan is being applied now"));
    ok("a consumed card says the approval cannot be reused", text.includes("cannot be reused"));
    ok("an expired card says to raise a fresh request", text.includes("expired before it was approved"));
    ok("a rejection with a closed reason shows the label and the requester line", text.includes("Rejected by second@example.com: too broad. Because the plan would supersede more than the cleanup calls for"));
    ok("a rejection with no reason on the record still reads as a rejection", text.includes("Rejected. Raise a fresh request if it is still needed."));
    ok("the run counts are grouped for reading", text.includes("1,345"));
    ok("the friendly downpipe name is used when the live list resolves it", qsa(root, "h3").some((h) => textOf(h) === DP_NAME));
    ok("the raw id is the title when the list does not know the downpipe", qsa(root, "h3").some((h) => textOf(h) === "dp_not_in_list"));
    ok("the footnote closes the list", text.includes("That is every pending prune approval."));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- maker is not checker, and the capability gate --");
  // ------------------------------------------------------------------------
  {
    const mine = makeRecord({ planHash: "sha384:mine000000000000000000000000000000000000000000000000000000000000", requestedBy: "me@example.com" });
    const theirs = makeRecord({ planHash: "sha384:theirs0000000000000000000000000000000000000000000000000000000000", requestedBy: "maker@example.com" });
    const { root } = await renderInbox(callerOf("me@example.com", "approver"), [mine, theirs]);
    const approveButtons = buttonsOf(root).filter((b) => b.text.includes("Approve"));
    ok("exactly one Approve button is offered (only on someone else's request)", approveButtons.length === 1);
    ok("the caller's own request shows the maker-is-not-checker banner", textOf(root).includes("You raised this request, so you cannot approve it"));

    const { root: viewerRoot } = await renderInbox(callerOf("viewer@example.com", "viewer"), [theirs]);
    ok("a Viewer sees the capability note", textOf(viewerRoot).includes("Approving requires"));
    ok("and no Approve button, even on another's request", !buttonsOf(viewerRoot).some((b) => b.text.includes("Approve")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the approve path reaches the engine with the exact plan hash --");
  // ------------------------------------------------------------------------
  {
    const exact = "sha384:exact7777777777777777777777777777777777777777777777777777777777777";
    const theirs = makeRecord({ planHash: exact, requestedBy: "maker@example.com" });
    const { root, calls } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs]);
    ok("an Approve button is present on the card", clickButton(root, "Approve"));
    await waitFor(() => textOf(docBody()).includes("Approve the retention prune"));
    const modalText = textOf(docBody());
    ok("the confirm names the downpipe by its friendly name", modalText.includes(`Approve the retention prune of ${DP_NAME}?`));
    ok("the confirm says the run counts are the only blast-radius figure before apply", modalText.includes("Object and segment counts are not known until apply"));
    ok("the confirm tells the approver about the passkey prompt before they agree", modalText.includes("You may be asked to confirm with your own passkey"));
    ok("the confirm shows the short plan hash without the sha384: prefix", modalText.includes("exact77777777777") && !modalText.includes("sha384:exact"));
    ok("confirm the approve in the modal", clickButton(docBody(), "Approve"));
    ok("retentionPruneApprove is called with the request's exact plan hash", await waitFor(() => calls.approve.length === 1) && calls.approve[0] === exact);
    ok("a successful approve reloads the inbox", await waitFor(() => calls.lists >= 2));
    ok("the operator is told", textOf(docBody()).includes("Prune approved"));

    // Dismissing the confirm approves nothing. The body is never cleared between renders: the toast host
    // is created once and appended to the body, so clearing it would detach the host and every later toast
    // would land somewhere the assertions cannot read.
    const { root: root2, calls: calls2 } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs]);
    clickButton(root2, "Approve");
    await waitFor(() => textOf(docBody()).includes("Approve the retention prune"));
    ok("the confirm can be backed out of", clickButton(docBody(), "Cancel"));
    await flushAsync(10);
    ok("a dismissed confirm calls the engine with nothing", calls2.approve.length === 0);

    // A failed approve reaches the operator.
    const { root: root3, calls: calls3 } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs], { approveThrows: true });
    clickButton(root3, "Approve");
    await waitFor(() => textOf(docBody()).includes("Approve the retention prune"));
    clickButton(docBody(), "Approve");
    await waitFor(() => calls3.approve.length === 1);
    ok("a failed approve is reported as a toast naming the failure", await waitFor(() => textOf(docBody()).includes("Could not approve")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the reject path is the closed reason picker --");
  // ------------------------------------------------------------------------
  {
    const exact = "sha384:reject888888888888888888888888888888888888888888888888888888888888";
    const theirs = makeRecord({ planHash: exact, requestedBy: "maker@example.com" });
    const { root, calls } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs]);
    ok("a Reject button is present on the card", clickButton(root, "Reject"));
    await waitFor(() => textOf(docBody()).includes("Reject the retention prune"));
    ok("the picker names the downpipe", textOf(docBody()).includes(`Reject the retention prune of ${DP_NAME}?`));
    ok("there is no bare Reject confirm to skip the reason with", clickButton(docBody(), "Reject") === false);
    ok("the picker offers every closed reason by its label", PRUNE_REJECT_REASONS.every((r) => buttonsOf(docBody()).some((b) => b.text === PRUNE_REJECT_REASON_COPY[r].label)));
    ok("choose a reason", clickButton(docBody(), "Too broad"));
    ok("retentionPruneReject is called with the exact plan hash", await waitFor(() => calls.reject.length === 1) && calls.reject[0]?.planHash === exact);
    ok("and with the CLOSED member the checker chose", calls.reject[0]?.reason === "too-broad");
    ok("the operator is told", await waitFor(() => textOf(docBody()).includes("Prune rejected")));

    const { root: root2, calls: calls2 } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs]);
    clickButton(root2, "Reject");
    await waitFor(() => textOf(docBody()).includes("Reject the retention prune"));
    clickButton(docBody(), "Against policy");
    await waitFor(() => calls2.reject.length === 1);
    ok("a different reason reaches the engine as a DIFFERENT closed member", calls2.reject[0]?.reason === "policy");

    const { root: root3, calls: calls3 } = await renderInbox(callerOf("checker@example.com", "approver"), [theirs]);
    clickButton(root3, "Reject");
    await waitFor(() => textOf(docBody()).includes("Reject the retention prune"));
    clickButton(docBody(), "Cancel");
    await flushAsync(10);
    ok("cancelling the picker rejects nothing", calls3.reject.length === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the degrade paths --");
  // ------------------------------------------------------------------------
  {
    const httpError = (status: number): (() => Promise<never>) => async () => {
      const err = new Error(`HTTP ${status}`) as Error & { status: number };
      err.status = status;
      throw err;
    };
    const { root: r404 } = await renderInbox(callerOf("checker@example.com", "approver"), httpError(404));
    ok("a 404 renders the pending-engine note, not a hard error", textOf(r404).includes("does not support prune approvals yet"));
    const { root: r501 } = await renderInbox(callerOf("checker@example.com", "approver"), httpError(501));
    ok("a 501 renders the same note", textOf(r501).includes("does not support prune approvals yet"));
    const { root: r500 } = await renderInbox(callerOf("checker@example.com", "approver"), httpError(500));
    ok("a 500 renders the block error with a retry, not the pending-engine note", !textOf(r500).includes("does not support prune approvals yet") && textOf(r500).length > 0);

    const { root: noNames } = await renderInbox(callerOf("checker@example.com", "approver"), [makeRecord()], { downpipes: "throw" });
    ok("a thrown listDownpipes degrades to the raw id, never a failed inbox", qsa(noNames, "h3").some((h) => textOf(h) === DP_ID) && textOf(noNames).includes("Awaiting approval"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the poll: unchanged does not repaint, changed does, detached stops --");
  // ------------------------------------------------------------------------
  {
    const before = intervals.length;
    const first = makeRecord({ planHash: "sha384:poll000000000000000000000000000000000000000000000000000000000000" });
    const { root, calls, setNext } = await renderInbox(callerOf("checker@example.com", "approver"), [first]);
    const mine = intervals.slice(before);
    ok("the screen schedules exactly one poll", mine.length === 1);
    ok("at the production cadence of 15 s", mine[0]?.ms === 15_000);
    const poll = mine[0];
    if (!poll) throw new Error("no poll captured");
    const cards = (): unknown[] => qsa(root, "div").filter((d) => String((d as unknown as { className?: string }).className ?? "").includes("approval-card"));
    const firstCard = cards()[0];
    poll.fn();
    await waitFor(() => calls.lists >= 2);
    await flushAsync(5);
    ok("an unchanged response does not repaint the inbox", cards()[0] === firstCard);

    setNext([first, makeRecord({ planHash: "sha384:poll111111111111111111111111111111111111111111111111111111111111" })]);
    poll.fn();
    await waitFor(() => cards().length === 2);
    ok("a changed response repaints with the new card", cards().length === 2);

    (root as { remove?: () => void; parentNode?: { removeChild: (n: unknown) => void } | null }).remove?.();
    const rootNode = root as { connectedRoot_?: boolean };
    rootNode.connectedRoot_ = false;
    poll.fn();
    await flushAsync(5);
    ok("a detached root stops the interval", poll.cleared);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the entry note points at the inbox --");
  // ------------------------------------------------------------------------
  {
    const note = pruneApprovalsEntryNote();
    ok("the note asks the question a waiting requester has", textOf(note).includes("Waiting on a distinct approver?"));
    ok("its link is labelled", clickButton(note, "Pending prune approvals"));
    ok("and navigates to /restore/prune-approvals", navigations[navigations.length - 1] === "/restore/prune-approvals");
  }

  console.log(failures === 0 ? "\nVERDICT: PASS failures=0 entry=validate-prune-approvals.ts" : `\nVERDICT: FAIL failures=${failures} entry=validate-prune-approvals.ts`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
