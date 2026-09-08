// Validate the RECOVERY-CODE break-glass UI: the one-time codes panel
// (src/components/recovery-codes-panel.ts), the "use a recovery code" sign-in flow + the show-codes-once
// hook on enrolment (src/screens/passkey.ts), and the Security Centre recovery-codes section + the
// Owner-only retire-break-glass-token control (src/screens/security-centre.ts). The DOM + the engine api
// are STUBBED (no jsdom, no network); the REAL screen / component logic is driven, never re-implemented.
// Run with `node test/validate-recovery-ui.ts`.
//
// Coverage:
//   recoveryCodesText (pure): the .txt body lists every code verbatim and carries the save-or-lose framing
//   recoveryCodesPanel (rendered): shows the codes; the Continue is DISABLED until the "I have saved my
//     recovery codes" checkbox is ticked (the save-confirm gate); ticking it enables Continue; Continue
//     fires onConfirm; Download calls downloadText with the .txt body
//   runRecovery (real flow): POSTs { email, code } via recoverWithCode; on enrolPasskey:true routes to a
//     fresh passkey enrolment (enrolNext) and does NOT run the normal boot; on enrolPasskey:false runs the
//     boot; a thrown 401 surfaces ONE generic line (no oracle) and does NOT run the boot
//   runRegister + showRecoveryCodes (real flow): when register/finish returns recoveryCodes, the screen's
//     showRecoveryCodes hook is invoked with those codes and the boot is DEFERRED until the panel proceeds;
//     when no codes are returned, the boot runs straight away (unchanged)
//   renderRecoveryAccess (rendered): shows the caller's remaining count; offers Regenerate; the retire
//     control is ENABLED for an Owner and read-only ("Owner only") for a non-owner
//   retireRefuseText (pure): pulls the engine's refuse reason out of the client's folded error message
//   recoveryCountTone (pure): 0=danger, low=warn, healthy=ok (never a stale green)

// ---- install a minimal DOM shim BEFORE importing the screens (they import lib/dom.ts at load) -----

interface ShimEvent { type: string; target: ShimNode | null; currentTarget: ShimNode | null; defaultPrevented: boolean; preventDefault(): void; }

class ShimStyle {
  [prop: string]: string | ((p: string, v: string, priority?: string) => void);
  setProperty(prop: string, value: string): void { this[prop] = value; }
}

