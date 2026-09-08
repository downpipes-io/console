// The HIGH-BLAST-RADIUS owner-action dual-control console surface.
// Run with: node test/validate-owner-actions.ts
//
// Coverage (the load-bearing behaviours of the owner-action gate UI):
//   PURE helpers (lib/owner-actions.ts), no DOM:
//     - ownerActionKindLabel maps each kind to a human label (and falls back to the raw kind for unknown)
//     - isMineOwnerAction is the maker != checker mirror (own proposal by subject OR email; token path is
//       never "mine")
//     - roleCanApproveOwnerAction / callerCanApproveOwnerAction surface the rail ONLY to an owner (every
//       other built-in role, and any custom role, cannot, the engine gates approve on keys.ceremony)
//   202 handling (src/api.ts), real EngineClient over a stubbed fetch:
//     - a HIGH-BLAST owner mutation that returns HTTP 202 + { ownerActionQueued:true, id } resolves to
//       { status:"queued", queued } (NOT a throw, NOT a false-success applied value) for EVERY converted
//       method (setDestination/addDestination/removeDestination/setDefaultDestination/setDiscoveryToken/
//       setPush/createIdpConnection/deleteIdpConnection/setIdpConnectionEnabled)
//     - a 200 resolves to { status:"result", value } (the gate-off path is unchanged)
//     - the inbox methods: listOwnerActions returns the array; approve/reject hit the right routes
//   REAL screen render (a minimal DOM shim drives the production code):
//     - a 404/501 listOwnerActions renders the calm "not enabled on this engine" empty state (no Retry),
//       a 5xx renders the retryable block error (the load closure's degrade split)
//     - the Owner approvals screen renders a pending action with its redaction-safe summary + proposer
//     - Approve is HIDDEN on a caller's OWN proposal, with the explicit "you proposed this" awaiting copy
//     - Approve is PRESENT on an action proposed by someone else
//     - surfaceQueuedOwnerAction emits a "queued for a second owner" toast, NEVER a "saved/removed" one
//
// Like validate-config-changes.ts this RENDERS the real code under a self-contained DOM shim (it never
// re-implements the code under test); it exits deterministically because the rendered screen schedules
// production timers (the inbox poll, a toast auto-dismiss) that legitimately outlive the test.

import {
  EngineClient,
  isOwnerActionQueued,
  isOwnerActionQueuedResult,
  isOwnerActionAppliedResult,
  type OwnerActionResult,
  type OwnerAction,
  type Caller,
} from "../src/api.ts";
import {
  ownerActionKindLabel,
  isKnownOwnerActionKind,
  isMineOwnerAction,
  roleCanApproveOwnerAction,
  callerCanApproveOwnerAction,
} from "../src/lib/owner-actions.ts";
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
// A minimal DOM shim (same approach as validate-config-changes.ts): just enough surface for the rendered
// owner-actions screen + the toast region to run under plain node. It never re-implements the code under
// test; it only lets the production render execute.
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

async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}
function textOf(node: ShimNode | null): string { return node ? node.textContent : ""; }
function docBody(): ShimNode { return (globalThis as unknown as { document: { body: ShimNode } }).document.body; }

// makeAction builds a real-shaped OwnerAction (the redaction-safe inbox view).
function makeAction(over: Partial<OwnerAction> = {}): OwnerAction {
  const now = Date.now();
  return {
    id: over.id ?? "oa_01",
    kind: over.kind ?? "dest-remove",
    summary: over.summary ?? "Remove: prod-archive at s3.example.com [auto]",
    proposedBy: over.proposedBy === undefined ? "maker@example.com" : over.proposedBy,
    proposedBySubject: over.proposedBySubject === undefined ? "subj-maker" : over.proposedBySubject,
    proposedAt: over.proposedAt ?? new Date(now).toISOString(),
    expiresAt: over.expiresAt ?? new Date(now + 24 * 3600 * 1000).toISOString(),
    status: over.status ?? "pending",
    ...(over.approverSubject !== undefined ? { approverSubject: over.approverSubject } : {}),
    ...(over.approvedBy !== undefined ? { approvedBy: over.approvedBy } : {}),
    ...(over.approvedAt !== undefined ? { approvedAt: over.approvedAt } : {}),
  };
}

