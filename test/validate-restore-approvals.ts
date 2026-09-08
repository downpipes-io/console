// TC-restore-approvals: the dual-control restore-approval inbox (/restore/approvals). The approver must
// differ from the requester (maker is not checker), approval is bound to the exact plan, and an engine build
// without the approvals route degrades honestly. Run with: node test/validate-restore-approvals.ts
//
// Coverage (the load-bearing behaviours of the restore-approval inbox UI). It RENDERS the real screen code
// under a self-contained DOM shim (it never re-implements the code under test); it exits deterministically
// because the rendered inbox schedules a production 15 s poll that legitimately outlives the test.
//   - a mix of mine / not-mine records: Approve + Reject are HIDDEN on the caller's OWN request (the
//     maker-is-not-checker copy shows instead) and PRESENT on someone else's request
//   - the Approver/Owner role gate: a Viewer sees the "Approving requires the Approver or Owner role" note
//     and no Approve button, even on a request that is not theirs
//   - the 404/501 graceful-degrade renders the pending-engine note (an older engine build), not a hard error
//   - an empty inbox renders the honest "no pending approvals" state
//   - the approve / reject click paths reach the engine with the request's exact plan hash (the dual-control
//     gate is bound to the plan, ASVS V10.3.3 / V10.5.2)
//   - self-identifying labels: buildRunNameJoin (shared.ts) resolves a run's owning downpipe + friendly
//     name (happy path), and degrades HONESTLY on a run that rolled off history, a thrown listAllHistory,
//     or a thrown listDownpipes -- never a throw out of the join, never a fabricated name.
//   - THE APPROVER'S OWN WINDOW: the card names when the approval expires, says so in the past tense once
//     it has, refuses to offer Approve/Reject on a record whose deadline has already passed, and invents
//     no deadline at all when the engine sent none. See the block near the end of main().

// ==========================================================================
// A minimal DOM shim (same approach as validate-owner-actions.ts): just enough surface for the rendered
// approvals inbox + its toast/modal regions to run under plain node.
// ==========================================================================

let nodeSeq = 0;

class ShimClassList {
  node: ShimNode; set: Set<string> = new Set();
  constructor(node: ShimNode) { this.node = node; }
  add(...cs: string[]): void { for (const c of cs) this.set.add(c); this.sync(); }
  remove(...cs: string[]): void { for (const c of cs) this.set.delete(c); this.sync(); }
  toggle(c: string, force?: boolean): void { const want = force === undefined ? !this.set.has(c) : force; if (want) this.set.add(c); else this.set.delete(c); this.sync(); }
  contains(c: string): boolean { return this.set.has(c); }
  sync(): void { this.node.attrs.class = [...this.set].join(" "); }
}

class ShimStyle {
  [prop: string]: string | ((p: string, v: string, priority?: string) => void);
  setProperty(prop: string, value: string): void { this[prop] = value; }
}

interface ShimEvent { type: string; target: ShimNode | null; currentTarget: ShimNode | null; defaultPrevented: boolean; preventDefault(): void; }