class ShimNode {
  kind: "element" | "text" | "fragment";
  nodeType: number;
  tagName = "";
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: ShimEvent) => void>> = {};
  text_ = "";
  dataset: Record<string, string> = {};
  style: ShimStyle = new ShimStyle();
  classSet: Set<string> = new Set();
  value_ = "";
  disabled_ = false;
  checked_ = false;
  hidden_ = false;
  focused = false;

  constructor(kind: "element" | "text" | "fragment", tag = "") {
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : kind === "fragment" ? 11 : 1;
    this.tagName = tag.toUpperCase();
  }

  appendChild(child: ShimNode | null): ShimNode | null {
    if (child == null) return child;
    if (child.kind === "fragment") { for (const c of [...child.childNodes]) this.appendChild(c); return child; }
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
  get firstElementChild(): ShimNode | null { return this.childNodes.find((c) => c.nodeType === 1) ?? null; }
  get childElementCount(): number { return this.childNodes.filter((c) => c.nodeType === 1).length; }

  setAttribute(k: string, v: string): void {
    if (k === "class") { this.attrs.class = String(v); this.classSet = new Set(String(v).split(/\s+/).filter(Boolean)); return; }
    // Reflect the boolean attributes the real DOM reflects to a property, so h()'s `{ disabled: true }`
    // (which goes through setAttribute("disabled", "")) is observable on the .disabled property the panel
    // and the tests read. Without this the attribute and the property would diverge (unlike real DOM).
    if (k === "disabled") this.disabled_ = true;
    if (k === "hidden") this.hidden_ = true;
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void {
    if (k === "disabled") this.disabled_ = false;
    if (k === "hidden") this.hidden_ = false;
    delete this.attrs[k];
  }
  hasAttribute(k: string): boolean { return k in this.attrs; }

  get classList() {
    return {
      add: (...cs: string[]) => { for (const c of cs) this.classSet.add(c); this.attrs.class = [...this.classSet].join(" "); },
      remove: (...cs: string[]) => { for (const c of cs) this.classSet.delete(c); this.attrs.class = [...this.classSet].join(" "); },
      toggle: (c: string, on?: boolean) => { const want = on ?? !this.classSet.has(c); if (want) this.classSet.add(c); else this.classSet.delete(c); this.attrs.class = [...this.classSet].join(" "); },
      contains: (c: string) => this.classSet.has(c),
    };
  }
  set className(v: string) { this.setAttribute("class", String(v)); }
  get className(): string { return this.attrs.class ?? ""; }
  set id(v: string) { this.attrs.id = String(v); }
  get id(): string { return this.attrs.id ?? ""; }
  set value(v: string) { this.value_ = String(v); }
  get value(): string { return this.value_; }
  set disabled(v: boolean) { this.disabled_ = !!v; if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
  get disabled(): boolean { return this.disabled_; }
  set checked(v: boolean) { this.checked_ = !!v; }
  get checked(): boolean { return this.checked_; }
  set hidden(v: boolean) { this.hidden_ = !!v; if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get hidden(): boolean { return this.hidden_; }
  set placeholder(_v: string) { /* not inspected */ }
  set innerHTML(_v: string) { /* svgIcon path markup; not inspected */ }
  get tabIndex(): number { const t = this.attrs.tabindex; return t === undefined ? (this.nodeType === 1 ? 0 : -1) : Number(t); }
  get offsetParent(): ShimNode | null { return this.parentNode; }

  set textContent(v: string) { this.text_ = v == null ? "" : String(v); this.childNodes = []; }
  get textContent(): string {
    if (this.kind === "text") return this.text_;
    let out = this.text_ || "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  addEventListener(type: string, fn: (ev: ShimEvent) => void): void { this.listeners[type] ||= []; this.listeners[type].push(fn); }
  removeEventListener(type: string, fn: (ev: ShimEvent) => void): void { const l = this.listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  dispatchEvent(ev: ShimEvent): boolean {
    ev.target = ev.target ?? this; ev.currentTarget = this;
    for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  click(): void { this.dispatchEvent({ type: "click", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); }
  changeFire(): void { this.dispatchEvent({ type: "change", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); }
  submitFire(): void { this.dispatchEvent({ type: "submit", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); }
  focus(): void { this.focused = true; }

  matchesOne(sel: string): boolean {
    if (sel.startsWith(".")) return this.classSet.has(sel.slice(1));
    if (sel.startsWith("#")) return this.id === sel.slice(1);
    if (sel.startsWith("[")) { const k = sel.slice(1, -1).split("=")[0]!; return this.hasAttribute(k); }
    return this.nodeType === 1 && this.tagName === sel.toUpperCase();
  }
  walk(cb: (n: ShimNode) => void): void { for (const c of this.childNodes) { cb(c); c.walk(cb); } }
  querySelectorAll(sel: string): ShimNode[] {
    const out: ShimNode[] = [];
    this.walk((n) => { if (n.nodeType === 1 && n.matchesOne(sel)) out.push(n); });
    return out;
  }
  querySelector(sel: string): ShimNode | null { return this.querySelectorAll(sel)[0] ?? null; }

  findButtonByText(s: string): ShimNode | null {
    let found: ShimNode | null = null;
    this.walk((n) => { if (!found && n.tagName === "BUTTON" && n.textContent.includes(s)) found = n; });
    return found;
  }
  findByTag(tag: string): ShimNode[] { const out: ShimNode[] = []; const T = tag.toUpperCase(); this.walk((n) => { if (n.tagName === T) out.push(n); }); return out; }
  textIncludes(s: string): boolean { return this.textContent.includes(s); }
}

function installDomShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const body = new ShimNode("element", "body");
  const appHost = new ShimNode("element", "div");
  appHost.id = "app";
  body.appendChild(appHost);
  g.document = {
    __shim: true,
    body,
    createElement: (tag: string) => new ShimNode("element", tag),
    createElementNS: (_ns: string, tag: string) => new ShimNode("element", tag),
    createTextNode: (t: string) => { const n = new ShimNode("text"); n.text_ = t == null ? "" : String(t); return n; },
    createDocumentFragment: () => new ShimNode("fragment"),
    getElementById: (id: string) => (id === "app" ? appHost : null),
    querySelector: () => null,
    contains: () => true,
    get activeElement() { return null; },
    readyState: "complete",
    addEventListener: () => {},
  };
  g.Node = ShimNode;
  g.window = globalThis; // window === globalThis: do NOT override its setTimeout (that is the real one
  // flushAsync relies on). No URL.createObjectURL / Blob is installed: the panel's downloadText guards on
  // their absence and no-ops, so a missing browser API simply means "no blob download fired"; the download
  // test wires its OWN downloadText capture rather than the screen's blob path.
  if (!("location" in g)) g.location = { origin: "https://console.test", pathname: "/", search: "", hash: "" };
  if (typeof (g.queueMicrotask) !== "function") g.queueMicrotask = (fn: () => void) => { void Promise.resolve().then(fn); };
}

installDomShim();

import type {
  Caller,
  EngineClient,
  PasskeyFinish,
  RecoveryFinish,
  StatusReport,
} from "../src/api.ts";
// Now it is safe to import the modules under test.
import {
  RECOVERY_CODES_FILENAME,
  recoveryCodesPanel,
  recoveryCodesText,
} from "../src/components/recovery-codes-panel.ts";
import { installNav } from "../src/lib/nav.ts";
import { setCaller } from "../src/lib/store.ts";
import {
  type AttestationCredentialLike,
  recoveryTransportMessage,
  runRecovery,
  runRegister,
} from "../src/screens/passkey.ts";
import {
  configApprovalControl,
  RECOVERY_CODES_LOW_AT,
  recoveryCountTone,
  renderRecoveryAccess,
  retireRefuseText,
  signInContextControl,
} from "../src/screens/security-centre.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}

// A 401-shaped error the way the engine client throws it (the verb + status the classifier reads).
function unauthorisedError(verb: string): Error { return new Error(`${verb}: 401`); }

// ---- a minimal capturing engine stub (only the recovery methods the flows touch) ----------------
interface RecoveryEngineState {
  recoverArgs: Array<{ email: string; code: string }>;
  recoverResult: RecoveryFinish | (() => never);
  registerFinishResult: PasskeyFinish;
  regenerateResult: { recoveryCodes: string[] };
  retireBehaviour: "ok" | (() => never);
  status: StatusReport;
  // confirmCalls counts confirmRecoveryCodes invocations;
  // optional (defaults to 0 in the stub) so the many pre-existing literals here need no update.
  // confirmBehaviour lets a case make the call reject, to prove the boot still proceeds (best-effort).
  confirmCalls?: number;
  confirmBehaviour?: "ok" | (() => never);
  approvalPolicy?: boolean;
  // Read by getConfigApprovalPolicy and written by setSignInContextPolicy, so it belongs on the state
  // the stub is driven from. Optional like approvalPolicy: a case that does not set it means the
  // engine has no such policy recorded, which is a state the screen has to render.
  signInContextPolicy?: boolean;
}
function makeRecoveryEngine(s: RecoveryEngineState): EngineClient {
  const stub = {
    async recoverWithCode(email: string, code: string): Promise<RecoveryFinish> {
      s.recoverArgs.push({ email, code });
      if (typeof s.recoverResult === "function") return s.recoverResult();
      return s.recoverResult;
    },
    // runRegister calls begin -> create -> finish; here we only need finish to return codes, and begin to
    // succeed with minimal options the screen can decode. The WebAuthn create is stubbed via navigator.
    async passkeyRegisterBegin() {
      return { ok: true as const, challengeScope: "x", publicKey: { rp: { id: "engine.test", name: "DP" }, user: { id: b64(new Uint8Array([1, 2, 3])), name: "you@example.com", displayName: "You" }, challenge: b64(new Uint8Array([4, 5, 6])), pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }] } };
    },
    async passkeyRegisterFinish(): Promise<PasskeyFinish> { return s.registerFinishResult; },
    async regenerateRecoveryCodes() { return s.regenerateResult; },
    async confirmRecoveryCodes() {
      s.confirmCalls = (s.confirmCalls ?? 0) + 1;
      if (typeof s.confirmBehaviour === "function") return s.confirmBehaviour();
      return { promoted: true };
    },
    async retireBreakGlassToken() { if (typeof s.retireBehaviour === "function") return s.retireBehaviour(); return { retired: true }; },
    async status() { return s.status; },
    async getConfigApprovalPolicy() { return { requireConfigApproval: s.approvalPolicy === true, notifyNewSignInContext: s.signInContextPolicy === true }; },
    async setConfigApprovalPolicy(on: boolean) { s.approvalPolicy = on; return { status: "result" as const, value: { requireConfigApproval: on } }; },
    async setSignInContextPolicy(on: boolean) { s.signInContextPolicy = on; return { notifyNewSignInContext: on }; },
  };
  return stub as unknown as EngineClient;
}

// minimal base64url for the begin fixture (the screen decodes user.id / challenge).
function b64(u: Uint8Array): string {
  let s = ""; for (const x of u) s += String.fromCharCode(x);
  return Buffer.from(s, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A FlowHandles capture (records statuses, busy, success, and the showRecoveryCodes invocation).
interface HandlesCapture {
  statuses: Array<ShimNode | null>;
  successRan: boolean;
  shownCodes: string[] | null;
  proceed: (() => void) | null;
  handles: {
    setStatus: (n: HTMLElement | null) => void;
    setBusy: (b: boolean, a?: string) => void;
    onSuccess: () => Promise<void>;
    showRecoveryCodes?: (codes: string[], proceed: () => void) => void;
  };
}
function makeHandles(withPanel: boolean): HandlesCapture {
  const cap: HandlesCapture = {
    statuses: [], successRan: false, shownCodes: null, proceed: null,
    handles: {
      setStatus: (n) => { cap.statuses.push(n as unknown as ShimNode | null); },
      setBusy: () => {},
      onSuccess: async () => { cap.successRan = true; },
      ...(withPanel ? { showRecoveryCodes: (codes: string[], proceed: () => void) => { cap.shownCodes = codes; cap.proceed = proceed; } } : {}),
    },
  };
  return cap;
}

// Install a navigator stub so runRegister's create() returns a fixture credential.
function installWebAuthnCreate(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const cred = {
    rawId: new ArrayBuffer(4),
    response: { clientDataJSON: new ArrayBuffer(4), attestationObject: new ArrayBuffer(4) },
  };
  Object.defineProperty(g, "navigator", {
    configurable: true, writable: true,
    value: { credentials: { create: async () => cred as unknown, get: async () => null } },
  });
  g.PublicKeyCredential = function PublicKeyCredential() {};
}
installWebAuthnCreate();
// keep the type import referenced (the fixture mirrors AttestationCredentialLike).
const _attCheck: AttestationCredentialLike | null = null; void _attCheck;

// SECTION 1: recoveryCodesText (pure) + recoveryCountTone (pure) + retireRefuseText (pure)
function testRecoveryCodesText(): void {
  console.log("\n-- recoveryCodesText: lists codes verbatim + save-or-lose framing --");
  {
    const codes = ["AAAA-1111", "BBBB-2222", "CCCC-3333"];
    const txt = recoveryCodesText(codes);
    ok("every code appears verbatim", codes.every((c) => txt.includes(c)));
    ok("states shown only once", /shown only once|only once/i.test(txt));
    ok("states save offline", /save them offline|save them offline now|offline/i.test(txt));
    ok("explains a new set invalidates the old", /invalidates every code/i.test(txt));
    ok("no em dash (house style)", !txt.includes("—") && !txt.includes("–"));
  }

  console.log("\n-- recoveryCountTone: 0=danger, low=warn, healthy=ok (never a stale green) --");
    ok("0 remaining reads danger", recoveryCountTone(0) === "danger");
    ok(`low (<=${RECOVERY_CODES_LOW_AT}) reads warn`, recoveryCountTone(RECOVERY_CODES_LOW_AT) === "warn");
    ok("healthy reads ok", recoveryCountTone(10) === "ok");

  console.log("\n-- retireRefuseText: pulls the engine's refuse reason out of the folded error --");
  {
    const reason = retireRefuseText(new Error("retire break-glass token: no break-glass exists yet: 409"));
    ok("extracts the bare reason (drops verb + status)", reason === "no break-glass exists yet");
    const raw = retireRefuseText(new Error("some other failure"));
    ok("a non-matching message degrades to the raw text", raw === "some other failure");
  }
}

// SECTION 2: recoveryCodesPanel (rendered) - the save-confirm gate
function testRecoveryCodesPanel(): void {
  console.log("\n-- recoveryCodesPanel: codes shown + Continue gated on the save-confirm --");
  {
    const codes = ["CODE-AAA", "CODE-BBB", "CODE-CCC", "CODE-DDD"];
    // Recorded onto a holder: a local `let` written only from inside a callback stays narrowed to its
    // initialiser, so `=== true` reads as always-false and `=== false` as always-true. Both prove
    // nothing to the compiler even though the runtime check is real.
    const rec = { confirmed: false };
    const downloads: Array<{ name: string; content: string }> = [];
    const panel = recoveryCodesPanel({
      codes,
      context: "enrol",
      // Returns true rather than push's new length. Truthy either way, so the panel behaved, but the
      // contract is whether the browser ACCEPTED the delivery and an array length is not that answer.
      downloadText: (name, content) => {
        downloads.push({ name, content });
        return true;
      },
      onConfirm: () => { rec.confirmed = true; },
    }) as unknown as ShimNode;

    ok("the codes are rendered in the panel", codes.every((c) => panel.textIncludes(c)));
    ok("the save-or-lose heading is present", panel.textIncludes("Save your recovery codes"));
    ok("the unmissable warning is present", panel.textIncludes("You will not see them again"));

    const continueBtn = panel.findButtonByText("Continue");
    ok("a Continue button exists", continueBtn !== null);
    ok("Continue starts DISABLED (save-confirm not yet ticked)", continueBtn!.disabled === true);

    // Clicking Continue before ticking does nothing (belt and braces).
    continueBtn!.click();
    ok("clicking a disabled Continue does NOT confirm", rec.confirmed === false);

    // Tick the save-confirm checkbox -> Continue enables.
    const checkbox = panel.querySelectorAll("input").find((n) => n.getAttribute("type") === "checkbox");
    ok("the save-confirm checkbox exists", checkbox !== undefined);
    checkbox!.checked = true;
    checkbox!.changeFire();
    ok("ticking the checkbox ENABLES Continue", continueBtn!.disabled === false);

    // Download offers the full .txt artefact.
    const dlBtn = panel.findButtonByText("Download .txt");
    ok("a Download .txt button exists", dlBtn !== null);
    dlBtn!.click();
    ok("Download calls downloadText with the fixed .txt filename", downloads.length === 1 && downloads[0]!.name === RECOVERY_CODES_FILENAME);
    ok("the downloaded body carries every code", codes.every((c) => downloads[0]!.content.includes(c)));

    // Now Continue fires onConfirm.
    continueBtn!.click();
    ok("a ticked Continue fires onConfirm", rec.confirmed === true);
  }
}

// SECTION 3: runRecovery (real flow) - the "use a recovery code" sign-in
async function testRunRecovery(): Promise<void> {
  console.log("\n-- runRecovery: POSTs { email, code }; routes to enrol on enrolPasskey --");
  {
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: true },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(false);
    // Recorded onto a holder: a local `let` written only from inside a callback stays narrowed to its
    // initialiser, so `=== true` reads as always-false and `=== false` as always-true. Both prove
    // nothing to the compiler even though the runtime check is real.
    const rec = { enrolNextCalled: false };
    await runRecovery(engine, "you@example.com", "CODE-AAA", cap.handles, () => { rec.enrolNextCalled = true; });
    await flushAsync();
    ok("recoverWithCode received the email + code verbatim", s.recoverArgs.length === 1 && s.recoverArgs[0]!.email === "you@example.com" && s.recoverArgs[0]!.code === "CODE-AAA");
    ok("enrolPasskey:true routes to a fresh passkey enrolment", rec.enrolNextCalled === true);
    ok("the normal boot did NOT run (enrolment takes over)", cap.successRan === false);
  }

  console.log("\n-- runRecovery: enrolPasskey:false runs the normal boot --");
  {
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "viewer", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(false);
    // Recorded onto a holder: a local `let` written only from inside a callback stays narrowed to its
    // initialiser, so `=== true` reads as always-false and `=== false` as always-true. Both prove
    // nothing to the compiler even though the runtime check is real.
    const rec = { enrolNextCalled: false };
    await runRecovery(engine, "v@example.com", "CODE-XYZ", cap.handles, () => { rec.enrolNextCalled = true; });
    await flushAsync();
    ok("the normal boot ran", cap.successRan === true);
    ok("enrolNext was NOT called", rec.enrolNextCalled === false);
  }

  console.log("\n-- runRecovery: a generic 401 surfaces ONE generic line (no oracle), no boot --");
  {
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: () => { throw unauthorisedError("recovery sign-in"); },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(false);
    // Recorded onto a holder: a local `let` written only from inside a callback stays narrowed to its
    // initialiser, so `=== true` reads as always-false and `=== false` as always-true. Both prove
    // nothing to the compiler even though the runtime check is real.
    const rec = { enrolNextCalled: false };
    await runRecovery(engine, "x@example.com", "WRONG", cap.handles, () => { rec.enrolNextCalled = true; });
    await flushAsync();
    ok("the boot did NOT run on failure", cap.successRan === false);
    ok("enrolNext was NOT called on failure", rec.enrolNextCalled === false);
    const last = lastStatusText(cap);
    ok("the failure copy is generic (mentions email AND code, not which failed)", /recovery code/i.test(last) && /email/i.test(last));
    ok("the failure copy leaks no status code / oracle", !/401/.test(last));
  }

  console.log("\n-- recoveryTransportMessage (pure): a transport fault reads 'could not reach the engine' --");
  {
    // THE FIXTURE IS A BROWSER'S OWN WORDING NOW, AND THAT IS THE POINT OF THE REPAIR RATHER THAN A
    // CONVENIENCE. It used to be `new Error("network down")`, which no browser has ever said. Until
    // that did not matter, because classifyError returned `network` for ANY message
    // carrying no HTTP status, so a made-up wording and a real one were the same input. That commit made
    // the premise testable instead of assumed: only a message reading as a fetch failure stays `network`,
    // and everything else becomes `console-fault`, precisely so a TypeError from the console's own render
    // code stops reading as an unreachable engine. "network down" is on the wrong side of that line, and
    // correctly so. A TypeError saying "Failed to fetch" is what Chromium actually rejects with, so this
    // now drives the state the assertion has always been about.
    const msg = recoveryTransportMessage(new TypeError("Failed to fetch"));
    ok("names the engine being unreachable", /could not reach the engine/i.test(msg));
    // THE OTHER HALF OF THE SPLIT, WHICH NOTHING HERE ASKED BEFORE, so this file cannot go green again by
    // the copy becoming unconditional. A throw that establishes no such thing must NOT send a break-glass
    // operator off to check the network: this is the path they are on because the ordinary way in stopped
    // working, and a wrong direction costs most here.
    const notATransportFault = recoveryTransportMessage(new Error("Cannot read properties of undefined"));
    ok("but a throw that established no such thing does NOT", !/could not reach the engine/i.test(notATransportFault));
  }
}

// SECTION 4: runRegister + showRecoveryCodes - the one-time codes on enrolment
async function testRunRegister(): Promise<void> {
  console.log("\n-- runRegister: a finish with recoveryCodes invokes showRecoveryCodes + DEFERS the boot --");
  {
    const codes = ["NEW-1", "NEW-2", "NEW-3"];
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: true, email: "you@example.com", bootstrapped: true, recoveryCodes: codes },
      regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok", status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(true);
    await runRegister(engine, "you@example.com", cap.handles);
    await flushAsync();
    ok("showRecoveryCodes was invoked with the issued codes", JSON.stringify(cap.shownCodes) === JSON.stringify(codes));
    ok("the boot was DEFERRED (not run before the codes were acknowledged)", cap.successRan === false);
    ok("a proceed callback was supplied", typeof cap.proceed === "function");
    // Simulating the operator confirming the panel runs the boot.
    cap.proceed!();
    await flushAsync();
    ok("confirming the codes proceeds to the boot", cap.successRan === true);
  }

  console.log("\n-- runRegister: a finish with NO codes runs the boot straight away (unchanged) --");
  {
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: true, email: "you@example.com", bootstrapped: false },
      regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok", status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(true);
    await runRegister(engine, "you@example.com", cap.handles);
    await flushAsync();
    ok("no codes -> showRecoveryCodes NOT invoked", cap.shownCodes === null);
    ok("no codes -> the boot ran straight away", cap.successRan === true);
  }

  // recoveryCodesPending:true (a self-add re-enrolment over
  // an existing live set -- the forced re-enrolment after a recovery-code sign-in is the common case) means
  // the fresh codes shown are STAGED, not yet live. Confirming the panel must tell the engine before the
  // boot proceeds, or the old set would be abandoned as dead without the console ever having said so.
  console.log("\n-- runRegister: recoveryCodesPending:true calls confirmRecoveryCodes BEFORE the boot --");
  {
    const codes = ["STAGED-1", "STAGED-2"];
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: true, email: "you@example.com", bootstrapped: false, recoveryCodes: codes, recoveryCodesPending: true },
      regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok", status: baseStatus(),
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(true);
    await runRegister(engine, "you@example.com", cap.handles);
    await flushAsync();
    ok("the staged codes are shown", JSON.stringify(cap.shownCodes) === JSON.stringify(codes));
    ok("confirmRecoveryCodes was NOT called before the operator confirmed the panel", (s.confirmCalls ?? 0) === 0);
    ok("the boot was deferred", cap.successRan === false);
    cap.proceed!();
    await flushAsync();
    ok("confirming the panel calls confirmRecoveryCodes exactly once", s.confirmCalls === 1);
    ok("and only then does the boot proceed", cap.successRan === true);
  }

  console.log("\n-- runRegister: recoveryCodesPending:true still boots even if the confirm call fails --");
  {
    // The safe failure: an operator who is already signed in and already saw the codes must never be stuck
    // on a frozen screen because the follow-up confirm round trip failed. The cost of that failure is that
    // the OLD codes stay the live set (safe, and invisible to this test, which only proves the boot is not
    // blocked); it is never treated as a failed enrolment.
    const s: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: true, email: "you@example.com", bootstrapped: false, recoveryCodes: ["STAGED-3"], recoveryCodesPending: true },
      regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok", status: baseStatus(),
      confirmBehaviour: () => { throw new Error("network"); },
    };
    const engine = makeRecoveryEngine(s);
    const cap = makeHandles(true);
    await runRegister(engine, "you@example.com", cap.handles);
    await flushAsync();
    cap.proceed!();
    await flushAsync();
    ok("a failed confirm still lets the boot proceed (the old codes staying live is the safe outcome)", cap.successRan === true);
  }
}

// SECTION 5: renderRecoveryAccess (Security Centre) - count + regenerate + owner-only retire
async function testRenderRecoveryAccess(): Promise<void> {
  console.log("\n-- renderRecoveryAccess: shows the count, offers Regenerate, gates retire on Owner --");
  {
    const s = makeRecoveryEngine({
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: ["R1", "R2"] }, retireBehaviour: "ok",
      status: { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false },
    });

    // As an OWNER: the retire control is enabled (not disabled).
    setOwnerCaller("owner");
    const ownerTree = renderRecoveryAccess(s, { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false }, true, () => {}) as unknown as ShimNode;
    ok("shows the remaining count", ownerTree.textIncludes("2 unused codes remaining"));
    ok("offers a Regenerate action", ownerTree.findButtonByText("Regenerate recovery codes") !== null);
    const ownerRetire = ownerTree.findButtonByText("Retire break-glass token");
    ok("an Owner sees an ENABLED Retire break-glass token control", ownerRetire !== null && ownerRetire.disabled === false);
    ok("an Owner does NOT see the 'Owner only' read-only note", !ownerTree.textIncludes("Owner only"));

    // As a NON-OWNER: the retire control is read-only (disabled-with-reason + 'Owner only').
    // Disabled-with-reason, not the native `disabled` attribute: the button stays
    // reachable in the tab order and announces why via aria-disabled + aria-describedby.
    setOwnerCaller("operator");
    const viewerTree = renderRecoveryAccess(s, { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false }, false, () => {}) as unknown as ShimNode;
    const viewerRetire = viewerTree.findButtonByText("Retire break-glass token");
    ok("a non-owner sees a DISABLED Retire break-glass token control", viewerRetire !== null && viewerRetire.getAttribute("aria-disabled") === "true");
    ok("a non-owner sees the 'Owner only' read-only note", viewerTree.textIncludes("Owner only"));

    // AND THE ATTRIBUTE IS NOT THE PROPERTY. aria-disabled is an announcement: no browser blocks a click
    // on it, and this shim's dispatchEvent fires every listener regardless. So the line above says only
    // that the refusal was ANNOUNCED, and would still pass if the retire handler were attached and the
    // token retired on the first press. What actually refuses a non-owner is that the else branch of
    // retireBreakGlassControl never attaches a handler at all, so the property is asserted by DRIVING the
    // control: press it and require that the engine's retire was not reached.
    let viewerRetireCalls = 0;
    const watched = makeRecoveryEngine({
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] },
      retireBehaviour: (() => { viewerRetireCalls++; return { retired: true }; }) as unknown as () => never,
      status: { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false },
    });
    setOwnerCaller("operator");
    const watchedTree = renderRecoveryAccess(watched, { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false }, false, () => {}) as unknown as ShimNode;
    const watchedRetire = watchedTree.findButtonByText("Retire break-glass token");
    const bodyNodes = (): number => { let n = 0; const walk = (x: ShimNode): void => { n++; for (const c of x.childNodes) walk(c); }; walk((globalThis as unknown as { document: { body: ShimNode } }).document.body); return n; };
    const beforeViewer = bodyNodes();
    watchedRetire?.click();
    await flushAsync();
    ok("pressing a non-owner's refused Retire does NOT reach the engine", viewerRetireCalls === 0);
    ok("and opens nothing: no confirm surface is raised for them either", bodyNodes() === beforeViewer);
    // The discrimination, without which both lines above would also pass on a control that is dead for
    // EVERYONE. A listener count cannot supply it: disabledWithReason attaches its own click blocker, so
    // the refused button and the Owner's each carry exactly one. The difference is what the press DOES, so
    // the same press is driven on an Owner's button and required to raise the confirm surface.
    setOwnerCaller("owner");
    const ownerWatched = renderRecoveryAccess(watched, { ...baseStatus(), recoveryCodesRemaining: 2, breakGlassTokenRetired: false, tokenFallbackDisabled: false }, true, () => {}) as unknown as ShimNode;
    const beforeOwner = bodyNodes();
    ownerWatched.findButtonByText("Retire break-glass token")?.click();
    await flushAsync();
    ok("while the SAME press by an Owner does raise the confirm surface", bodyNodes() > beforeOwner);
  }

  console.log("\n-- renderRecoveryAccess: an already-retired token shows 'retired' and no retire button --");
  {
    const s = makeRecoveryEngine({
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(),
    });
    setOwnerCaller("owner");
    const tree = renderRecoveryAccess(s, { ...baseStatus(), recoveryCodesRemaining: 8, breakGlassTokenRetired: true, tokenFallbackDisabled: true }, true, () => {}) as unknown as ShimNode;
    ok("a retired token reads 'Retired: the static bootstrap token can no longer sign in.'", tree.textIncludes("can no longer sign in"));
    ok("a retired token offers NO retire button", tree.findButtonByText("Retire break-glass token") === null);
  }
}