// stubFetch installs a global fetch that answers a single canned Response, so a real EngineClient method
// exercises the real parseJsonOrOwnerAction branch. Returns a restore function.
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

// recordFetch installs a global fetch that records each call and answers a canned 200, so a method's route +
// verb can be asserted. Returns { calls, restore }.
function recordFetch(body: unknown): { calls: Array<{ url: string; method: string }>; restore: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  g.fetch = async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return { ok: true, status: 200, async text() { return JSON.stringify(body); }, async json() { return body; }, clone() { return this; } };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

// testPureHelpers covers the pure label / maker-is-not-checker / can-approve helpers (no DOM,
// no fetch). Split out of main() so each section is its own named function; the bodies are unchanged.
function testPureHelpers(): void {
  // ------------------------------------------------------------------------
  console.log("\n-- PURE: ownerActionKindLabel --");
    eq(ownerActionKindLabel("dest-remove"), "Remove an archive destination", "dest-remove label");
    eq(ownerActionKindLabel("idp-conn-create"), "Add an identity-provider connection", "idp-conn-create label");
    // idp-conn-cert (the zero-downtime SAML signing-cert rollover, engine src/admin/owner-action.ts) was
    // missing from both OwnerActionKind and OWNER_ACTION_KIND, so a live rollover proposal rendered its
    // approval-queue card heading as the raw string "idp-conn-cert" rather than a plain-English description
    // of what the approver was authorising.
    eq(ownerActionKindLabel("idp-conn-cert"), "Roll over an identity-provider SAML signing certificate", "idp-conn-cert label");
    ok("idp-conn-cert is a KNOWN kind, not a raw-string fallback (the negative control below is what it looked like before)", isKnownOwnerActionKind("idp-conn-cert") === true);
    ok("a genuinely unknown kind is still reported unknown (isKnownOwnerActionKind can fail, proving the check above is not vacuous)", isKnownOwnerActionKind("brand-new-kind") === false);
    eq(ownerActionKindLabel("discovery-token-set"), "Set the account-browsing token", "discovery-token-set label");
    eq(ownerActionKindLabel("push-dest-set"), "Set the SIEM push destination", "push-dest-set label");
    eq(ownerActionKindLabel("otlp-push-dest-set"), "Set the OTLP metrics push destination", "otlp-push-dest-set label");
    eq(ownerActionKindLabel("dual-control-disable"), "Turn off dual control", "dual-control-disable label");
    eq(ownerActionKindLabel("brand-new-kind"), "brand-new-kind", "an unknown kind falls back to the raw kind");

  // ------------------------------------------------------------------------
  console.log("\n-- PURE: isMineOwnerAction (maker != checker mirror) --");
  // ------------------------------------------------------------------------
  {
    const a = makeAction({ proposedBy: "ada@example.com", proposedBySubject: "subj-ada" });
    ok("isMine true when the caller subject is the proposer subject", isMineOwnerAction(a, "subj-ada", "someone-else@example.com") === true);
    ok("isMine true when the caller email is the proposer (subject absent)", isMineOwnerAction(a, null, "ada@example.com") === true);
    ok("isMine false when the caller is someone else", isMineOwnerAction(a, "subj-grace", "grace@example.com") === false);
    ok("isMine false for a null caller subject AND email (token path / whoami pending)", isMineOwnerAction(a, null, null) === false);
    const tokenProposed = makeAction({ proposedBy: "x@example.com", proposedBySubject: null });
    ok("isMine false when only the (null) subjects coincide (never matches on null)", isMineOwnerAction(tokenProposed, null, "y@example.com") === false);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- PURE: which roles can approve (rail surfacing) -> OWNER ONLY --");
  // ------------------------------------------------------------------------
  {
    ok("an owner CAN approve an owner action", roleCanApproveOwnerAction("owner") === true);
    ok("an operator canNOT approve an owner action", roleCanApproveOwnerAction("operator") === false);
    ok("an approver canNOT (approver is a config approver, not an owner)", roleCanApproveOwnerAction("approver") === false);
    ok("an access-admin canNOT (keys.ceremony is owner-reserved)", roleCanApproveOwnerAction("access-admin") === false);
    ok("a viewer canNOT", roleCanApproveOwnerAction("viewer") === false);
    ok("a restore-operator canNOT", roleCanApproveOwnerAction("restore-operator") === false);

    const ownerCaller: Caller = { method: "access", email: "o@x", role: "owner", groups: [], isOnlyOwner: false };
    ok("callerCanApproveOwnerAction true for an owner caller", callerCanApproveOwnerAction(ownerCaller) === true);
    const operatorCaller: Caller = { method: "access", email: "p@x", role: "operator", groups: [], isOnlyOwner: false };
    ok("callerCanApproveOwnerAction false for an operator caller", callerCanApproveOwnerAction(operatorCaller) === false);
    ok("callerCanApproveOwnerAction false for a null caller", callerCanApproveOwnerAction(null) === false);
    // A custom role can NEVER hold keys.ceremony (owner-reserved), so even a powerful custom role cannot.
    const customPowerful: Caller = {
      method: "access", email: "c@x", role: "viewer", groups: [], isOnlyOwner: false,
      customCapabilities: ["downpipe.read", "downpipe.write", "roles.write", "access.policy"],
    };
    ok("callerCanApproveOwnerAction false for ANY custom role (keys.ceremony is owner-reserved)", callerCanApproveOwnerAction(customPowerful) === false);
  }
}

// test202Handling covers the deferred-mutation contract: a deferred (202) owner mutation resolves to a
// queued result, never a false applied success; a 200 stays the applied path; a non-2xx still throws.
async function test202Handling(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- 202 HANDLING: a deferred owner mutation resolves to queued, not a false success --");
  // ------------------------------------------------------------------------
  {
    ok("isOwnerActionQueued true for { ownerActionQueued:true, id }", isOwnerActionQueued({ ownerActionQueued: true, id: "oa_9", status: "pending" }) === true);
    ok("isOwnerActionQueued false for a normal applied record", isOwnerActionQueued({ present: true, id: "d_1" }) === false);
    ok("isOwnerActionQueued false for null", isOwnerActionQueued(null) === false);
    ok("isOwnerActionQueued false when the flag is not true", isOwnerActionQueued({ ownerActionQueued: false, id: "x" }) === false);
    ok("isOwnerActionQueued false when id is empty", isOwnerActionQueued({ ownerActionQueued: true, id: "" }) === false);

    const engine = new EngineClient("https://engine.test");
    const queuedBody = { ownerActionQueued: true, id: "oa_202", status: "pending" };

    // Every converted method, given a 202 + the owner-action body, resolves to { status:"queued" } and does
    // NOT throw and does NOT return an applied value (no false "saved/removed/...").
    const cases: Array<{ name: string; run: () => Promise<OwnerActionResult<unknown>> }> = [
      { name: "setDestination", run: () => engine.setDestination(null) },
      { name: "addDestination", run: () => engine.addDestination({ endpoint: "https://s3.example.com", bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" }, "label") },
      { name: "removeDestination", run: () => engine.removeDestination("d_1") },
      { name: "setDefaultDestination", run: () => engine.setDefaultDestination("d_1") },
      { name: "setDiscoveryToken", run: () => engine.setDiscoveryToken("tok") },
      { name: "setPush", run: () => engine.setPush({ endpoint: "https://siem.example.com/hec", format: "raw-json", authHeaderName: "Authorization", authHeaderValue: "s", enabled: true }) },
      { name: "createIdpConnection", run: () => engine.createIdpConnection({ presetId: "okta", vars: {}, id: "okta", clientId: "cid", secret: "s", secretMode: "do-plaintext" }) },
      { name: "deleteIdpConnection", run: () => engine.deleteIdpConnection("c1") },
      { name: "setIdpConnectionEnabled", run: () => engine.setIdpConnectionEnabled("c1", false) },
    ];
    for (const c of cases) {
      const restore = stubFetch(202, queuedBody);
      let result: OwnerActionResult<unknown> | null = null;
      let threw = false;
      try { result = await c.run(); } catch { threw = true; }
      restore();
      ok(`${c.name}: a 202 does NOT throw`, threw === false);
      ok(`${c.name}: a 202 resolves to status 'queued'`, result !== null && result.status === "queued");
      ok(`${c.name}: the queued result carries the owner-action id`, result !== null && result.status === "queued" && result.queued.id === "oa_202");
      ok(`${c.name}: isOwnerActionQueuedResult narrows the 202 result`, result !== null && isOwnerActionQueuedResult(result));
    }

    // A governance-lie regression (the same class parseJsonOrPending's own fix carries): a 202 whose body does NOT
    // carry the OwnerActionQueued shape must throw an honest error, never resolve to a fabricated "result"
    // value. `{}` is the same shape the live probe used against parseJsonOrPending; before the fix this
    // fell through to the ordinary 2xx path and resolved as { status:"result", value:{} } -- a false "saved"
    // for a destination repoint, an IdP connection, or the account-browsing token, none of which had moved.
    {
      const restore = stubFetch(202, {});
      let result: OwnerActionResult<unknown> | null = null;
      let threw = false;
      let caught: unknown;
      try { result = await engine.setDestination(null); }
      catch (e) { threw = true; caught = e; }
      restore();
      ok("a malformed 202 (valid JSON, wrong shape) THROWS rather than resolving", threw === true);
      ok("a malformed 202 never resolves to a value", result === null);
      const outcome = classifyError(caught);
      ok("the throw classifies as answer-unreadable (the engine answered; only the body is unreadable)", outcome.kind === "answer-unreadable");
      ok("the classified status is 202, not misread as a bare reachability fault", outcome.kind === "answer-unreadable" && outcome.status === 202);
    }

    // The other half of "malformed OR unparseable": a 202 body that is not even valid JSON
    // (truncated) must ALSO throw honestly, never resolve. Every owner-action mutation (destinations, IdP
    // connections, the discovery token, push/OTLP destinations) shares this one decoder.
    {
      const g = globalThis as unknown as Record<string, unknown>;
      const prevFetch = g.fetch;
      g.fetch = async () => ({
        ok: true,
        status: 202,
        async text() { return '{"ownerActionQueued":true,'; }, // truncated: JSON.parse throws
        async json() { throw new Error("not reached"); },
        clone() { return this; },
      });
      let threw = false;
      let caught: unknown;
      try { await engine.setDestination(null); }
      catch (e) { threw = true; caught = e; }
      g.fetch = prevFetch;
      ok("an unparseable 202 body (truncated JSON) also THROWS rather than resolving", threw === true);
      ok("the unparseable-202 throw also classifies as answer-unreadable", classifyError(caught).kind === "answer-unreadable");
    }

    // A 200 applied record: the gate-off path is unchanged (resolves to { status:"result", value }).
    {
      const restore = stubFetch(200, { present: true, id: "d_1", label: "Prod" });
      const result = await engine.setDestination(null);
      restore();
      ok("a 200 resolves to status 'result' (gate-off path unchanged)", result.status === "result");
      ok("isOwnerActionAppliedResult narrows the 200 result", isOwnerActionAppliedResult(result));
      ok("the applied result carries the engine value", result.status === "result" && (result.value as { present: boolean }).present === true);
    }

    // A non-2xx error still throws (it is NOT a queued result), with the engine's reason folded in.
    {
      const restore = stubFetch(400, { error: "endpoint unreachable" });
      let threw = false;
      let msg = "";
      try { await engine.setDestination({ endpoint: "https://x", bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" }); }
      catch (e) { threw = true; msg = e instanceof Error ? e.message : String(e); }
      restore();
      ok("a non-2xx still throws (not a queued result)", threw === true);
      ok("the thrown message folds the engine reason verbatim", msg.includes("endpoint unreachable"));
    }
  }
}

// testClientMethods covers the client surface: list / approve / reject hit the right routes
// and methods.
async function testClientMethods(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- client methods: listOwnerActions / approveOwnerAction / rejectOwnerAction --");
  // ------------------------------------------------------------------------
  {
    const engine = new EngineClient("https://engine.test");
    {
      const restore = stubFetch(200, [makeAction()]);
      const list = await engine.listOwnerActions();
      restore();
      ok("listOwnerActions returns the pending list", Array.isArray(list) && list.length === 1);
    }
    {
      const rec = recordFetch(makeAction({ status: "approved" }));
      await engine.approveOwnerAction("oa_42");
      rec.restore();
      eq(rec.calls[0]?.url, "https://engine.test/admin/owner-actions/oa_42/approve", "approveOwnerAction hits POST .../approve");
      eq(rec.calls[0]?.method, "POST", "approveOwnerAction is a POST");
    }
    {
      const rec = recordFetch(makeAction({ status: "rejected" }));
      await engine.rejectOwnerAction("oa_43");
      rec.restore();
      eq(rec.calls[0]?.url, "https://engine.test/admin/owner-actions/oa_43/reject", "rejectOwnerAction hits POST .../reject");
      eq(rec.calls[0]?.method, "POST", "rejectOwnerAction is a POST");
    }
    {
      // listOwnerActions hits the right GET route.
      const rec = recordFetch([]);
      await engine.listOwnerActions();
      rec.restore();
      eq(rec.calls[0]?.url, "https://engine.test/admin/owner-actions", "listOwnerActions hits GET /admin/owner-actions");
      eq(rec.calls[0]?.method, "GET", "listOwnerActions is a GET");
    }
  }
}

// testScreenAndToast renders the real Owner approvals inbox (maker != checker gating, empty
// state) and asserts the queued-owner-action toast copy. This is the DOM-touching section.
async function testScreenAndToast(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- SCREEN: the Owner approvals inbox renders a pending action + maker != checker --");
  // ------------------------------------------------------------------------
  const screenMod = await import("../src/screens/owner-actions.ts");
  const store = await import("../src/lib/store.ts");
  const nav = await import("../src/lib/nav.ts");
  nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

  async function renderInbox(callerEmail: string | null, callerSubject: string | null, actions: OwnerAction[]): Promise<ShimNode> {
    const c: Caller = { method: "access", email: callerEmail, subject: callerSubject, role: "owner", groups: [], isOnlyOwner: false };
    store.setCaller(c);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    (engine as unknown as { listOwnerActions: () => Promise<OwnerAction[]> }).listOwnerActions = async () => actions;
    const root = screenMod.ownerActionsScreen.render({
      pattern: "/security/owner-actions", params: {}, query: new URLSearchParams(), path: "/security/owner-actions",
      engine, caller: c, navigate: () => {},
    }) as unknown as ShimNode;
    await flushAsync();
    return root;
  }

  {
    // An action proposed by SOMEONE ELSE: the summary + proposer show, and Approve is offered.
    const other = makeAction({ id: "oa_other", proposedBy: "maker@example.com", proposedBySubject: "subj-maker", summary: "Remove: prod-archive at s3.example.com [auto]" });
    const root = await renderInbox("checker@example.com", "subj-checker", [other]);
    const txt = textOf(root);
    ok("renders the action's redaction-safe summary", txt.includes("prod-archive at s3.example.com"));
    ok("renders who proposed it", txt.includes("maker@example.com"));
    ok("renders the kind label", txt.includes("Remove an archive destination"));
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("offers an Approve button on someone else's action", buttons.some((t) => t.includes("Approve")));
    ok("offers a Reject button on someone else's action", buttons.some((t) => t.includes("Reject")));
    ok("does NOT show the 'you proposed this' note for a distinct approver", !txt.includes("You proposed this"));
  }

  {
    // An action the CALLER proposed: Approve is HIDDEN, the explicit awaiting copy shows, Withdraw is offered.
    const mine = makeAction({ id: "oa_mine", proposedBy: "checker@example.com", proposedBySubject: "subj-checker" });
    const root = await renderInbox("checker@example.com", "subj-checker", [mine]);
    const txt = textOf(root);
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("HIDES Approve on the caller's own proposal (maker != checker)", !buttons.some((t) => t.includes("Approve")));
    ok("shows the explicit 'you proposed this' awaiting copy", txt.includes("You proposed this; awaiting a different owner"));
    ok("the maker-is-not-checker rule stays explicit on an own proposal", txt.includes("maker is not checker"));
    ok("offers Withdraw on the caller's own proposal", buttons.some((t) => t.includes("Withdraw")));
  }

  {
    // Empty inbox: the honest "nothing waiting" state.
    const root = await renderInbox("o@example.com", "subj-o", []);
    ok("an empty inbox shows the 'nothing waiting' state", textOf(root).includes("No owner approvals waiting"));
  }

  // The load closure splits a not-yet-wired engine (404/501) from a transport fault (5xx): the first
  // shows a calm "not enabled on this engine" empty state with no Retry, the second a retryable block error.
  async function renderInboxRejecting(err: Error): Promise<ShimNode> {
    const c: Caller = { method: "access", email: "o@example.com", subject: "subj-o", role: "owner", groups: [], isOnlyOwner: false };
    store.setCaller(c);
    store.connect("https://engine.test");
    const engine = store.getEngine()!;
    (engine as unknown as { listOwnerActions: () => Promise<OwnerAction[]> }).listOwnerActions = async () => {
      throw err;
    };
    const root = screenMod.ownerActionsScreen.render({
      pattern: "/security/owner-actions", params: {}, query: new URLSearchParams(), path: "/security/owner-actions",
      engine, caller: c, navigate: () => {},
    }) as unknown as ShimNode;
    await flushAsync();
    return root;
  }

  {
    // A 404 listOwnerActions: owner-action routes are absent on this engine build.
    const root = await renderInboxRejecting(new Error("listOwnerActions: 404"));
    const txt = textOf(root);
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("a 404 shows the 'not enabled on this engine' empty state", txt.includes("Dual control is not enabled on this engine"));
    ok("the not-enabled state offers no Retry", !buttons.some((t) => t.includes("Retry")));
  }

  {
    // A 500 listOwnerActions: a genuine transport fault gets the retryable block error.
    const root = await renderInboxRejecting(new Error("listOwnerActions: 500"));
    const buttons = root.querySelectorAll("button").map((b) => b.textContent);
    ok("a 500 shows the retryable block error (a Retry control)", buttons.some((t) => t.includes("Retry")));
  }

  // ------------------------------------------------------------------------
  console.log("\n-- TOAST: surfaceQueuedOwnerAction says 'queued for a second owner', never 'removed' --");
  // ------------------------------------------------------------------------
  {
    const toastMod = await import("../src/lib/pending-change-toast.ts");
    docBody().replaceChildren();
    toastMod.surfaceQueuedOwnerAction("Removing this destination");
    await flushAsync(3);
    const body = textOf(docBody());
    ok("the queued toast says 'queued for a second owner'", body.toLowerCase().includes("queued for a second owner"));
    ok("the queued toast names what was queued (Removing this destination)", body.includes("Removing this destination"));
    ok("the queued toast does NOT say 'removed'", !body.toLowerCase().includes("removed"));
    ok("the queued toast does NOT say 'saved'", !body.toLowerCase().includes("saved"));
    ok("the queued toast offers a View action to the inbox", body.includes("View"));
  }
}

// main is a thin orchestrator: install the DOM shim, then run each section in the original
// source order so `node test/validate-owner-actions.ts` runs the full suite unchanged.
async function main(): Promise<void> {
  installDomShim();

  testPureHelpers();
  await test202Handling();
  await testClientMethods();
  await testScreenAndToast();

  // ==========================================================================
  console.log(failures === 0 ? "\nALL OWNER-ACTIONS VECTORS PASS" : `\n${failures} FAILURE(S)`);
  // Exit deterministically: the rendered inbox schedules a 15s poll and the toast an auto-dismiss timer that
  // legitimately outlive this test; a late tick must never flip a green run.
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nVALIDATE-OWNER-ACTIONS THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
