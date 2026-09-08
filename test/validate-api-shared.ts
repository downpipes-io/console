// Shared harness + DOM shim + builders for the validate-api suite.
//
// validate-api.ts was split into cohesive groups (the pure helpers, the DOM-driven
// restore/onboarding flows, the capability model, and the fetch-stubbed client). This
// module holds exactly what more than one group needs: the assertion harness (so the
// failure count is shared across every group), the minimal DOM shim that lets the REAL
// screens render under plain node, and the small request/attestation builders.
//
// It exists ONLY to RUN the production code; it never re-implements anything under test
// (the payload-building logic lives entirely in src/screens/restore-flow.ts and api.ts).

import type {
  RunHistoryEntry,
  RestorePlan,
} from "../src/api.ts";

// ==========================================================================
// Assertion harness. The orchestrator constructs one Harness and threads it
// into every group so a single failure count spans the whole suite, exactly as
// the original single-file run did.
// ==========================================================================
export class Harness {
  failures = 0;

  // `detail` is evaluated ONLY on failure, and exists because a bare `FAIL <label>` is not evidence.
  // On the restore approval gate this said only that an expected button was absent, never what the
  // panel held instead. A thunk rather than a
  // string so the passing path, which is nearly every call, pays nothing to build a message it discards.
  ok(label: string, cond: boolean, detail?: () => string): void {
    if (cond) {
      console.log(`  ok   ${label}`);
      return;
    }
    let extra = "";
    if (detail) {
      // A diagnostic that throws must not become the failure, because then the real one is never printed.
      try {
        extra = `  ${detail()}`;
      } catch (err) {
        extra = `  (detail threw: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    console.log(`  FAIL ${label}${extra}`);
    this.failures++;
  }

  eq(a: unknown, b: unknown, label: string): void {
    const cond = a === b;
    console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
    if (!cond) this.failures++;
  }
}

// ---- listHistory .entries unwrap: replicate body.entries ?? [] without a network call ----
export function unwrapEntries(body: { entries?: RunHistoryEntry[] }): RunHistoryEntry[] {
  return body.entries ?? [];
}

// ==========================================================================
// A minimal DOM shim so the REAL restore-flow / onboarding screens can be rendered
// and driven under plain node (no browser, no DOM library). This exists only to RUN
// the production code; it never re-implements the code under test. The shim covers
// exactly the surface the rendered screens touch: element/text/fragment creation, the
// tree ops (append/remove/replaceChildren), attributes and the few mapped properties
// (className/id/hidden/value/disabled/placeholder/textContent/innerHTML), event
// listeners + click dispatch, classList/dataset/style, and the querySelector(All) the
// tests use to locate fields and buttons.
// ==========================================================================

let nodeSeq = 0;

export class ShimClassList {
  node: ShimNode;
  set: Set<string> = new Set();
  constructor(node: ShimNode) { this.node = node; }
  add(...cs: string[]): void { for (const c of cs) this.set.add(c); this.sync(); }
  remove(...cs: string[]): void { for (const c of cs) this.set.delete(c); this.sync(); }
  contains(c: string): boolean { return this.set.has(c); }
  sync(): void { this.node.attrs.class = [...this.set].join(" "); }
}

export class ShimStyle {
  [prop: string]: string | ((p: string, v: string) => void);
  setProperty(prop: string, value: string): void { this[prop] = value; }
}

export class ShimNode {
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
  placeholder_ = "";
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
    if (child.kind === "fragment") {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: ShimNode): ShimNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes: ShimNode[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(n);
  }
  get firstChild(): ShimNode | null { return this.childNodes[0] ?? null; }
  get childElementCount(): number { return this.childNodes.filter((c) => c.nodeType === 1).length; }
  get isConnected(): boolean {
    let n: ShimNode | null = this;
    while (n) { if (n.connectedRoot_) return true; n = n.parentNode; }
    return false;
  }

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
  set disabled(v: boolean) { this.disabled_ = !!v; }
  get disabled(): boolean { return this.disabled_; }
  set placeholder(v: string) { this.placeholder_ = String(v); }
  get placeholder(): string { return this.placeholder_; }
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
  removeEventListener(type: string, fn: (ev: ShimEvent) => void): void {
    const l = this.listeners[type]; if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev: ShimEvent): boolean {
    ev.target = ev.target ?? this;
    ev.currentTarget = this;
    for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  click(): void {
    const ev: ShimEvent = { type: "click", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.dispatchEvent(ev);
  }
  focus(): void { /* no-op */ }

  walk(cb: (n: ShimNode) => void): void { for (const c of this.childNodes) { cb(c); c.walk(cb); } }
  matchesOne(sel: string): boolean {
    if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    return this.nodeType === 1 && this.tagName === sel.toUpperCase();
  }
  matchesAny(selList: string): boolean {
    for (const sel of selList.split(",").map((s) => s.trim()).filter(Boolean)) if (this.matchesOne(sel)) return true;
    return false;
  }
  querySelector(sel: string): ShimNode | null {
    let found: ShimNode | null = null;
    this.walk((n) => { if (!found && n.nodeType === 1 && n.matchesAny(sel)) found = n; });
    return found;
  }
  querySelectorAll(sel: string): ShimNode[] {
    const out: ShimNode[] = [];
    this.walk((n) => { if (n.nodeType === 1 && n.matchesAny(sel)) out.push(n); });
    return out;
  }
}

export interface ShimEvent {
  type: string;
  target: ShimNode | null;
  currentTarget: ShimNode | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export class ShimElement extends ShimNode {
  constructor(tag: string) { super("element"); this.tagName = String(tag).toUpperCase(); this.localName = String(tag).toLowerCase(); }
}

// installDomShim puts the document/window/localStorage globals in place. It is
// idempotent (a second call is a no-op once document is the shim). navigator is left
// untouched (it is a read-only global in node and the rendered request-flow only
// reaches navigator.clipboard inside the copy-button click handler, which these tests
// never fire).
export function installDomShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if ((g.document as { __shim?: boolean } | undefined)?.__shim) return;
  g.document = {
    __shim: true,
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (t: string) => { const n = new ShimNode("text"); n.text_ = t == null ? "" : String(t); return n; },
    createDocumentFragment: () => new ShimNode("fragment"),
    readyState: "complete",
  };
  g.Node = ShimNode;
  g.window = globalThis;
  if (!("location" in g)) g.location = { origin: "https://console.test" };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

// flushAsync drains the microtask queue and a handful of macrotask ticks so the
// auto-run dry-run (queueMicrotask), the awaited renderPlan/renderConfirm chain, and
// the async request-click handler all settle before a test reads the result.
//
// The deepest real chain a test drives is: button click -> async handler ->
// buildRequest (sync) -> dryRunRestore (one awaited engine double, resolves on a
// microtask) -> queueMicrotask(renderPlan) -> renderPlan (sync DOM build) ->
// renderRequestPanel (sync). That is under five await/queueMicrotask hops plus one
// setTimeout(0) toast. Forty rounds (each a microtask drain AND a macrotask tick) is
// roughly eight times that depth, a deliberate margin so a slow CI runner that batches
// timer callbacks still settles. A call-site that depends on the panel being reached
// must assert it explicitly (panel-not-reached returns null), so a future chain that
// outgrows this budget fails with a named assertion rather than passing silently.
export async function flushAsync(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// waitFor drains until `done()` is true, rather than for a fixed number of rounds, and is what a
// call site should use whenever it is waiting for a specific rendered outcome.
//
// A fixed-round drain reasons about a margin in ROUNDS, and a loaded shared runner can interleave a
// promise chain across more turns than a quiet machine does, so the assertion can read a DOM that has
// not finished building. Raising the constant only moves the goalpost; waiting for the outcome
// removes the race.
//
// Still bounded, so a genuinely broken render fails with the call site's own named assertion rather
// than hanging: on timeout it simply returns and the caller's assert reports the real problem.
export async function waitFor(done: () => boolean, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (done()) return;
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// markConnected flags a rendered root as document-connected so the screen's
// isConnected-guarded polls (the approvals re-check loop) behave as they would in a
// live DOM. The tests do not depend on the poll, but this keeps the shim honest.
export function markConnected(root: unknown): void { (root as ShimNode).connectedRoot_ = true; }

// querySelectorShim / querySelectorAllShim / textOf bridge the shimmed nodes the real
// render returns (the production code creates them via document.createElement, so the
// returned root is a ShimNode tree) to the lookups the tests perform.
export function querySelectorShim(root: unknown, sel: string): ShimNode | null { return (root as ShimNode).querySelector(sel); }
export function querySelectorAllShim(root: unknown, sel: string): ShimNode[] { return (root as ShimNode).querySelectorAll(sel); }
export function textOf(node: unknown): string { return (node as ShimNode).textContent; }

// makePlan builds a minimal but real-shaped dry-run RestorePlan (the engine's
// authoritative shape, copied byte-for-byte into api.ts) for the request-panel driver.
// Only the fields the flow reads are varied; the rest are benign constants. ok is true
// and plannedWrites is supplied by the caller (the panel is only reachable when ok and
// plannedWrites > 0).
export function makePlan(opts: { isLatest: boolean; plannedWrites: number; bytes: number; dependencyWarnings?: Array<{ database: string; table: string; missingParent: string }>; mediaPlanned?: Array<{ name: string; type: "images" | "stream" }> }): RestorePlan {
  return {
    ok: true,
    runId: "RUN-PLAN",
    mode: "dry-run",
    recordsVerified: opts.plannedWrites,
    isLatest: opts.isLatest,
    plannedWrites: opts.plannedWrites,
    bytes: opts.bytes,
    sample: [],
    skipped: [],
    ...(opts.dependencyWarnings ? { dependencyWarnings: opts.dependencyWarnings } : {}),
    ...(opts.mediaPlanned ? { mediaPlanned: opts.mediaPlanned } : {}),
  };
}

// populateForm drives the REAL pick form (the include/exclude/max fields and the target
// choice) so the dry-run's buildRequest() reads the test's request-fields. It sets the
// optional advanced fields and, when a target binding is given, selects the redirect
// option and sets its binding input (matching how an operator would, so target.binding()
// returns the binding and req.target = { binding } flows through to the request payload).
export function populateForm(
  root: unknown,
  reqFields: { runId: string; target?: { binding?: string }; include?: string[]; exclude?: string[]; maxRecords?: number; recordName?: string; cfConfig?: { token?: string; accountId: string; zoneId?: string }; mediaRestore?: { token?: string; accountId: string }; d1Tables?: { database: string; tables: string[]; createOnly?: boolean } },
): void {
  const r = root as ShimNode;
  const setVal = (sel: string, v: string) => { const el = r.querySelector(sel); if (el) (el as ShimNode).value = v; };
  if (reqFields.include?.length) setVal("#rs-include", reqFields.include.join(", "));
  if (reqFields.exclude?.length) setVal("#rs-exclude", reqFields.exclude.join(", "));
  if (reqFields.maxRecords !== undefined) setVal("#rs-max", String(reqFields.maxRecords));
  // recordName seeds a GRANULAR single-record restore; cfConfig seeds a Cloudflare-config apply;
  // mediaRestore seeds a media (Stream/Images) re-upload. All three bind into the plan hash and MUST
  // travel on the request, so the tests set the real form fields and assert the
  // captured payload carries them.
  if (reqFields.recordName !== undefined) setVal("#rs-record", reqFields.recordName);
  if (reqFields.cfConfig) {
    if (reqFields.cfConfig.token !== undefined) setVal("#rs-cf-token", reqFields.cfConfig.token);
    setVal("#rs-cf-account", reqFields.cfConfig.accountId);
    if (reqFields.cfConfig.zoneId !== undefined) setVal("#rs-cf-zone", reqFields.cfConfig.zoneId);
  }
  if (reqFields.mediaRestore) {
    if (reqFields.mediaRestore.token !== undefined) setVal("#rs-media-token", reqFields.mediaRestore.token);
    setVal("#rs-media-account", reqFields.mediaRestore.accountId);
  }
  // d1Tables seeds a D1 table-subset restore. Like recordName/cfConfig it binds into the plan hash and
  // MUST travel on the request, so the test fills the real D1 fields (a database, a tables list, and the
  // create-only checkbox) and asserts the captured payload carries them.
  if (reqFields.d1Tables) {
    setVal("#rs-d1-db", reqFields.d1Tables.database);
    setVal("#rs-d1-tables", reqFields.d1Tables.tables.join(", "));
    if (reqFields.d1Tables.createOnly === true) {
      const cb = r.querySelector("#rs-d1-createonly");
      if (cb) (cb as ShimNode).checked = true;
    }
  }

  const binding = reqFields.target?.binding;
  if (binding !== undefined && binding !== "") {
    // Select the redirect radio (input with value="redirect"), then set its binding input.
    // Locate the binding input by its stable aria-label, not its placeholder: the placeholder
    // is a display example that changes as the field copy is tuned (it moved from a label echo
    // to a real binding example), whereas the aria-label is the input's semantic identity.
    const inputs = r.querySelectorAll("input");
    const redirectRadio = inputs.find((i) => i.getAttribute("value") === "redirect");
    const bindingInput = inputs.find((i) => i.getAttribute("aria-label") === "Redirect target binding name");
    if (redirectRadio) {
      redirectRadio.checked = true;
      redirectRadio.dispatchEvent({ type: "change", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    }
    // Set the binding AFTER the change (sync() only clears it when redirect is unchecked).
    if (bindingInput) bindingInput.value = binding;
  }
}

// A blind-test attestation builder (the engine's BlindRestoreTest shape, mirrored in api.ts).
export type BlindTest = import("../src/api.ts").BlindRestoreTest;
export function makeBlindTest(opts: { ok: boolean; recordsVerified: number; bytesVerified: number; restoreDigest: string | null; failures?: Array<{ name: string; reason: string }>; reason?: string }): BlindTest {
  return {
    ok: opts.ok,
    runId: "RUN-RV",
    downpipeId: "dp-rv",
    recordsVerified: opts.recordsVerified,
    bytesVerified: opts.bytesVerified,
    failures: opts.failures ?? [],
    restoreDigest: opts.restoreDigest,
    isLatest: true,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  };
}