// SECTION 6: configApprovalControl (Security Centre) - the four-eyes switch
async function testConfigApprovalControl(): Promise<void> {
  console.log("\n-- configApprovalControl: the switch starts disabled; a non-owner stays read-only --");
  {
    // The STATE is held by name as well as the client built from it, because the driven assertions below
    // read the policy the engine actually holds; makeRecoveryEngine's setters write straight into it.
    const state: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(), approvalPolicy: false,
    };
    const s = makeRecoveryEngine(state);

    // As an OWNER: the switch starts disabled (still loading the policy) before the async load resolves.
    setOwnerCaller("owner");
    const ownerCard = configApprovalControl(s) as unknown as ShimNode;
    const ownerSwitch = ownerCard.querySelector("[role=switch]");
    ok("the four-eyes switch is rendered", ownerSwitch !== null);
    ok("the switch STARTS disabled (policy not yet loaded)", ownerSwitch!.disabled === true);
    ok("the switch starts unchecked", ownerSwitch!.getAttribute("aria-checked") === "false");
    await flushAsync();
    ok("once the policy loads, an Owner's switch ENABLES", ownerSwitch!.disabled === false);

    // As a NON-OWNER: the switch is permanently disabled-with-reason (read-only, but reachable) and
    // the state line says Owner only. Disabled-with-reason, not the native `disabled`
    // attribute: aria-disabled, so the switch stays in the tab order.
    setOwnerCaller("operator");
    const viewerCard = configApprovalControl(s) as unknown as ShimNode;
    const viewerSwitch = viewerCard.querySelector("[role=switch]");
    await flushAsync();
    ok("a non-owner's switch stays DISABLED after the policy loads", viewerSwitch !== null && viewerSwitch.getAttribute("aria-disabled") === "true");
    ok("a non-owner sees the 'Owner only' read-only note", viewerCard.textIncludes("Owner only"));

    // AND THE ATTRIBUTE IS NOT THE PROPERTY. Unlike the retire button, configApprovalControl attaches its
    // click handler UNCONDITIONALLY, so nothing about a non-owner's switch is enforced by its markup: the
    // whole refusal rests on the `!view.isOwner` early return inside onApprovalToggle. aria-disabled is an
    // announcement, disabledWithReason's blocker only calls preventDefault (which does not stop a sibling
    // listener on the same element), and this shim fires every listener regardless. So the line above would
    // still pass with that early return deleted and the policy flipping on the first press. Driven instead.
    const policyBefore = state.approvalPolicy;
    const bodyNodes = (): number => { let n = 0; const walk = (x: ShimNode): void => { n++; for (const c of x.childNodes) walk(c); }; walk((globalThis as unknown as { document: { body: ShimNode } }).document.body); return n; };
    const beforeNodes = bodyNodes();
    viewerSwitch!.click();
    await flushAsync();
    ok("pressing a non-owner's refused four-eyes switch does NOT change the policy", state.approvalPolicy === policyBefore);
    ok("and raises no confirm surface, so the refusal is before the flow, not inside it", bodyNodes() === beforeNodes);
    ok("and the switch still reads off afterwards", viewerSwitch!.getAttribute("aria-checked") === "false");
    // The discrimination: the SAME press by an Owner reaches the flow and raises the confirm surface.
    // Without this, the three lines above would also pass on a switch that is dead for everyone.
    const beforeOwnerNodes = bodyNodes();
    ownerSwitch!.click();
    await flushAsync();
    ok("while the SAME press by an Owner does raise the confirm surface", bodyNodes() > beforeOwnerNodes);
  }
}

