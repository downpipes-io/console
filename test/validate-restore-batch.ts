// TC-restore-batch: the whole-account batch restore queue (/restore/batch, restore-flow/batch.ts).
// Run with: node test/validate-restore-batch.ts
//
// This is the load-bearing proof for the owner's binding safety decision: batching is UI ONLY. It
// RENDERS the real renderBatchQueue under a self-contained DOM shim (it never re-implements the code
// under test) and drives it through real clicks, asserting:
//   1. two rows (two different downpipes/runs) resolve to TWO DIFFERENT plan hashes from the real
//      client-side restorePlanHash mirror (api.ts), proving nothing here collapses distinct runs onto
//      one binding.
//   2. requesting approval for both rows fires TWO INDEPENDENT requestRestore calls, each carrying
//      exactly one row's own runId (never a list, never another row's data).
//   3. THE CORE PROPERTY: when the (stubbed) approvals list carries a usable approval for ONLY one
//      row's planHash, that row alone arms Apply -- the sibling row, awaiting approval on a DIFFERENT
//      planHash, stays unarmed. Approving one run never arms another.
//   4. a maker == checker approval (the same caller who raised the request) never arms Apply either
//      (the maker != checker mirror, shared.ts findUsableApproval, carries through unchanged).
//   5. a downpipe with no completed run, and a downpipe id no longer in the fleet, both render an
//      honest "blocked" row with no fabricated plan and no request/apply action -- never a silent gap.
//   6. duplicate ids in the ?ids= query collapse to ONE row (parseIds dedup).
//   7. the dry-run request shape for a batch row is the bare {runId} the single-run flow's own
//      "whole-run restore-in-place" corpus vector uses (validate-plan-hash.ts) -- no target, no
//      selectors, no cf-config/media/d1Tables: batch mode is deliberately the simple common case.

// ==========================================================================
// A minimal DOM shim (the same self-contained approach as validate-restore-approvals.ts /
// validate-owner-actions.ts): just enough surface for the rendered batch queue + its confirm/toast
// regions to run under plain node.
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

import type { Caller, RestoreApproval, RestorePlan, RestoreResult, DownpipeState, EngineClient } from "../src/api.ts";
import { restorePlanHash } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const cond = got === want;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  if (!cond) failures++;
}

async function flushAsync(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}
function textOf(node: ShimNode | null): string { return node ? node.textContent : ""; }
function _docBody(): ShimNode { return (globalThis as unknown as { document: { body: ShimNode } }).document.body; }
function clickButtonByLabel(root: ShimNode, label: string): boolean {
  const btn = root.querySelectorAll("button").find((b) => b.textContent.includes(label) && !b.disabled) ?? null;
  if (!btn) return false;
  btn.click();
  return true;
}
// findAllByDataset / rowFor walk the tree checking .dataset directly (this shim's dataset writes are a
// plain object, not reflected onto attrs the way a real browser mirrors element.dataset onto
// data-* attributes), so a CSS attribute selector like '[data-downpipe-id="x"]' would never match here.
function findAllByDataset(root: ShimNode, key: string, value: string): ShimNode[] {
  const out: ShimNode[] = [];
  root.walk((n) => { if (n.dataset[key] === value) out.push(n); });
  return out;
}
function rowFor(root: ShimNode, downpipeId: string): ShimNode | null {
  return findAllByDataset(root, "downpipeId", downpipeId)[0] ?? null;
}
function phaseOf(root: ShimNode, downpipeId: string): string | undefined {
  return rowFor(root, downpipeId)?.dataset.phase;
}
function planHashOf(root: ShimNode, downpipeId: string): string | undefined {
  const h = rowFor(root, downpipeId)?.dataset.planHash;
  return h === "" ? undefined : h;
}

function makeDownpipeState(id: string, name: string, lastRunId: string | null): DownpipeState {
  return {
    config: { id, name, cadenceSeconds: 86400, enabled: true, source: { type: "kv", binding: `KV_${id}` } },
    nextRunAt: 0,
    lastRunId,
    inFlight: false,
  } as unknown as DownpipeState;
}

function makePlan(runId: string, opts: { plannedWrites: number; bytes: number; isLatest?: boolean }): RestorePlan {
  return {
    ok: true,
    runId,
    mode: "dry-run",
    recordsVerified: opts.plannedWrites,
    isLatest: opts.isLatest ?? true,
    plannedWrites: opts.plannedWrites,
    bytes: opts.bytes,
    sample: [],
    skipped: [],
  };
}