class ShimNode {
  id_: number;
  kind: "element" | "text" | "fragment";
  nodeType: number;
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: ShimEvent) => void>> = {};
  text_ = "";
  dataset: Record<string, string> = {};
  style: ShimStyle = new ShimStyle();
  classList: ShimClassList;
  hidden_ = false;
  value_ = "";
  disabled_ = false;
  checked_ = false;
  innerHTML_ = "";
  tagName = "";
  localName = "";
  connectedRoot_ = false;

  constructor(kind: "element" | "text" | "fragment") {
    this.id_ = ++nodeSeq;
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : kind === "fragment" ? 11 : 1;
    this.classList = new ShimClassList(this);
  }

  appendChild(child: ShimNode | null): ShimNode | null {
    if (child == null) return child;
    if (child.kind === "fragment") { for (const c of [...child.childNodes]) this.appendChild(c); return child; }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: ShimNode): ShimNode { const i = this.childNodes.indexOf(child); if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; } return child; }
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes: ShimNode[]): void { for (const c of [...this.childNodes]) this.removeChild(c); for (const n of nodes) this.appendChild(n); }
  get firstChild(): ShimNode | null { return this.childNodes[0] ?? null; }
  get firstElementChild(): ShimNode | null { return this.childNodes.find((c) => c.nodeType === 1) ?? null; }
  get childElementCount(): number { return this.childNodes.filter((c) => c.nodeType === 1).length; }
  get isConnected(): boolean { let n: ShimNode | null = this; while (n) { if (n.connectedRoot_) return true; n = n.parentNode; } return false; }
  contains(other: ShimNode | null): boolean { let n: ShimNode | null = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }

  setAttribute(k: string, v: string): void {
    if (k === "class") { this.attrs.class = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); return; }
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  hasAttribute(k: string): boolean { return k in this.attrs; }

  set className(v: string) { this.setAttribute("class", String(v)); }
  get className(): string { return this.attrs.class ?? ""; }
  set id(v: string) { this.attrs.id = String(v); }
  get id(): string { return this.attrs.id ?? ""; }
  set hidden(v: boolean) { this.hidden_ = !!v; if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get hidden(): boolean { return this.hidden_; }
  set value(v: string) { this.value_ = String(v); }
  get value(): string { return this.value_; }
  set disabled(v: boolean) { this.disabled_ = !!v; if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
  get disabled(): boolean { return this.disabled_; }
  set checked(v: boolean) { this.checked_ = !!v; }
  get checked(): boolean { return this.checked_; }
  set innerHTML(v: string) { this.innerHTML_ = String(v); }
  get innerHTML(): string { return this.innerHTML_; }

  set textContent(v: string) { this.text_ = v == null ? "" : String(v); this.childNodes = []; }
  get textContent(): string {
    if (this.kind === "text") return this.text_;
    let out = this.text_ || "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  addEventListener(type: string, fn: (ev: ShimEvent) => void): void { this.listeners[type] ||= []; this.listeners[type].push(fn); }
  removeEventListener(type: string, fn: (ev: ShimEvent) => void): void { const l = this.listeners[type]; if (!l) return; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  dispatchEvent(ev: ShimEvent): boolean { ev.target = ev.target ?? this; ev.currentTarget = this; for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev); return !ev.defaultPrevented; }
  click(): void { const ev: ShimEvent = { type: "click", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; this.dispatchEvent(ev); }
  focus(): void { /* no-op */ }

  walk(cb: (n: ShimNode) => void): void { for (const c of this.childNodes) { cb(c); c.walk(cb); } }
  matchesOne(sel: string): boolean {
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith("[")) { const m = /^\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(sel); if (!m) return false; const k = m[1]!; return m[2] === undefined ? this.hasAttribute(k) : this.getAttribute(k) === m[2]; }
    return this.nodeType === 1 && this.tagName === sel.toUpperCase();
  }
  matchesAny(selList: string): boolean { for (const sel of selList.split(",").map((s) => s.trim()).filter(Boolean)) if (this.matchesOne(sel)) return true; return false; }
  querySelector(sel: string): ShimNode | null { let found: ShimNode | null = null; this.walk((n) => { if (!found && n.nodeType === 1 && n.matchesAny(sel)) found = n; }); return found; }
  querySelectorAll(sel: string): ShimNode[] { const out: ShimNode[] = []; this.walk((n) => { if (n.nodeType === 1 && n.matchesAny(sel)) out.push(n); }); return out; }
}

class ShimElement extends ShimNode { constructor(tag: string) { super("element"); this.tagName = String(tag).toUpperCase(); this.localName = String(tag).toLowerCase(); } }

function installDomShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if ((g.document as { __shim?: boolean } | undefined)?.__shim) return;
  const body = new ShimElement("body");
  body.connectedRoot_ = true;
  g.document = {
    __shim: true,
    body,
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (t: string) => { const n = new ShimNode("text"); n.text_ = t == null ? "" : String(t); return n; },
    createDocumentFragment: () => new ShimNode("fragment"),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
    contains: () => false,
    get activeElement() { return null; },
    readyState: "complete",
  };
  g.Node = ShimNode;
  g.window = globalThis;
  if (!("location" in g)) g.location = { origin: "https://console.test" };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

installDomShim();

import type { Caller, RestoreApproval, EngineClient } from "../src/api.ts";
import { buildRunNameJoin, downpipeIdentityCell } from "../src/screens/restore-flow/shared.ts";
import { absoluteTime, relativeTime } from "../src/lib/format.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}

// waitFor drains until the OUTCOME holds, rather than for a fixed number of drain rounds, so it does not
// depend on machine speed. Every step below waits for the specific thing it is about to assert.
//
// Bounded, so a genuinely broken render still fails fast with the call site's own named assertion
// rather than hanging.
async function waitFor(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (done()) return;
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// waitForStable drains until `read()` returns the same value for `stableRounds` consecutive turns.
// The quiet window is deliberately wide (12 turns), because the root goes non-empty on its heading
// before the cards land: a short window can fall inside the gap between the heading painting and the
// queueMicrotask chain that builds the list. Paired with the deterministic listCalled gate in
// renderInbox, which fixes the start of the wait to the moment the screen actually has its data, a
// wide quiet window is a settle detector rather than a guess about machine speed.
// A presence check like "has some text" is not enough here, because a heading paints before the cards
// do. Quiescence is the property actually wanted, and unlike a round count it does not care how fast
// the machine is.
async function waitForStable(read: () => string, stableRounds = 12, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  let last = read();
  let steady = 0;
  while (Date.now() - started < timeoutMs) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    const now = read();
    steady = now === last ? steady + 1 : 0;
    last = now;
    // Non-empty AND stable. Stability alone is not enough: renderApprovalsInbox returns its root
    // synchronously and fills it only once the async listApprovals resolves, so an EMPTY root is
    // perfectly stable for as many rounds as that promise stays pending. Under contention that is
    // easily three rounds, which is exactly how the flake survived the first fix.
    if (steady >= stableRounds && now.length > 0) return;
  }
}
function textOf(node: ShimNode | null): string { return node ? node.textContent : ""; }
function docBody(): ShimNode { return (globalThis as unknown as { document: { body: ShimNode } }).document.body; }
// clickButtonByLabel finds the first enabled button whose text contains `label` under `root` and clicks it.
function clickButtonByLabel(root: ShimNode, label: string): boolean {
  const btn = root.querySelectorAll("button").find((b) => b.textContent.includes(label) && !b.disabled) ?? null;
  if (!btn) return false;
  btn.click();
  return true;
}

// makeApproval builds a real-shaped RestoreApproval (a pending request awaiting a second signer).
function makeApproval(over: Partial<RestoreApproval> = {}): RestoreApproval {
  const now = Date.now();
  return {
    planHash: over.planHash ?? "plan-hash-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runId: over.runId ?? "run_01",
    isLatest: over.isLatest ?? true,
    plannedWrites: over.plannedWrites ?? 42,
    bytes: over.bytes ?? 1024,
    redirectBinding: over.redirectBinding ?? null,
    requestedBy: over.requestedBy ?? "maker@example.com",
    requestedAt: over.requestedAt ?? new Date(now).toISOString(),
    reason: over.reason ?? "Recover the prod KV namespace after the bad deploy.",
    status: over.status ?? "requested",
    expiresAt: over.expiresAt ?? new Date(now + 24 * 3600 * 1000).toISOString(),
    ...(over.approvedBy !== undefined ? { approvedBy: over.approvedBy } : {}),
    ...(over.approvedAt !== undefined ? { approvedAt: over.approvedAt } : {}),
  };
}

async function main(): Promise<void> {
  const approvalsMod = await import("../src/screens/restore-flow/approvals.ts");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  // renderInbox drives the REAL renderApprovalsInbox with a given caller + a stubbed listApprovals (and an
  // optional throw so the degrade path is exercised). It captures the approve/reject calls the screen makes.
  interface EngineCalls { approve: string[]; reject: Array<{ planHash: string; reason: string }> }
  async function renderInbox(
    caller: Caller,
    listResult: RestoreApproval[] | (() => Promise<never>),
  ): Promise<{ root: ShimNode; calls: EngineCalls }> {
    store.setCaller(caller);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    const calls: EngineCalls = { approve: [], reject: [] };
    const e = engine as unknown as {
      listApprovals: () => Promise<RestoreApproval[]>;
      approveRestore: (planHash: string) => Promise<RestoreApproval>;
      rejectRestore: (planHash: string, rejectReason: string) => Promise<RestoreApproval>;
    };
    // The screen's own completion signal, not a guess. renderApprovalsInbox returns its root
    // synchronously and fills it only after listApprovals resolves, and the TEST owns that stub, so
    // the test can know exactly when the screen has been handed its data instead of draining turns
    // and hoping. Everything after this resolves is a synchronous DOM build, which the bounded
    // settle below covers.
    let listSettled: () => void = () => {};
    const listCalled = new Promise<void>((r) => { listSettled = r; });
    e.listApprovals =
      typeof listResult === "function"
        ? (async () => { try { return await listResult(); } finally { listSettled(); } }) as () => Promise<RestoreApproval[]>
        : async () => { try { return listResult; } finally { listSettled(); } };
    e.approveRestore = async (planHash: string) => { calls.approve.push(planHash); return makeApproval({ planHash, status: "approved" }); };
    e.rejectRestore = async (planHash: string, rejectReason: string) => { calls.reject.push({ planHash, reason: rejectReason }); return makeApproval({ planHash, status: "rejected" }); };
    const root = approvalsMod.renderApprovalsInbox(engine as unknown as EngineClient) as unknown as ShimNode;
    // Wait for the screen to have been handed its data, then for the ASYNC REGION to fill.
    //
    // The region is the real completion signal. renderApprovalsInbox (approvals.ts:33-48) appends a
    // static page header synchronously and an empty div.async-region beside it, and only fills that
    // region once listApprovals resolves. Waiting on the root's text could never distinguish "the
    // header painted" from "the inbox rendered", since the root is non-empty and perfectly stable
    // from the moment the header lands.
    await listCalled;
    const regionText = (): string => {
      const region = root.querySelectorAll("div").find((d) => String(d.className ?? "").includes("async-region"));
      return region ? region.textContent : "";
    };
    await waitFor(() => regionText().length > 0);
    await waitForStable(regionText);
    return { root, calls };
  }

  const approver = (email: string): Caller => ({ method: "access", email, role: "approver", groups: [], isOnlyOwner: false });

  // ------------------------------------------------------------------------
  console.log("\n-- a mix of mine / not-mine: Approve hidden on own request, present on another's --");
  // ------------------------------------------------------------------------
  {
    const mine = makeApproval({ planHash: "plan-mine-00000000000000000000000000", runId: "run_mine", requestedBy: "checker@example.com" });
    const theirs = makeApproval({ planHash: "plan-theirs-0000000000000000000000000", runId: "run_theirs", requestedBy: "maker@example.com" });
    const { root } = await renderInbox(approver("checker@example.com"), [mine, theirs]);
    const txt = textOf(root);
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("renders both runs", txt.includes("run_mine") && txt.includes("run_theirs"));
    ok("shows the maker-is-not-checker copy for the caller's own request", txt.includes("you cannot approve it"));
    // Exactly one Approve button (the other request), never two (the own request must not offer one).
    const approveBtns = buttons.filter((t) => t.includes("Approve"));
    ok("exactly one Approve button is offered (only on someone else's request)", approveBtns.length === 1);
    ok("a Reject button is offered on the other's request", buttons.some((t) => t.includes("Reject")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- a Viewer sees the role-gate note and no Approve, even on another's request --");
  // ------------------------------------------------------------------------
  {
    const viewer: Caller = { method: "access", email: "viewer@example.com", role: "viewer", groups: [], isOnlyOwner: false };
    const theirs = makeApproval({ requestedBy: "maker@example.com" });
    const { root } = await renderInbox(viewer, [theirs]);
    const txt = textOf(root);
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("the role-gate note names the Approver/Owner requirement", txt.includes("requires the Approver or Owner role"));
    ok("no Approve button for a Viewer", !buttons.some((t) => t.includes("Approve")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- 404/501 graceful-degrade renders the pending-engine note, not a hard error --");
  // ------------------------------------------------------------------------
  {
    // An older engine build answers 404 on GET /admin/restore/approvals. The screen must degrade honestly.
    // The engine client throws Error("<verb>: <status>") on a non-2xx; classifyError reads the trailing
    // status, so the message must end in the code for the 404/501 degrade branch to fire.
    const notFound = async (): Promise<never> => { throw new Error("list approvals: 404"); };
    const { root } = await renderInbox(approver("o@example.com"), notFound);
    const txt = textOf(root);
    ok("the degrade names that approvals are not supported on this engine build", txt.toLowerCase().includes("does not support restore approvals"));
    ok("the degrade does not blank the region", txt.trim().length > 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- an empty inbox renders the honest 'no pending approvals' state --");
  // ------------------------------------------------------------------------
  {
    const { root } = await renderInbox(approver("o@example.com"), []);
    ok("an empty inbox shows the 'no pending approvals' state", textOf(root).includes("No pending approvals"));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the approve / reject click paths reach the engine with the exact plan hash --");
  // ------------------------------------------------------------------------
  {
    // The card's Approve/Reject open a confirm modal (the real one mounts into document.body); confirming
    // there drives the engine call. The flow is exercised end to end with the stubbed engine: card button ->
    // confirm modal -> engine.approveRestore(planHash).
    const exactHash = "plan-exact-7777777777777777777777777";
    const theirs = makeApproval({ planHash: exactHash, requestedBy: "maker@example.com" });

    const { root, calls } = await renderInbox(approver("checker@example.com"), [theirs]);
    ok("an Approve button is present on the card", clickButtonByLabel(root, "Approve"));
    await waitForStable(() => textOf(docBody()));
    // The confirm modal is now mounted in document.body; confirm it (the modal's confirm label is "Approve").
    ok("confirm the approve in the modal", clickButtonByLabel(docBody(), "Approve"));
    await waitFor(() => calls.approve.length > 0);
    ok("approveRestore is called with the request's exact plan hash", calls.approve.length === 1 && calls.approve[0] === exactHash);

    docBody().replaceChildren();
    const { root: root2, calls: calls2 } = await renderInbox(approver("checker@example.com"), [theirs]);
    ok("a Reject button is present on the card", clickButtonByLabel(root2, "Reject"));
    await waitForStable(() => textOf(docBody()));
    // The confirm is the reason picker now. There is no bare "Reject" confirm to press, deliberately: a
    // rejection with no reason attached to it anywhere is the exact state the gap is about, and the only way to
    // reach the engine is to choose one of the closed members.
    ok("the reject confirm is the fixed reason picker (no bare confirm to skip it with)", clickButtonByLabel(docBody(), "Reject") === false);
    ok("the picker offers the closed reasons", clickButtonByLabel(docBody(), "Too broad"));
    await waitFor(() => calls2.reject.length > 0);
    ok("rejectRestore is called with the request's exact plan hash", calls2.reject.length === 1 && calls2.reject[0]?.planHash === exactHash);
    ok("and with the closed reason the checker chose", calls2.reject[0]?.reason === "too-broad");

    // Two rejections of the same plan for different reasons must reach the engine as different reasons, so
    // "wrong target" and "against policy" are never the identical request, the identical record or the
    // identical audit event, and the requester's "why was my restore rejected?" is answerable.
    docBody().replaceChildren();
    const { root: root3, calls: calls3 } = await renderInbox(approver("checker@example.com"), [theirs]);
    clickButtonByLabel(root3, "Reject");
    await flushAsync();
    clickButtonByLabel(docBody(), "Wrong target");
    await flushAsync();
    ok("a different reason reaches the engine as a different closed member", calls3.reject[0]?.reason === "wrong-target");
    ok("and the two rejections are not the same request", calls3.reject[0]?.reason !== calls2.reject[0]?.reason);

    // NO-CUSTODY: the picker is buttons, so there is nowhere for the approver's prose to be typed, and nothing
    // but a closed member can ever reach the wire.
    ok("the reason on the wire is a closed member", ["wrong-target", "too-broad", "stale-plan", "policy", "other"].includes(calls3.reject[0]?.reason ?? ""));

    // BACKING OUT records nothing: an approver who opens the picker and cancels has not rejected anything.
    docBody().replaceChildren();
    const { root: root4, calls: calls4 } = await renderInbox(approver("checker@example.com"), [theirs]);
    clickButtonByLabel(root4, "Reject");
    await flushAsync();
    clickButtonByLabel(docBody(), "Cancel");
    await flushAsync();
    ok("cancelling the picker rejects nothing", calls4.reject.length === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- self-identifying labels: buildRunNameJoin resolves a friendly downpipe name --");
  // ------------------------------------------------------------------------
  // buildRunNameJoin (shared.ts) is what names the run picker / run-context card / approval card instead of
  // a bare runId. It had ZERO direct coverage: every renderInbox() scenario above stubs only listApprovals,
  // so buildRunNameJoin's OWN (unstubbed) listAllHistory/listDownpipes calls hit the real EngineClient
  // against the fake "https://engine.test" origin, fail fast, and silently degrade to an empty join -- so
  // every "renders run_mine"-style assertion above was proving the RAW-ID FALLBACK, never actual name
  // resolution. These vectors stub listAllHistory/listDownpipes directly and drive buildRunNameJoin +
  // downpipeIdentityCell (the exact rendering primitive the run picker, run-context card and approval card
  // all share) directly, without going through the full inbox render.
  {
    const historyEngine = (over: { history?: () => Promise<never>; downpipes?: () => Promise<never> } = {}) =>
      ({
        listAllHistory:
          over.history ??
          (async () => ({
            byDownpipe: {
              "dp-marketing": [{ runId: "run_abc123", index: 1, startedAt: "2026-07-01T00:00:00.000Z", status: "ok" }],
            },
          })),
        listDownpipes: over.downpipes ?? (async () => [{ config: { id: "dp-marketing", name: "Marketing KV" } }]),
      }) as unknown as EngineClient;

    // Happy path: a retained run + a matching fleet name resolve to a friendly identity, and the shared
    // rendering primitive shows the name with the id as a secondary line.
    const happyJoin = await buildRunNameJoin(historyEngine());
    ok("happy path: the retained run resolves a RunIdentity keyed by downpipeId", happyJoin.get("run_abc123")?.downpipeId === "dp-marketing");
    ok("happy path: the RunIdentity carries the resolved friendly name", happyJoin.get("run_abc123")?.downpipeName === "Marketing KV");
    const happyCell = downpipeIdentityCell("dp-marketing", happyJoin.get("run_abc123")?.downpipeName) as unknown as ShimNode;
    ok("happy path: the shared identity cell renders the friendly name", textOf(happyCell).includes("Marketing KV"));
    ok("happy path: the shared identity cell still carries the id as a secondary line", textOf(happyCell).includes("dp-marketing"));

    // Miss (rolled off history): a run simply absent from every downpipe's retained ring (RING_CAP is a
    // fixed run count, not a time window, so a high-frequency downpipe's old run can legitimately age out).
    // NOT an error -- honestly unresolved. The caller falls back to the raw run id, never a fabricated name.
    const missJoin = await buildRunNameJoin(historyEngine());
    ok("miss: a run that rolled off history has no join entry", missJoin.get("run_never_seen") === undefined);
    const missCell = downpipeIdentityCell("run_never_seen", missJoin.get("run_never_seen")?.downpipeName) as unknown as ShimNode;
    ok("miss: the shared identity cell falls back to the raw run id alone", textOf(missCell).trim() === "run_never_seen");

    // A thrown listAllHistory: buildRunNameJoin must degrade to an EMPTY join, NEVER throw (a naming-only
    // fetch can never block or fail the restore surface it labels).
    const historyThrows = historyEngine({
      history: async () => {
        throw new Error("list history: 500");
      },
    });
    let threw = false;
    let throwJoin = new Map<string, unknown>();
    try {
      throwJoin = await buildRunNameJoin(historyThrows);
    } catch {
      threw = true;
    }
    ok("a thrown listAllHistory never throws out of buildRunNameJoin", threw === false);
    ok("a thrown listAllHistory degrades to an empty join", throwJoin.size === 0);

    // A thrown listDownpipes (history itself is fine): the join still keys every retained run by its
    // downpipeId, but NEVER fabricates a name -- downpipeName stays absent, not a guess.
    const namesThrow = historyEngine({
      downpipes: async () => {
        throw new Error("list downpipes: 500");
      },
    });
    const partialJoin = await buildRunNameJoin(namesThrow);
    ok("a thrown listDownpipes still resolves the downpipeId", partialJoin.get("run_abc123")?.downpipeId === "dp-marketing");
    ok("a thrown listDownpipes NEVER fabricates a name", partialJoin.get("run_abc123")?.downpipeName === undefined);
    const partialCell = downpipeIdentityCell("dp-marketing", partialJoin.get("run_abc123")?.downpipeName) as unknown as ShimNode;
    ok("a thrown listDownpipes renders the id alone, not a guessed name", textOf(partialCell).trim() === "dp-marketing");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the approver's own window: named on the card, past-tense once it has closed --");
  // ------------------------------------------------------------------------
  // WHY THIS EXISTS. The approval's window is real, bounded and enforced by the engine (approvals.ts
  // effectiveStatus reads "expired" past expiresAt, and both canApprove and canReject refuse a lapsed
  // record), and it is the APPROVER who has to act inside it: the docs state plainly that the time an
  // approver spends deciding comes out of the requester's remaining window. The card they deliberate on
  // rendered no window at all. expiresAt has been declared on RestoreApproval (types/rbac.ts) and required
  // since long before this, and the inbox read it nowhere; the owner-action card two screens over has
  // rendered the identical cue (screens/owner-actions.ts, cue(cues, "Expires", relativeTime(...))) all
  // along, so this follows that shape rather than inventing one.
  //
  // The assertions are on the TEXT AN APPROVER READS, not on the DOM around it, and they run as a set of
  // three so none of them is vacuous: a live record must name its window, a lapsed one must read in the
  // past tense AND withdraw the actions, and a record the engine sent no expiresAt for must get no window
  // row and must keep its actions (a guard that turns a missing value into a confident refusal is worse
  // than the gap it closes). A suite holding only the first would still pass on a card that printed a
  // fixed deadline regardless of the record.
  //
  // NO DURATION IS ASSERTED ANYWHERE HERE, deliberately. The engine owns APPROVAL_TTL_MS and
  // RESTORE_APPLY_LEASE_MS; a number typed into console copy or into this test is a second source of truth
  // that drifts. Every expectation below is derived from the instant the fixture record carries.
  {
    const liveAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const live = makeApproval({ planHash: "plan-live-1111111111111111111111111", runId: "run_live", requestedBy: "maker@example.com", expiresAt: liveAt });
    const { root } = await renderInbox(approver("checker@example.com"), [live]);
    const txt = textOf(root).replace(/\s+/g, " ");
    ok("a live request names when its approval window closes", txt.includes(`Expires${relativeTime(liveAt)}`));
    // The relative phrase is what an approver scans; the exact instant rides as the value's title, which is
    // format.ts's own stated contract for relativeTime ("The absolute time is shown as a title at the call
    // site for precision") and is the hover/assistive read.
    const titles = root.querySelectorAll("span").map((s) => String(s.getAttribute("title") ?? ""));
    ok("the exact instant is available for precision, not only the relative phrase", titles.includes(absoluteTime(liveAt)));
    ok("a live request still offers Approve", root.querySelectorAll("button").some((b) => b.textContent.includes("Approve")));
  }

  {
    // A record the engine handed over as still open whose deadline has since passed on the reader's clock.
    // This is genuinely reachable rather than hypothetical: the inbox's 15 s poll SKIPS its swap while focus
    // is inside the region (approvals.ts renderApprovalsInbox), so the approver who has tabbed to the Approve
    // button is exactly the reader whose card never refreshes its status.
    const lapsedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const lapsed = makeApproval({ planHash: "plan-lapsed-222222222222222222222222", runId: "run_lapsed", requestedBy: "maker@example.com", expiresAt: lapsedAt, status: "requested" });
    const { root } = await renderInbox(approver("checker@example.com"), [lapsed]);
    const txt = textOf(root).replace(/\s+/g, " ");
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("a lapsed request reads in the PAST tense, not as a window still open", txt.includes(`Expired${relativeTime(lapsedAt)}`) && !txt.includes("Expires"));
    ok("a lapsed request names the exact instant its window closed", txt.includes(absoluteTime(lapsedAt)));
    ok("a lapsed request offers no Approve (the engine refuses it, so the card must not read as actionable)", !buttons.some((t) => t.includes("Approve")));
    ok("a lapsed request offers no Reject either (canReject refuses an expired record just as canApprove does)", !buttons.some((t) => t.includes("Reject")));
    ok("the lapsed card says what to do instead", /raise a fresh request from a new dry run/i.test(txt));
    // Not vacuous: the rest of the card still rendered, so an empty region is not what passes the negatives.
    ok("the lapsed negative control is not vacuous: the card still renders its cues", txt.includes("run_lapsed") && txt.includes("Planned writes"));
  }

  {
    // The engine sent no expiresAt at all (an older build, or a record whose stored timestamp does not
    // parse -- engine approvals.ts approvalTimestampUnparseable is the engine's own name for that record).
    // The card must invent nothing, and it must NOT withdraw the actions: an absent value is not evidence
    // the window has closed, and the engine remains the authority on that either way.
    const noneAt = makeApproval({ planHash: "plan-none-3333333333333333333333333", runId: "run_none", requestedBy: "maker@example.com" }) as unknown as Record<string, unknown>;
    delete noneAt.expiresAt;
    const { root } = await renderInbox(approver("checker@example.com"), [noneAt as unknown as RestoreApproval]);
    const txt = textOf(root).replace(/\s+/g, " ");
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("no window is invented when the engine sent no expiresAt", !txt.includes("Expires") && !txt.includes("Expired"));
    ok("a missing expiresAt never becomes a confident refusal: Approve is still offered", buttons.some((t) => t.includes("Approve")));
    ok("the missing-value control is not vacuous: the card still renders its cues", txt.includes("run_none") && txt.includes("Planned writes"));
  }

  console.log(failures === 0 ? "\nALL RESTORE-APPROVALS VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Exit deterministically: the rendered inbox schedules a 15 s poll that legitimately outlives this test; a
  // late tick must never flip a green run.
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-RESTORE-APPROVALS THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
