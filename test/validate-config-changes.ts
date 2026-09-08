// The config change-control (four-eyes / dual-control) console surface.
// Run with: node test/validate-config-changes.ts
//
// Coverage (the load-bearing behaviours of the new gate UI):
//   PURE helpers (lib/config-changes.ts), no DOM:
//     - diffLines normalises the engine's PendingChangeLine[] (an array of { kind, area, text } objects,
//       NEVER a bare string) to clean non-empty lines, without throwing (F-W2-15 regression: an earlier
//       version assumed each element was a string and called .replace on it, which threw the moment a
//       real engine's object-shaped diff reached the checker's inbox, so it rendered no card at all)
//     - changeApproveCapability maps each kind to the right write capability (and null for unknown)
//     - isMine is the maker != checker mirror (own proposal by email; token path is never "mine")
//     - roleCanApproveConfigChange / callerCanApproveConfigChange surface the rail only to approver-ish
//       roles (a viewer cannot, an operator/owner/access-admin can; a custom role by its capability set)
//   202 handling (src/api.ts), real EngineClient over a stubbed fetch:
//     - a CONFIG MUTATION that returns HTTP 202 + { pending: true, id } resolves to { status:"pending",
//       changeId } (NOT a throw, NOT an applied value)
//     - a 200 resolves to { status:"applied", value } (the gate-off path is unchanged)
//     - isPendingChangeBody guards the deferred body shape
//   REAL screen render (a minimal DOM shim drives the production code):
//     - the Change requests screen renders a pending change with its plain-English diff + proposer
//     - Approve is HIDDEN on a caller's OWN proposal, with the explicit "you proposed this" awaiting copy
//     - Approve is PRESENT on a change proposed by someone else (a distinct approver)
//     - the Security Centre four-eyes toggle is READ-ONLY (disabled) for a non-owner and SETTABLE
//       (enabled) for an owner, after the policy loads
//     - surfacePendingChange emits a "queued for approval" toast, NEVER a "saved" one
//
// Like validate-api.ts this RENDERS the real code under a self-contained DOM shim (it never
// re-implements the code under test); it exits deterministically because the rendered screen schedules
// production timers (the inbox poll, a toast auto-dismiss) that legitimately outlive the test.

import {
  type Caller,
  type ConfigChange,
  EngineClient,
  isAppliedResult,
  isPendingChangeBody,
  isPendingResult,
  type MutationResult,
  type PendingChangeLine,
} from "../src/api.ts";
import {
  CONFIG_WRITE_CAPS,
  callerCanApproveConfigChange,
  changeApproveCapability,
  changeKindLabel,
  diffKindLabel,
  diffLines,
  isMine,
  roleCanApproveConfigChange,
} from "../src/lib/config-changes.ts";
import { classifyError } from "../src/lib/errors.ts";

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

// ==========================================================================
// A minimal DOM shim (same approach as validate-api.ts): just enough surface for the rendered
// change-requests screen + the security-centre toggle + the toast region to run under plain node. It
// never re-implements the code under test; it only lets the production render execute.
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
  // disabled mirrors the attribute (the production switch sets el.disabled; the test reads it), so a
  // disabled button shows up both as the property and as a "disabled" attribute.
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

// The screen's async render tree is typically 3 to 5 microtask+macrotask pairs deep; 30 is a
// generous upper bound that drains it without polling for a specific element.
const FLUSH_ROUNDS = 30;
async function flushAsync(rounds = FLUSH_ROUNDS): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}
function textOf(node: ShimNode | null): string { return node ? node.textContent : ""; }

// docBody returns the shimmed document.body (where toast regions are appended), so the test can read the
// toast copy the screen emitted.
function docBody(): ShimNode { return (globalThis as unknown as { document: { body: ShimNode } }).document.body; }