function makeApproval(over: Partial<RestoreApproval> & { planHash: string; runId: string }): RestoreApproval {
  const now = Date.now();
  return {
    isLatest: true,
    plannedWrites: 1,
    bytes: 1,
    redirectBinding: null,
    requestedBy: "maker@example.com",
    requestedAt: new Date(now).toISOString(),
    reason: "batch restore",
    status: "requested",
    expiresAt: new Date(now + 24 * 3600 * 1000).toISOString(),
    ...over,
  };
}

const DP_A = "dp-aaaaaaaaaaaa";
const DP_B = "dp-bbbbbbbbbbbb";
const RUN_A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const RUN_B = "01ARZ3NDEKTSV4RRFFQ69G5FBB";
const ME = "operator@example.com";

async function main(): Promise<void> {
  const batchMod = await import("../src/screens/restore-flow/batch.ts");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  interface EngineCalls {
    restore: Array<Record<string, unknown>>;
    requestRestore: Array<{ runId: string; reason: string }>;
    listApprovals: number;
  }

  // renderQueueWith drives the REAL renderBatchQueue with a given ids list + downpipe/plan fixtures and
  // an injectable approvals-list responder, capturing every call the screen makes. Rebuilds the world
  // each time so scenarios are independent.
  async function renderQueueWith(opts: {
    ids: string[];
    downpipes: DownpipeState[];
    plansByRun: Record<string, RestorePlan>;
    approvalsResponder?: () => RestoreApproval[];
    // applyResponder overrides the confirm:true (apply) outcome so a test can drive the Apply phase: it may
    // return a RestoreResult or THROW (e.g. an "restore not approved" error to simulate an approval consumed
    // between arming and the click -- the race handler under test).
    applyResponder?: (req: Record<string, unknown>) => Promise<RestoreResult>;
  }): Promise<{ root: ShimNode; calls: EngineCalls }> {
    const caller: Caller = { method: "access", email: ME, role: "approver", groups: [], isOnlyOwner: false };
    store.setCaller(caller);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    const calls: EngineCalls = { restore: [], requestRestore: [], listApprovals: 0 };
    const e = engine as unknown as {
      listDownpipes: () => Promise<DownpipeState[]>;
      restore: (req: Record<string, unknown>) => Promise<RestorePlan | RestoreResult>;
      requestRestore: (req: { runId: string; reason: string }) => Promise<RestoreApproval>;
      listApprovals: () => Promise<RestoreApproval[]>;
      approveRestore: (planHash: string) => Promise<RestoreApproval>;
      getConfigApprovalPolicy: () => Promise<{ requireChangeNumber: boolean }>;
    };
    e.listDownpipes = async () => opts.downpipes;
    e.restore = async (req) => {
      calls.restore.push(req);
      const runId = req.runId as string;
      if (req.confirm === true) {
        if (opts.applyResponder) return opts.applyResponder(req); // may resolve a result OR throw (race)
        const plan = opts.plansByRun[runId];
        return {
          ok: true, runId, mode: "applied", recordsVerified: plan?.plannedWrites ?? 0,
          recordsRestored: plan?.plannedWrites ?? 0, bytesRestored: plan?.bytes ?? 0,
          isLatest: plan?.isLatest ?? true, failures: [],
        } satisfies RestoreResult;
      }
      return opts.plansByRun[runId] ?? { ok: false, runId, mode: "dry-run", recordsVerified: 0, isLatest: true, plannedWrites: 0, bytes: 0, sample: [], skipped: [], reason: "no fixture plan for this run" };
    };
    e.requestRestore = async (req) => {
      calls.requestRestore.push(req);
      const planHash = await restorePlanHash({ runId: req.runId });
      return makeApproval({ planHash, runId: req.runId, requestedBy: ME, status: "requested" });
    };
    e.listApprovals = async () => { calls.listApprovals++; return opts.approvalsResponder ? opts.approvalsResponder() : []; };
    e.getConfigApprovalPolicy = async () => ({ requireChangeNumber: false });

    // Build the query the SAME way the real entry point does (sources-downpipes/table.ts's "Restore..."
    // bulk action navigates to buildBatchUrl(ids)), so this test exercises the real encoding path rather
    // than a hand-rolled equivalent.
    const url = batchMod.buildBatchUrl(opts.ids);
    const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const root = batchMod.renderBatchQueue(engine as unknown as EngineClient, new URLSearchParams(qs)) as unknown as ShimNode;
    root.connectedRoot_ = true; // isConnected-gated poll behaves as it would in a live DOM
    await flushAsync();
    return { root, calls };
  }

  // ------------------------------------------------------------------------
  console.log("\n-- buildBatchUrl: the ids query round-trips through URLSearchParams intact --");
  // ------------------------------------------------------------------------
  {
    const url = batchMod.buildBatchUrl([DP_A, DP_B]);
    ok("the url targets /restore/batch", url.startsWith("/restore/batch?"));
    const parsed = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    eq("the ids param round-trips to the exact comma-joined list", parsed.get("ids"), `${DP_A},${DP_B}`);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- two rows resolve to two DIFFERENT plan hashes (the real client-side mirror) --");
  // ------------------------------------------------------------------------
  {
    const { root } = await renderQueueWith({
      ids: [DP_A, DP_B],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A), makeDownpipeState(DP_B, "Uploads R2", RUN_B)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 10, bytes: 1024 }), [RUN_B]: makePlan(RUN_B, { plannedWrites: 20, bytes: 2048 }) },
    });
    eq("row A reaches planned", phaseOf(root, DP_A), "planned");
    eq("row B reaches planned", phaseOf(root, DP_B), "planned");
    const hashA = planHashOf(root, DP_A);
    const hashB = planHashOf(root, DP_B);
    ok("row A carries a plan hash", !!hashA);
    ok("row B carries a plan hash", !!hashB);
    ok("the two rows' plan hashes DIFFER (distinct runs never collapse to one binding)", hashA !== hashB);
    // Independently verify each against the real client-side mirror (api.ts restorePlanHash) over the
    // bare {runId} request -- the shape a batch dry-run actually sends (see scenario 7 below).
    eq("row A's plan hash matches restorePlanHash({runId: RUN_A})", hashA, await restorePlanHash({ runId: RUN_A }));
    eq("row B's plan hash matches restorePlanHash({runId: RUN_B})", hashB, await restorePlanHash({ runId: RUN_B }));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- requesting approval for both rows fires two INDEPENDENT requestRestore calls --");
  // ------------------------------------------------------------------------
  {
    const { root, calls } = await renderQueueWith({
      ids: [DP_A, DP_B],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A), makeDownpipeState(DP_B, "Uploads R2", RUN_B)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 10, bytes: 1024 }), [RUN_B]: makePlan(RUN_B, { plannedWrites: 20, bytes: 2048 }) },
    });
    const reasonField = root.querySelector("#rsb-reason");
    ok("the shared reason field renders", reasonField !== null);
    if (reasonField) (reasonField as { value: string }).value = "DR rehearsal, both downpipes";
    ok("the bulk 'Request approval for all planned rows' button is present", clickButtonByLabel(root, "Request approval for all planned rows"));
    await flushAsync();
    eq("exactly two requestRestore calls were made (one per row)", calls.requestRestore.length, 2);
    const runIds = calls.requestRestore.map((r) => r.runId).sort();
    eq("the two calls carry the two rows' own distinct runIds, nothing shared", JSON.stringify(runIds), JSON.stringify([RUN_A, RUN_B].sort()));
    eq("row A reaches awaiting-approval", phaseOf(root, DP_A), "awaiting-approval");
    eq("row B reaches awaiting-approval", phaseOf(root, DP_B), "awaiting-approval");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- THE CORE PROPERTY: an approval for row A's plan hash arms ONLY row A, never row B --");
  // ------------------------------------------------------------------------
  {
    const hashA = await restorePlanHash({ runId: RUN_A });
    const hashB = await restorePlanHash({ runId: RUN_B });
    ok("sanity: the two hashes really do differ", hashA !== hashB);
    const { root } = await renderQueueWith({
      ids: [DP_A, DP_B],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A), makeDownpipeState(DP_B, "Uploads R2", RUN_B)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 10, bytes: 1024 }), [RUN_B]: makePlan(RUN_B, { plannedWrites: 20, bytes: 2048 }) },
      // The approvals list carries a genuinely usable, distinct-approver approval for row A's hash
      // ONLY. If the queue ever mis-keyed this (e.g. matched by index/position instead of planHash, or
      // aggregated "any approval means the batch is approved"), row B would wrongly arm too.
      approvalsResponder: () => [makeApproval({ planHash: hashA, runId: RUN_A, requestedBy: ME, status: "approved", approvedBy: "checker@example.com" })],
    });
    const reasonField = root.querySelector("#rsb-reason");
    if (reasonField) (reasonField as { value: string }).value = "DR rehearsal, both downpipes";
    clickButtonByLabel(root, "Request approval for all planned rows");
    await flushAsync();

    eq("row A (the approved hash) reaches approved", phaseOf(root, DP_A), "approved");
    eq("row B (a DIFFERENT hash, no approval for it) stays awaiting-approval", phaseOf(root, DP_B), "awaiting-approval");

    const rowAApplyPresent = rowFor(root, DP_A)!.querySelectorAll("button").some((b) => b.textContent.includes("Apply") && !b.disabled);
    const rowBApplyPresent = rowFor(root, DP_B)!.querySelectorAll("button").some((b) => b.textContent.includes("Apply") && !b.disabled);
    ok("row A offers an enabled Apply button", rowAApplyPresent);
    ok("row B offers NO Apply button (approving row A never arms row B)", !rowBApplyPresent);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- THE APPLY PHASE: race revert, generic failure, and success (was entirely unexercised) --");
  // ------------------------------------------------------------------------
  {
    const hashA = await restorePlanHash({ runId: RUN_A });
    const armRowA = () => ({
      ids: [DP_A],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 10, bytes: 1024 }) },
      approvalsResponder: () => [makeApproval({ planHash: hashA, runId: RUN_A, requestedBy: ME, status: "approved", approvedBy: "checker@example.com" })],
    });
    // 1) RACE: the approval is consumed / rejected / expired between arming and the click, so the engine
    //    403s "restore not approved". The row must revert to awaiting-approval (re-enter the poll for a
    //    fresh distinct-approver sign-off), NEVER a spurious apply-failed. This is the exact "approval
    //    expiring mid-sweep" race handler (batch.ts applyRowClick) that had zero coverage.
    {
      // The engine's real dual-control 403 shape: "<verb>: <reason>: <status>" (status trailing so
      // extractStatus finds it, reason substring so classifyError maps it to restore-unapproved).
      const { root } = await renderQueueWith({ ...armRowA(), applyResponder: async () => { throw new Error("apply restore: restore not approved: 403"); } });
      { const rf = root.querySelector("#rsb-reason"); if (rf) (rf as { value: string }).value = "batch apply phase test"; }
      clickButtonByLabel(root, "Request approval for all planned rows");
      await flushAsync();
      eq("row A is armed (approved) before the click", phaseOf(root, DP_A), "approved");
      clickButtonByLabel(root, "Apply"); // opens the danger confirm modal
      await flushAsync();
      clickButtonByLabel(document.body as unknown as ShimNode, "Apply restore"); // confirm it (requireChange policy is off)
      await flushAsync();
      eq("a mid-sweep approval race reverts row A to awaiting-approval (never a spurious apply-failed)", phaseOf(root, DP_A), "awaiting-approval");
      ok("the reverted row offers no enabled Apply (a distinct approver must sign again)", !rowFor(root, DP_A)!.querySelectorAll("button").some((b) => b.textContent.includes("Apply") && !b.disabled));
    }
    // 2) GENERIC failure: a non-race apply error lands the row in apply-failed, a distinct terminal state.
    {
      const { root } = await renderQueueWith({ ...armRowA(), applyResponder: async () => { throw new Error("Cloudflare API write failed"); } });
      { const rf = root.querySelector("#rsb-reason"); if (rf) (rf as { value: string }).value = "batch apply phase test"; }
      clickButtonByLabel(root, "Request approval for all planned rows");
      await flushAsync();
      clickButtonByLabel(root, "Apply"); // opens the danger confirm modal
      await flushAsync();
      clickButtonByLabel(document.body as unknown as ShimNode, "Apply restore"); // confirm it (requireChange policy is off)
      await flushAsync();
      eq("a generic apply error lands row A in apply-failed (distinct from the race revert)", phaseOf(root, DP_A), "apply-failed");
    }
    // 3) SUCCESS: the apply returns an applied RestoreResult -> applied, with exactly one confirm:true call.
    {
      const { root, calls } = await renderQueueWith({ ...armRowA(), applyResponder: async (req) => ({ ok: true, runId: req.runId as string, mode: "applied", recordsVerified: 10, recordsRestored: 10, bytesRestored: 1024, isLatest: true, failures: [] }) });
      { const rf = root.querySelector("#rsb-reason"); if (rf) (rf as { value: string }).value = "batch apply phase test"; }
      clickButtonByLabel(root, "Request approval for all planned rows");
      await flushAsync();
      clickButtonByLabel(root, "Apply"); // opens the danger confirm modal
      await flushAsync();
      clickButtonByLabel(document.body as unknown as ShimNode, "Apply restore"); // confirm it (requireChange policy is off)
      await flushAsync();
      eq("a successful apply lands row A in applied", phaseOf(root, DP_A), "applied");
      ok("apply issued exactly one confirm:true restore for row A", calls.restore.filter((r) => r.confirm === true && r.runId === RUN_A).length === 1);
    }
  }

  // ------------------------------------------------------------------------
  console.log("\n-- maker == checker: an approval 'approved' by the SAME caller who requested it never arms Apply --");
  // ------------------------------------------------------------------------
  {
    const hashA = await restorePlanHash({ runId: RUN_A });
    const { root } = await renderQueueWith({
      ids: [DP_A],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 10, bytes: 1024 }) },
      // approvedBy === ME (the same identity requesting AND "approving"): maker != checker must refuse
      // this the same way the single-run confirm gate does (shared.ts findUsableApproval).
      approvalsResponder: () => [makeApproval({ planHash: hashA, runId: RUN_A, requestedBy: ME, status: "approved", approvedBy: ME })],
    });
    const reasonField = root.querySelector("#rsb-reason");
    if (reasonField) (reasonField as { value: string }).value = "self-approval attempt";
    clickButtonByLabel(root, "Request approval for all planned rows");
    await flushAsync();
    eq("the row stays awaiting-approval (a self-approval never arms it)", phaseOf(root, DP_A), "awaiting-approval");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- honest blocked states: no completed run, and a downpipe no longer in the fleet --");
  // ------------------------------------------------------------------------
  {
    const DP_NORUN = "dp-norun";
    const DP_GONE = "dp-gone";
    const { root, calls } = await renderQueueWith({
      ids: [DP_NORUN, DP_GONE],
      downpipes: [makeDownpipeState(DP_NORUN, "Never run yet", null)], // DP_GONE deliberately absent
      plansByRun: {},
    });
    eq("a downpipe with no completed run renders blocked", phaseOf(root, DP_NORUN), "blocked");
    ok("its reason names 'no completed run'", textOf(rowFor(root, DP_NORUN)).toLowerCase().includes("no completed run"));
    eq("a downpipe missing from the fleet also renders blocked", phaseOf(root, DP_GONE), "blocked");
    ok("its reason names that the downpipe no longer exists", textOf(rowFor(root, DP_GONE)).toLowerCase().includes("no longer exists"));
    eq("neither blocked row triggered a dry-run request (nothing to plan)", calls.restore.length, 0);
    // Check WITHIN each blocked row's own subtree (not the whole page: the shared "Request approval for
    // all planned rows" bulk button legitimately renders regardless, since it is a no-op when nothing is
    // planned -- requestAllPlanned's own empty-targets toast proves that path separately).
    ok("the no-run row offers no per-row Request-approval button", !rowFor(root, DP_NORUN)!.querySelectorAll("button").some((b) => b.textContent.includes("Request approval")));
    ok("the gone-downpipe row offers no per-row Request-approval button", !rowFor(root, DP_GONE)!.querySelectorAll("button").some((b) => b.textContent.includes("Request approval")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- duplicate ids in ?ids= collapse to ONE row --");
  // ------------------------------------------------------------------------
  {
    const { root } = await renderQueueWith({
      ids: [DP_A, DP_A, DP_A],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 5, bytes: 100 }) },
    });
    eq("exactly one row renders for a tripled id", findAllByDataset(root, "downpipeId", DP_A).length, 1);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- the batch dry-run request shape is the bare {runId} whole-run vector, nothing else --");
  // ------------------------------------------------------------------------
  {
    const { calls } = await renderQueueWith({
      ids: [DP_A],
      downpipes: [makeDownpipeState(DP_A, "Orders KV", RUN_A)],
      plansByRun: { [RUN_A]: makePlan(RUN_A, { plannedWrites: 5, bytes: 100 }) },
    });
    ok("exactly one dry-run request was made", calls.restore.length === 1);
    const req = calls.restore[0]!;
    eq("the request carries runId", req.runId, RUN_A);
    const keys = Object.keys(req).sort();
    eq("the request carries NO other field (no target/include/exclude/recordName/cfConfig/mediaRestore/d1Tables)", JSON.stringify(keys), JSON.stringify(["runId"]));
  }

  console.log(failures === 0 ? "\nALL RESTORE-BATCH VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Exit deterministically: the rendered queue schedules a 15 s poll that legitimately outlives this
  // test; a late tick must never flip a green run.
  if (failures > 0) process.exitCode = 1;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-RESTORE-BATCH THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