// SECTION 7: signInContextControl (Security Centre) - the R6 unusual-location notify switch. It
// mirrors the four-eyes switch's owner gating exactly, so the same three properties are locked:
// starts disabled while loading, enables only for an Owner, and reads Owner-only for everyone else.
async function testSignInContextControl(): Promise<void> {
  console.log("\n-- signInContextControl: owner-gated switch bound to the signin-context policy --");
  {
    const state: RecoveryEngineState = {
      recoverArgs: [], recoverResult: { role: "owner", enrolPasskey: false },
      registerFinishResult: { ok: false, reason: "bad_request" }, regenerateResult: { recoveryCodes: [] }, retireBehaviour: "ok",
      status: baseStatus(), approvalPolicy: false,
    };
    const s = makeRecoveryEngine(state);
    setOwnerCaller("owner");
    const ownerCard = signInContextControl(s) as unknown as ShimNode;
    const ownerSwitch = ownerCard.querySelector("[role=switch]");
    ok("the sign-in-context switch is rendered", ownerSwitch !== null);
    ok("the switch STARTS disabled (policy not yet loaded)", ownerSwitch!.disabled === true);
    await flushAsync();
    ok("once the policy loads, an Owner's switch ENABLES", ownerSwitch!.disabled === false);
    ok("the default reads off", ownerSwitch!.getAttribute("aria-checked") === "false");
    // Disabled-with-reason, not the native `disabled` attribute: aria-disabled, so the
    // switch stays in the tab order.
    setOwnerCaller("operator");
    const viewerCard = signInContextControl(s) as unknown as ShimNode;
    const viewerSwitch = viewerCard.querySelector("[role=switch]");
    await flushAsync();
    ok("a non-owner's switch stays DISABLED after the policy loads", viewerSwitch !== null && viewerSwitch.getAttribute("aria-disabled") === "true");
    ok("a non-owner sees the 'Owner only' read-only note", viewerCard.textIncludes("Owner only"));
    ok("the privacy promise is stated in place (raw IP never stored)", ownerCard.textIncludes("never stored"));

    // Same shape as the four-eyes switch above, and the same reason: signInContextControl attaches its
    // click handler unconditionally too (signin-context.ts:95), so the refusal lives entirely in the
    // `!view.isOwner` early return and nothing in the markup enforces it. The attribute assertion is kept,
    // because the announcement is a real requirement, and the property it stands for is driven here.
    const policyBefore = state.signInContextPolicy;
    const bodyNodes = (): number => { let n = 0; const walk = (x: ShimNode): void => { n++; for (const c of x.childNodes) walk(c); }; walk((globalThis as unknown as { document: { body: ShimNode } }).document.body); return n; };
    const beforeNodes = bodyNodes();
    viewerSwitch!.click();
    await flushAsync();
    ok("pressing a non-owner's refused sign-in-notify switch does NOT change the policy", state.signInContextPolicy === policyBefore);
    ok("and raises no confirm surface for them", bodyNodes() === beforeNodes);
    const beforeOwnerNodes = bodyNodes();
    ownerSwitch!.click();
    await flushAsync();
    ok("while the SAME press by an Owner does raise the confirm surface", bodyNodes() > beforeOwnerNodes);
  }
}