// ==========================================================================
// makeChange builds a real-shaped ConfigChange. diffLine is a terse PendingChangeLine constructor (the
// engine's real diff shape: an object, not a string) for the tests below; kind defaults to "changed",
// the common case for a save.
// ==========================================================================
function diffLine(text: string, kind: PendingChangeLine["kind"] = "changed", area = "downpipe"): PendingChangeLine {
  return { kind, area, text };
}
function makeChange(over: Partial<ConfigChange> = {}): ConfigChange {
  return {
    id: over.id ?? "chg_01",
    kind: over.kind ?? "downpipe-upsert",
    proposedBy: over.proposedBy === undefined ? "maker@example.com" : over.proposedBy,
    proposedAt: over.proposedAt ?? new Date().toISOString(),
    diff: over.diff ?? [diffLine("Save downpipe \"prod-kv\": cadence 1h -> 6h")],
    status: over.status ?? "pending",
    ...(over.approvedBy !== undefined ? { approvedBy: over.approvedBy } : {}),
    ...(over.approvedAt !== undefined ? { approvedAt: over.approvedAt } : {}),
  };
}

// stubFetch installs a global fetch that answers a single canned Response, so a real EngineClient method
// exercises the real parseJsonOrPending branch. Returns a restore function.
function stubFetch(status: number, body: unknown): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  g.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
    clone() { return this; },
  });
  return () => { g.fetch = prev; };
}

// Each numbered concern is its own named async function so a failure points at one section
// rather than a 200-line monolith. main() is a thin sequencer (guardrails section 6, the 50-line
// function flag).

async function testPureHelpers(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- PURE: diffLines / changeApproveCapability / kind label --");
  // ------------------------------------------------------------------------
  {
    // The engine's real PendingChangeLine[] is an ARRAY OF OBJECTS
    // { kind, area, text }, never a bare string. The old diffLines assumed each element was a string and
    // called String.prototype.replace on it directly, which threw "x.replace is not a function" the
    // moment a real engine's diff reached it, so the checker's config-approvals inbox rendered no card.
    const objectDiff: PendingChangeLine[] = [
      diffLine("downpipe kv:sessions added", "added", "downpipe"),
      diffLine("  ", "changed", "downpipe"), // a blank/whitespace-only text line is dropped
      diffLine("alice: operator -> approver  ", "changed", "role"), // trailing whitespace is trimmed
    ];
    let threw = false;
    let normalised: PendingChangeLine[] = [];
    try { normalised = diffLines(objectDiff); } catch { threw = true; }
    ok("diffLines renders the real {kind,area,text} object diff WITHOUT THROWING", threw === false);
    eq(normalised.length, 2, "diffLines: the object diff drops the blank/whitespace-only line (2 of 3 kept)");
    eq(normalised[0]?.text, "downpipe kv:sessions added", "diffLines: a kept line's text is preserved");
    eq(normalised[0]?.kind, "added", "diffLines: kind passes through unchanged");
    eq(normalised[0]?.area, "downpipe", "diffLines: area passes through unchanged");
    eq(normalised[1]?.text, "alice: operator -> approver", "diffLines: trailing whitespace is trimmed off text");

    eq(diffLines([]).length, 0, "diffLines: empty array -> no lines");
    // Defensive: a non-array (a malformed body) never throws; it degrades to no lines.
    eq(diffLines(null as unknown as PendingChangeLine[]).length, 0, "diffLines: a non-array degrades to no lines, never throws");
    // Defensive: one element missing a string text is skipped, not fatal to the whole card.
    const malformedElement = [{ kind: "changed", area: "downpipe" } as unknown as PendingChangeLine, diffLine("kept")];
    eq(diffLines(malformedElement).length, 1, "diffLines: an element without a string text is skipped; the rest still render");

    eq(diffKindLabel("added"), "added", "diffKindLabel: added");
    eq(diffKindLabel("removed"), "removed", "diffKindLabel: removed");
    eq(diffKindLabel("changed"), "changed", "diffKindLabel: changed");

    // These are the engine's OWN dash-form wire values (admin/change-control.ts's ConfigChangeKind). All
    // 18 kinds are asserted here so a rename on either side is caught by this test.
    eq(changeApproveCapability("downpipe-upsert"), "downpipe.write", "downpipe-upsert -> downpipe.write");
    eq(changeApproveCapability("downpipe-delete"), "downpipe.delete", "downpipe-delete -> downpipe.delete");
    eq(changeApproveCapability("role-set"), "roles.write", "role-set -> roles.write");
    eq(changeApproveCapability("role-delete"), "roles.write", "role-delete -> roles.write");
    // group-role-set/delete need access.policy, NOT roles.write -- the console's pre-fix map had this
    // capability wrong too (a second drift beyond the dot/dash naming mismatch), caught by re-deriving
    // the capability from the engine's own CHANGE_WRITE_CAPABILITY rather than carrying the old value
    // forward under the new key.
    eq(changeApproveCapability("group-role-set"), "access.policy", "group-role-set -> access.policy");
    eq(changeApproveCapability("group-role-delete"), "access.policy", "group-role-delete -> access.policy");
    eq(changeApproveCapability("custom-role-set"), "access.policy", "custom-role-set -> access.policy");
    eq(changeApproveCapability("custom-role-delete"), "access.policy", "custom-role-delete -> access.policy");
    eq(changeApproveCapability("notify-channel-set"), "notify.config", "notify-channel-set -> notify.config");
    eq(changeApproveCapability("notify-channel-delete"), "notify.config", "notify-channel-delete -> notify.config");
    eq(changeApproveCapability("notify-rule-set"), "notify.config", "notify-rule-set -> notify.config");
    eq(changeApproveCapability("notify-rule-delete"), "notify.config", "notify-rule-delete -> notify.config");
    eq(changeApproveCapability("posture-accept"), "posture.riskaccept", "posture-accept -> posture.riskaccept");
    eq(changeApproveCapability("posture-unaccept"), "posture.riskaccept", "posture-unaccept -> posture.riskaccept");
    eq(changeApproveCapability("expiry-item-set"), "expiry.config", "expiry-item-set -> expiry.config");
    eq(changeApproveCapability("expiry-item-delete"), "expiry.config", "expiry-item-delete -> expiry.config");
    // The two kinds the console never had a member for at all, engine-only until this fix.
    eq(changeApproveCapability("coverage-inventory"), "access.policy", "coverage-inventory -> access.policy");
    eq(changeApproveCapability("cf-config-mode-set"), "downpipe.write", "cf-config-mode-set -> downpipe.write");
    eq(changeApproveCapability("totally-unknown-kind"), null, "an unknown kind -> null (defer to engine)");
    eq(changeKindLabel("downpipe-upsert"), "Save a downpipe", "changeKindLabel maps a known kind");
    eq(changeKindLabel("notify-channel-set"), "Save a notification channel", "changeKindLabel maps the live-confirmed kind");
    // The un-fixed failure mode, still proven live: a kind newer than this console build renders its raw
    // wire string rather than a blank or dropped card. An empty card would be worse than a raw id, since the
    // approver would have nothing at all to decide against.
    eq(changeKindLabel("totally-unknown-kind"), "totally-unknown-kind", "changeKindLabel falls back to the raw kind for an unrecognised one");
  }

  // ------------------------------------------------------------------------
  console.log("\n-- PURE: isMine (maker != checker mirror) --");
  // ------------------------------------------------------------------------
  {
    const c = makeChange({ proposedBy: "ada@example.com" });
    ok("isMine true when the caller is the proposer (by email)", isMine(c, "ada@example.com") === true);
    ok("isMine false when the caller is someone else", isMine(c, "grace@example.com") === false);
    ok("isMine false for a null caller email (whoami pending)", isMine(c, null) === false);
    const tokenChange = makeChange({ proposedBy: null });
    ok("isMine false when the change has no attributable proposer (token path)", isMine(tokenChange, "ada@example.com") === false);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- PURE: which roles can approve (rail surfacing) --");
  // ------------------------------------------------------------------------
  {
    ok("a viewer canNOT approve any config change (rail hidden)", roleCanApproveConfigChange("viewer") === false);
    ok("an operator CAN approve (holds downpipe.write etc.)", roleCanApproveConfigChange("operator") === true);
    ok("an approver CAN approve", roleCanApproveConfigChange("approver") === true);
    ok("an owner CAN approve", roleCanApproveConfigChange("owner") === true);
    ok("an access-admin CAN approve (holds roles.write/access.policy)", roleCanApproveConfigChange("access-admin") === true);
    // restore-operator holds only the recovery surface, none of the config write caps.
    ok("a restore-operator canNOT approve a config change", roleCanApproveConfigChange("restore-operator") === false);

    const viewerCaller: Caller = { method: "access", email: "v@x", role: "viewer", groups: [], isOnlyOwner: false };
    ok("callerCanApproveConfigChange false for a viewer caller", callerCanApproveConfigChange(viewerCaller) === false);
    ok("callerCanApproveConfigChange false for a null caller", callerCanApproveConfigChange(null) === false);
    // A custom role pinned to the viewer floor but holding a config write capability surfaces the item.
    const customApprover: Caller = {
      method: "access", email: "c@x", role: "viewer", groups: [], isOnlyOwner: false,
      customCapabilities: ["downpipe.read", "notify.config"],
    };
    ok("callerCanApproveConfigChange true for a custom role holding a config write cap", callerCanApproveConfigChange(customApprover) === true);
    const customReader: Caller = {
      method: "access", email: "c2@x", role: "viewer", groups: [], isOnlyOwner: false,
      customCapabilities: ["downpipe.read", "audit.read"],
    };
    ok("callerCanApproveConfigChange false for a read-only custom role", callerCanApproveConfigChange(customReader) === false);
    ok("CONFIG_WRITE_CAPS is non-empty (the union of approve caps)", CONFIG_WRITE_CAPS.length > 0);
  }
}

async function test202Handling(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- 202 HANDLING: a deferred config mutation resolves to pending, not a throw --");
  // ------------------------------------------------------------------------
  {
    // The fixture is the engine's OWN 202 shape, not an invented one. The engine has exactly one gated-config
    // 202 (src/sched/scheduler-do.ts):
    //
    //     return this.jsonStatus({ queued: true, id: p.id, status: p.status, contentHash: p.contentHash }, 202);
    //
    // A contract fixture may only assert a row the product can actually produce, or the console can read a
    // real queued 202 as an applied change and tell the operator "Saved" for a mutation that had not taken
    // effect.
    const ENGINE_GATED_CONFIG_202 = { queued: true, id: "chg_9", status: "pending", contentHash: "sha256:abc" };
    ok("isPendingChangeBody true for the engine's real { queued:true, id, ... } body", isPendingChangeBody(ENGINE_GATED_CONFIG_202) === true);
    ok("isPendingChangeBody FALSE for the fabricated { pending:true } body no engine sends", isPendingChangeBody({ pending: true, id: "chg_9" }) === false);
    ok("isPendingChangeBody false for a normal applied record", isPendingChangeBody({ id: "dp_1", config: {} }) === false);
    ok("isPendingChangeBody false for null", isPendingChangeBody(null) === false);
    ok("isPendingChangeBody false when queued is not true", isPendingChangeBody({ queued: false, id: "x" }) === false);
    ok("isPendingChangeBody false when id is empty", isPendingChangeBody({ queued: true, id: "" }) === false);

    const engine = new EngineClient("https://engine.test");

    // A 202 + the engine's queued body: addDownpipe resolves to { status:"pending", changeId } and does NOT throw.
    {
      const restore = stubFetch(202, { queued: true, id: "chg_202", status: "pending", contentHash: "sha256:def" });
      let result: MutationResult<unknown> | null = null;
      let threw = false;
      try { result = await engine.addDownpipe({ id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }); }
      catch { threw = true; }
      restore();
      ok("a 202 does NOT throw (resolves to a discriminated result)", threw === false);
      ok("a 202 resolves to status 'pending'", result !== null && result.status === "pending");
      ok("the pending result carries the change id", result !== null && result.status === "pending" && result.changeId === "chg_202");
      ok("isPendingResult narrows the 202 result", result !== null && isPendingResult(result));
    }

    // A 202 whose body does NOT carry the pending shape must throw an honest error, never resolve to a
    // fabricated "applied" value: a naive parse of `{}` here would resolve to { status:"applied", value:{} }
    // and the console would show a success toast while the engine's own state never moved.
    {
      const restore = stubFetch(202, {});
      let result: MutationResult<unknown> | null = null;
      let threw = false;
      let caught: unknown;
      try { result = await engine.addDownpipe({ id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }); }
      catch (e) { threw = true; caught = e; }
      restore();
      ok("a malformed 202 (valid JSON, wrong shape) THROWS rather than resolving", threw === true);
      ok("a malformed 202 never resolves to a value", result === null);
      const outcome = classifyError(caught);
      ok("the throw classifies as answer-unreadable (the engine answered; only the body is unreadable)", outcome.kind === "answer-unreadable");
      ok("the classified status is 202, not misread as a bare reachability fault", outcome.kind === "answer-unreadable" && outcome.status === 202);
    }

    // The other half of "malformed OR unparseable": a 202 body that is not even valid
    // JSON (truncated) must ALSO throw honestly, never resolve. addDownpipe shares parseJsonOrPending
    // with every other config mutation (setRole, upsertNotifyChannel, acceptPostureRisk, ...).
    {
      const g = globalThis as unknown as Record<string, unknown>;
      const prevFetch = g.fetch;
      g.fetch = async () => ({
        ok: true,
        status: 202,
        async text() { return '{"queued":true,'; }, // truncated: JSON.parse throws
        async json() { throw new Error("not reached"); },
        clone() { return this; },
      });
      let threw = false;
      let caught: unknown;
      try { await engine.addDownpipe({ id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }); }
      catch (e) { threw = true; caught = e; }
      g.fetch = prevFetch;
      ok("an unparseable 202 body (truncated JSON) also THROWS rather than resolving", threw === true);
      ok("the unparseable-202 throw also classifies as answer-unreadable", classifyError(caught).kind === "answer-unreadable");
    }

    // A 200 applied record: addDownpipe resolves to { status:"applied", value } (gate-off path unchanged).
    {
      const applied = { config: { id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } }, nextRunAt: 0, lastRunId: null, inFlight: false };
      const restore = stubFetch(200, applied);
      const result = await engine.addDownpipe({ id: "dp", name: "dp", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV", include: [], exclude: [] } });
      restore();
      ok("a 200 resolves to status 'applied'", result.status === "applied");
      ok("isAppliedResult narrows the 200 result", isAppliedResult(result));
      ok("the applied result carries the engine value", result.status === "applied" && (result.value as { nextRunAt: number }).nextRunAt === 0);
    }

    // setConfigApprovalPolicy round-trips the boolean (the owner toggle's write). A plain 200 (the common
    // ARM path, and a DISARM with no second owner to queue for) resolves to status:"result" (an
    // OwnerActionResult so a queued disarm is distinguishable from an applied one -- see the "disarm
    // queues" case below).
    {
      const restore = stubFetch(200, { requireConfigApproval: true });
      const res = await engine.setConfigApprovalPolicy(true);
      restore();
      ok("setConfigApprovalPolicy (200) resolves to status:'result'", res.status === "result");
      ok("setConfigApprovalPolicy returns the new policy", res.status === "result" && res.value.requireConfigApproval === true);
    }
    // A DISARM the engine defers to a second owner (202 + OwnerActionQueued) must resolve to
    // status:"queued", never be silently read as an applied ConfigApprovalPolicy with requireConfigApproval
    // undefined (which the caller would have read as false -- "the gate turned off" -- while it is, correctly,
    // still on).
    {
      const restore = stubFetch(202, { ownerActionQueued: true, id: "oa-1", status: "pending" });
      const res = await engine.setConfigApprovalPolicy(false);
      restore();
      ok("setConfigApprovalPolicy (202 queued) resolves to status:'queued', not a false-applied policy", res.status === "queued");
      ok("the queued result carries the owner-action id", res.status === "queued" && res.queued.id === "oa-1");
    }
    // listConfigChanges returns the inbox array.
    {
      const restore = stubFetch(200, [makeChange()]);
      const list = await engine.listConfigChanges();
      restore();
      ok("listConfigChanges returns the pending list", Array.isArray(list) && list.length === 1);
    }
  }
}

async function testInboxScreen(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- SCREEN: the Change requests inbox renders a pending change + maker != checker --");
  // ------------------------------------------------------------------------
  const screenMod = await import("../src/screens/config-changes.ts");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  // renderInbox renders the real screen for a given caller + canned change list, by stubbing the engine's
  // listConfigChanges, and returns the rendered root once it has loaded.
  async function renderInbox(callerEmail: string | null, role: "owner" | "operator" | "viewer", changes: ConfigChange[]): Promise<ShimNode> {
    const c: Caller = { method: "access", email: callerEmail, role, groups: [], isOnlyOwner: false };
    store.setCaller(c);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    (engine as unknown as { listConfigChanges: () => Promise<ConfigChange[]> }).listConfigChanges = async () => changes;
    const root = screenMod.configChangesScreen.render({
      pattern: "/config/changes", params: {}, query: new URLSearchParams(), path: "/config/changes",
      engine, caller: c, navigate: () => {},
    }) as unknown as ShimNode;
    await flushAsync();
    return root;
  }

  {
    // A change proposed by SOMEONE ELSE: the diff + proposer show, and Approve is offered. The diff is the
    // engine's real PendingChangeLine[] object shape (F-W2-15): rendering it end to end through the actual
    // screen (not just the pure diffLines helper) proves the real-screen render path does not crash on it.
    const other = makeChange({ id: "chg_other", proposedBy: "maker@example.com", diff: [diffLine("Save downpipe \"prod-kv\": cadence 1h -> 6h")] });
    const root = await renderInbox("checker@example.com", "owner", [other]);
    const txt = textOf(root);
    ok("renders the change's plain-English diff", txt.includes("cadence 1h -> 6h"));
    ok("renders who proposed it", txt.includes("maker@example.com"));
    ok("renders the kind label", txt.includes("Save a downpipe"));
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("offers an Approve button on someone else's change", buttons.some((t) => t.includes("Approve")));
    ok("offers a Reject button on someone else's change", buttons.some((t) => t.includes("Reject")));
    // The own-proposal cue is now a one-line hint, not a banner (the per-card banner stacked on
    // every own proposal); the assertion matches the new copy's stable lead.
    ok("does NOT show the 'you proposed this' note for a distinct approver", !txt.includes("You proposed this"));
  }

  {
    // A change the CALLER proposed: Approve is HIDDEN, the explicit awaiting copy shows, Withdraw is offered.
    const mine = makeChange({ id: "chg_mine", proposedBy: "checker@example.com" });
    const root = await renderInbox("checker@example.com", "owner", [mine]);
    const txt = textOf(root);
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("HIDES Approve on the caller's own proposal (maker != checker)", !buttons.some((t) => t.includes("Approve")));
    // New contract: the own-proposal cue is a single hint line ("You proposed this; awaiting a
    // different approver (maker is not checker)."), replacing the stacked per-card info banner.
    ok("shows the explicit 'you proposed this' awaiting copy", txt.includes("You proposed this; awaiting a different approver"));
    ok("the maker-is-not-checker rule stays explicit on an own proposal", txt.includes("maker is not checker"));
    ok("offers Withdraw on the caller's own proposal", buttons.some((t) => t.includes("Withdraw")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- SCREEN: Approve/Reject surface a failed engine call (security-critical error path) --");
  // ------------------------------------------------------------------------
  // clickByText finds a rendered button by its trimmed label and dispatches a click.
  const clickByText = (root: ShimNode, label: string): boolean => {
    const btn = root.querySelectorAll("button").find((b) => b.textContent.trim() === label || b.textContent.includes(label));
    if (!btn) return false;
    (btn as unknown as { click: () => void }).click();
    return true;
  };

  // driveAction renders the inbox for a stubbed engine whose action() rejects, clicks the card
  // action button, confirms the modal, then returns the toast copy the screen emitted.
  async function driveAction(cardLabel: string, modalConfirmLabel: string, stub: (engine: unknown) => void): Promise<string> {
    const store = await import("../src/lib/store.ts");
    const other = makeChange({ id: "chg_err", proposedBy: "maker@example.com" });
    const c: Caller = { method: "access", email: "checker@example.com", role: "owner", groups: [], isOnlyOwner: false };
    store.setCaller(c);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    (engine as unknown as { listConfigChanges: () => Promise<ConfigChange[]> }).listConfigChanges = async () => [other];
    stub(engine);
    const root = screenMod.configChangesScreen.render({
      pattern: "/config/changes", params: {}, query: new URLSearchParams(), path: "/config/changes",
      engine, caller: c, navigate: () => {},
    }) as unknown as ShimNode;
    await flushAsync();
    clickByText(root, cardLabel);
    await flushAsync();
    // The confirm modal mounts into document.body; confirm it to trigger the engine call.
    clickByText(docBody(), modalConfirmLabel);
    await flushAsync();
    return textOf(docBody());
  }

  {
    const txt = await driveAction("Approve", "Approve", (engine) => {
      (engine as { approveConfigChange: (id: string) => Promise<void> }).approveConfigChange = async () => { throw new Error("HTTP 403: not permitted"); };
    });
    ok("a failed approve surfaces a 'Could not approve' toast, not a false success", txt.includes("Could not approve"));
    ok("a failed approve does NOT show the success copy", !txt.includes("Change approved and applied"));
  }

  {
    const txt = await driveAction("Reject", "Reject", (engine) => {
      (engine as { rejectConfigChange: (id: string) => Promise<void> }).rejectConfigChange = async () => { throw new Error("HTTP 500: engine error"); };
    });
    ok("a failed reject surfaces a 'Could not reject' toast, not a false success", txt.includes("Could not reject"));
    ok("a failed reject does NOT show the success copy", !txt.includes("Change rejected"));
  }
}

async function testSecurityCentreToggle(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- SCREEN: the Security Centre four-eyes toggle (owner vs non-owner) --");
  // ------------------------------------------------------------------------
  const store = await import("../src/lib/store.ts");
  const scMod = await import("../src/screens/security-centre.ts");

  async function renderSecurityCentre(role: "owner" | "operator"): Promise<ShimNode> {
    const c: Caller = { method: "access", email: "u@x", role, groups: [], isOnlyOwner: false };
    store.setCaller(c);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    // Stub every read the security centre kicks off so only the toggle's behaviour is under test.
    (engine as unknown as { getConfigApprovalPolicy: () => Promise<{ requireConfigApproval: boolean }> }).getConfigApprovalPolicy = async () => ({ requireConfigApproval: false });
    (engine as unknown as { getPosture: () => Promise<unknown> }).getPosture = async () => ({ score: 100, generatedAt: new Date().toISOString(), checks: [] });
    (engine as unknown as { getCoverage: () => Promise<unknown> }).getCoverage = async () => ({ hasInventory: false, generatedAt: new Date().toISOString(), rollup: { total: 0, protected: 0, unprotected: 0, untested: 0 }, resources: [] });
    const root = scMod.securityCentreScreen.render({
      pattern: "/security", params: {}, query: new URLSearchParams(), path: "/security",
      engine, caller: c, navigate: () => {},
    }) as unknown as ShimNode;
    await flushAsync();
    return root;
  }

  {
    const root = await renderSecurityCentre("operator");
    const sw = root.querySelector(".cfg-approval__switch");
    ok("the four-eyes control renders", sw !== null);
    ok("the control is labelled (four-eyes / dual control)", textOf(root).includes("four-eyes"));
    // Disabled-with-reason, not the native `disabled` attribute: aria-disabled, so the
    // switch stays reachable in the tab order and announces why.
    ok("the toggle is READ-ONLY (disabled) for a non-owner", sw !== null && sw.getAttribute("aria-disabled") === "true");
    ok("a non-owner sees the 'Owner only' note", textOf(root).includes("Owner only"));
  }
  {
    const root = await renderSecurityCentre("owner");
    const sw = root.querySelector(".cfg-approval__switch");
    ok("the toggle is ENABLED (settable) for an owner after the policy loads", sw !== null && sw.disabled === false);
    ok("an owner does NOT see the 'Owner only' note", !textOf(root).includes("Owner only"));
  }
}

async function testPendingToast(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- TOAST: surfacePendingChange says 'queued for approval', never 'saved' --");
  // ------------------------------------------------------------------------
  {
    const pendingMod = await import("../src/lib/pending-change-toast.ts");
    // Clear any prior toasts so the assertion reads only this one. Clear the toast regions'
    // CHILDREN in place rather than replacing document.body: the toast component caches its
    // live regions module-wide, so detaching them from the body would route a later toast into
    // a stale, detached region. This keeps the test order-independent.
    for (const region of docBody().querySelectorAll(".toast-region")) region.replaceChildren();
    pendingMod.surfacePendingChange("downpipe");
    await flushAsync(3);
    const body = textOf(docBody());
    ok("the pending toast says 'queued for approval'", body.toLowerCase().includes("queued for approval"));
    ok("the pending toast names what was queued (downpipe)", body.includes("downpipe"));
    ok("the pending toast does NOT say 'saved'", !body.toLowerCase().includes("saved"));
    ok("the pending toast offers a View action to the inbox", body.includes("View"));
  }
}

async function main(): Promise<void> {
  installDomShim();
  await testPureHelpers();
  await test202Handling();
  await testInboxScreen();
  await testSecurityCentreToggle();
  await testPendingToast();

  // ==========================================================================
  console.log(failures === 0 ? "\nALL CONFIG-CHANGES VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Exit deterministically: the rendered inbox schedules a 15s poll and the toast an auto-dismiss timer
  // that legitimately outlive this test; a late tick must never flip a green run.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-CONFIG-CHANGES THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