// main runs the six independent sections in sequence. Each section is its own named
// function so a failing area is easy to isolate and the runner reads as a table of contents.
async function main(): Promise<void> {
  testRecoveryCodesText();
  testRecoveryCodesPanel();
  await testRunRecovery();
  await testRunRegister();
  await testRenderRecoveryAccess();
  await testConfigApprovalControl();
  await testSignInContextControl();

  console.log(failures === 0 ? "\nRECOVERY UI VALIDATION PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

// ---- helpers ------------------------------------------------------------------------------------

function baseStatus(): StatusReport {
  return {
    service: "downpipes-engine", engineVersion: "0.0.0", signerConfigured: true, breakGlassConfigured: true,
    operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2",
    updateChannelConfigured: false, licenceConfigured: false, downpipeCount: 1, ready: true,
  };
}

function setOwnerCaller(role: Caller["role"]): void {
  // isOnlyOwner is FALSE (a governance-mature estate with a second Owner): the four-eyes / dual-control switch
  // enables for an Owner only when a distinct second Owner exists (a lone Owner cannot arm it, the deadlock
  // guard), so the "an Owner's switch ENABLES" assertions here represent an Owner who is not the sole Owner.
  // The sole-Owner-disabled case is proven separately in validate-owner-floor.ts. isOnlyOwner is read only by
  // that switch gate, so this is a don't-care for every other control this test drives.
  const c: Caller = { method: "passkey", email: "me@example.com", role, groups: [], isOnlyOwner: false };
  setCaller(c);
}

function lastStatusText(cap: HandlesCapture): string {
  for (let i = cap.statuses.length - 1; i >= 0; i--) { const n = cap.statuses[i]; if (n) return n.textContent; }
  return "";
}

// Install a no-op nav bridge so navigate()/goSignedOut() in the flows do not throw under the shim.
installNav({
  navigate: () => {},
  onUnauthorised: () => {},
  refreshIdentity: async () => {},
  onAuthenticated: async () => {},
  // No-op like its neighbours: the recovery flows under test never reach signOut, so there is nothing
  // here to record. The bridge simply has to be complete or installNav will not take it.
  signOut: () => {},
});

main().catch((e) => { console.error(e); process.exit(1); });
