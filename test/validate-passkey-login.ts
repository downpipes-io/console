// Validate the PASSKEY sign-in screen (src/screens/passkey.ts): the engine's OWN WebAuthn front door, so
// a team signs in WITHOUT Cloudflare Access. The WebAuthn credential API is not available headless, so this
// drives the REAL screen logic with navigator.credentials + the engine api + the DOM STUBBED. It never
// re-implements the code under test: the option-decoding, the credential-encoding, the request-body
// shaping, the error mapping and the screen render all live in src/screens/passkey.ts and are exercised
// here. Run with `node test/validate-passkey-login.ts`.
//
// Coverage:
//   PURE helpers (no browser):
//     creationOptionsFromBegin / requestOptionsFromBegin: base64url option fields (challenge, user.id,
//       allow/exclude credential ids) decode to the exact ArrayBuffer bytes; pass-through fields survive
//     attestationCredentialToWire / assertionCredentialToWire: a create()/get() result encodes back to the
//       base64url wire shape the finish POSTs (rawId -> id, clientDataJSON/attestationObject or
//       clientDataJSON/authenticatorData/signature/userHandle), round-tripping the bytes exactly
//     webauthnSupported: the truth table over (hasCredentials, hasPublicKeyCredential)
//     reasonMessage / passkeyErrorMessage: honest copy for the coarse engine reasons and the thrown
//       DOMException cases (cancel/timeout, unsupported, insecure), with no em dash (house style)
//   FLOWS (real runLogin / runRegister with stubs), asserting the REQUEST BODIES the engine receives and
//   the success / cancel / unknown handling:
//     login success: login/begin(email) -> get(decoded options) -> login/finish(challengeId, encoded
//       assertion) -> onSuccess() runs (the cookie path); the finish body carries the begin's challengeId
//       and the b64url-encoded assertion
//     login cancel (navigator.credentials.get throws NotAllowedError): NO finish call, an honest inline
//       status, onSuccess NOT run
//     login unknown credential (finish ok:false reason unknown_credential): the unknown-credential copy,
//       onSuccess NOT run
//     login usernameless (no email): login/begin called with NO email
//     register success + bootstrap: register/begin(email) -> create(decoded options) -> register/finish
//       (email, encoded attestation) -> bootstrapped Owner note + onSuccess(); the finish body carries the
//       email and the b64url-encoded attestation
//     register already-registered (finish ok:false): the already-registered copy, onSuccess NOT run
//   RENDER (the unauthenticated-but-reachable state):
//     with an engine connected + WebAuthn supported, passkeyScreen.render() shows the live passkey login
//       (a "Sign in with a passkey" and a "Set up a passkey" control), NOT a dead 401
//     with WebAuthn unsupported, it shows the honest no-passkey-support notice and NO ceremony buttons

// ---- install a DOM shim + navigator/PublicKeyCredential BEFORE importing the screen --------------
// The screen module imports lib/dom.ts (document.createElement) at module load, and reads navigator /
// PublicKeyCredential at render/flow time, so the globals must exist first. We install a minimal shim
// (the same hand-rolled approach the other console validators use; no jsdom, no new dependency).

class ShimClassList {
  set: Set<string> = new Set();
  node: ShimNode;
  constructor(node: ShimNode) { this.node = node; }
  add(...cs: string[]): void { for (const c of cs) this.set.add(c); this.sync(); }
  remove(...cs: string[]): void { for (const c of cs) this.set.delete(c); this.sync(); }
  contains(c: string): boolean { return this.set.has(c); }
  sync(): void { this.node.attrs.class = [...this.set].join(" "); }
}

class ShimStyle {
  [prop: string]: string | ((p: string, v: string, priority?: string) => void);
  setProperty(prop: string, value: string): void { this[prop] = value; }
}

interface ShimEvent { type: string; target: ShimNode | null; currentTarget: ShimNode | null; defaultPrevented: boolean; preventDefault(): void; }

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
  classList: ShimClassList;
  value_ = "";
  disabled_ = false;
  placeholder_ = "";
  hidden_ = false;

  constructor(kind: "element" | "text" | "fragment", tag = "") {
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : kind === "fragment" ? 11 : 1;
    this.tagName = tag.toUpperCase();
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
  // remove() and the element-child accessors, because the shared toast live region uses them: it caps the
  // visible count with childElementCount/firstElementChild and takes a toast down with el.remove(). A shim
  // missing the methods the code under test calls does not report a gap, it throws mid-run and every
  // assertion after it stops existing.
  remove(): void { this.parentNode?.removeChild(this); }
  get childElementCount(): number { return this.childNodes.filter((c) => c.kind === "element").length; }
  get firstElementChild(): ShimNode | null { return this.childNodes.find((c) => c.kind === "element") ?? null; }

  removeChild(child: ShimNode): ShimNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  replaceChildren(...nodes: ShimNode[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(n);
  }
  get firstChild(): ShimNode | null { return this.childNodes[0] ?? null; }

  setAttribute(k: string, v: string): void {
    if (k === "class") { this.attrs.class = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); return; }
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }

  set className(v: string) { this.setAttribute("class", String(v)); }
  get className(): string { return this.attrs.class ?? ""; }
  set id(v: string) { this.attrs.id = String(v); }
  get id(): string { return this.attrs.id ?? ""; }
  set value(v: string) { this.value_ = String(v); }
  get value(): string { return this.value_; }
  set disabled(v: boolean) { this.disabled_ = !!v; }
  get disabled(): boolean { return this.disabled_; }
  set placeholder(v: string) { this.placeholder_ = String(v); }
  get placeholder(): string { return this.placeholder_; }
  set hidden(v: boolean) { this.hidden_ = !!v; if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get hidden(): boolean { return this.hidden_; }

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
    ev.target = ev.target ?? this; ev.currentTarget = this;
    for (const fn of [...(this.listeners[ev.type] ?? [])]) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  click(): void {
    this.dispatchEvent({ type: "click", target: null, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  }
  focus(): void { /* no-op */ }

  walk(cb: (n: ShimNode) => void): void { for (const c of this.childNodes) { cb(c); c.walk(cb); } }
  textIncludes(s: string): boolean { return this.textContent.includes(s); }
  findButtonByText(s: string): ShimNode | null {
    let found: ShimNode | null = null;
    this.walk((n) => { if (!found && n.tagName === "BUTTON" && n.textContent.includes(s)) found = n; });
    return found;
  }
  querySelectorAll(sel: string): ShimNode[] {
    const out: ShimNode[] = [];
    const tag = sel.toUpperCase();
    this.walk((n) => { if (n.tagName === tag) out.push(n); });
    return out;
  }
}

function installDomShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    __shim: true,
    createElement: (tag: string) => new ShimNode("element", tag),
    createElementNS: (_ns: string, tag: string) => new ShimNode("element", tag),
    createTextNode: (t: string) => { const n = new ShimNode("text"); n.text_ = t == null ? "" : String(t); return n; },
    createDocumentFragment: () => new ShimNode("fragment"),
    // A real body, because the step-up ceremony now ANNOUNCES itself through the shared toast live region
    // and that region is appended to document.body. Without one the announcement would throw here, and a
    // shim that quietly lacks the node the code under test writes to is a validator that stops validating.
    body: new ShimNode("element", "body"),
    readyState: "complete",
  };
  g.Node = ShimNode;
  g.window = globalThis;
  if (!("location" in g)) g.location = { origin: "https://console.test", pathname: "/", search: "" };
  g.localStorage = (() => {
    const store = new Map<string, string>();
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
  })();
}

installDomShim();

// ---- the navigator + PublicKeyCredential stub ---------------------------------------------------
// A controllable WebAuthn stub: each test sets the next create()/get() behaviour (return a fixture
// credential, return null, or throw a named DOMException). The created/requested options the screen passed
// are captured so the decode assertions can read them.

type WebAuthnBehaviour =
  | { kind: "credential"; cred: unknown }
  | { kind: "null" }
  | { kind: "throw"; name: string };

interface WebAuthnStubState {
  nextCreate: WebAuthnBehaviour;
  nextGet: WebAuthnBehaviour;
  lastCreateOptions: PublicKeyCredentialCreationOptions | null;
  lastGetOptions: PublicKeyCredentialRequestOptions | null;
  // What document.body read at the MOMENT the passkey sheet opened. The step-up ceremony's whole defect was
  // that this was empty: the browser sheet arrived with nothing in front of it. Snapshotting here is the
  // only place that can tell an announcement shown before the sheet from one shown after it.
  bodyTextAtGet: string;
}

const wa: WebAuthnStubState = {
  nextCreate: { kind: "null" },
  nextGet: { kind: "null" },
  lastCreateOptions: null,
  lastGetOptions: null,
  bodyTextAtGet: "",
};

function resolveBehaviour(b: WebAuthnBehaviour): unknown {
  if (b.kind === "credential") return b.cred;
  if (b.kind === "null") return null;
  const e = new Error(b.name);
  e.name = b.name;
  throw e;
}

// bodyText reads every text node under the shim's body, which is where the toast live region mounts.
function bodyText(): string {
  const body = (globalThis as unknown as { document: { body?: { textContent?: string } } }).document.body;
  return body?.textContent ?? "";
}

function installWebAuthnStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  Object.defineProperty(g, "navigator", {
    configurable: true,
    writable: true,
    value: {
      credentials: {
        create: async (opts: { publicKey: PublicKeyCredentialCreationOptions }) => {
          wa.lastCreateOptions = opts.publicKey;
          return resolveBehaviour(wa.nextCreate);
        },
        get: async (opts: { publicKey: PublicKeyCredentialRequestOptions }) => {
          wa.lastGetOptions = opts.publicKey;
          wa.bodyTextAtGet = bodyText();
          return resolveBehaviour(wa.nextGet);
        },
      },
    },
  });
  // The screen's feature-detect needs a PublicKeyCredential global to consider passkeys supported.
  g.PublicKeyCredential = function PublicKeyCredential() {};
}

installWebAuthnStub();

// None of the modules imported below touch document at LOAD time (their document use is inside
// functions), so installing the shim before calling any function is sufficient. The static import
// declarations below are hoisted regardless of their textual position.
import {
  passkeyScreen,
  creationOptionsFromBegin,
  requestOptionsFromBegin,
  attestationCredentialToWire,
  assertionCredentialToWire,
  webauthnSupported,
  reasonMessage,
  passkeyErrorMessage,
  recoveryTransportMessage,
  runLogin,
  runRegister,
  runStepUp,
  runStepUpOutcome,
  runBootstrapSend,
  type AttestationCredentialLike,
  type AssertionCredentialLike,
} from "../src/screens/passkey.ts";
import { noteStepUpFailure, stepUpFailureMessage, STEPUP_REQUIRED_MARKER } from "../src/lib/errors.ts";
import { errorDetail } from "../src/components/error-view.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { passkeyLoginBegin } from "../src/lib/api/client-passkey.ts";
import type {
  EngineClient,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
  PasskeyRegisterBegin,
  PasskeyLoginBegin,
  PasskeyFinish,
  PasskeyAttestationCredential,
  PasskeyAssertionCredential,
} from "../src/api.ts";
import { b64urlEncode, b64urlDecode } from "../src/bytes.ts";
import { connect, signOut } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import type { RouteMatch } from "../src/lib/router.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { engineRoots } from "./engine-path.ts";

const HERE = new URL(".", import.meta.url).pathname;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function rnd(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
function toBuf(u: Uint8Array): ArrayBuffer {
  // A fresh ArrayBuffer holding exactly these bytes (the fixtures hand the encoders an ArrayBuffer, as a
  // real PublicKeyCredential response does).
  const b = new ArrayBuffer(u.length);
  new Uint8Array(b).set(u);
  return b;
}
function bufToU8(x: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
}

// flushAsync drains microtasks + a few macrotask ticks so the awaited begin/get/finish chain settles.
async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
}

// ---- a capturing EngineClient stub --------------------------------------------------------------
// Only the five passkey methods are stubbed (the flows call no others). Each call records its arguments so
// the request-body assertions can read EXACTLY what the screen sent; the return value is set per test.
interface EngineStubState {
  registerBeginArgs: Array<{ email: string; displayName?: string; inviteToken?: string }>;
  registerFinishArgs: Array<{ email: string; credential: PasskeyAttestationCredential; displayName?: string; inviteToken?: string }>;
  loginBeginArgs: Array<{ email?: string }>;
  loginFinishArgs: Array<{ challengeId: string; credential: PasskeyAssertionCredential }>;
  // The step-up ceremony records the begin calls and the finish (challengeId + credential) the same way,
  // so the request-body assertions read EXACTLY what the screen sent.
  stepUpBeginCalls: number;
  stepUpFinishArgs: Array<{ challengeId: string; credential: PasskeyAssertionCredential }>;
  logoutCalls: number;
  bootstrapSendCalls: number;
  // When set, bootstrapSendLink throws this (the transport-fault variant) instead of resolving.
  bootstrapSendThrows?: Error;
  registerBeginResult: PasskeyRegisterBegin;
  registerFinishResult: PasskeyFinish;
  loginBeginResult: PasskeyLoginBegin;
  loginFinishResult: PasskeyFinish;
  stepUpBeginResult: PasskeyLoginBegin;
  stepUpFinishResult: { ok: true; stepUpToken: string } | { ok: false; reason: string };
}
function freshEngineState(): EngineStubState {
  return {
    registerBeginArgs: [], registerFinishArgs: [], loginBeginArgs: [], loginFinishArgs: [], stepUpBeginCalls: 0, stepUpFinishArgs: [], logoutCalls: 0, bootstrapSendCalls: 0,
    registerBeginResult: { ok: false, reason: "bad_request" },
    registerFinishResult: { ok: false, reason: "bad_request" },
    loginBeginResult: { ok: false, reason: "bad_request" },
    loginFinishResult: { ok: false, reason: "bad_request" },
    stepUpBeginResult: { ok: false, reason: "bad_request" },
    stepUpFinishResult: { ok: false, reason: "bad_request" },
  };
}
function makeEngineStub(s: EngineStubState): EngineClient {
  const stub = {
    // The stub records EXACTLY the args the screen passed (email + the optional displayName + the optional
    // inviteToken), so the request-body assertions read what the engine would receive. inviteToken is the
    // single-use, email-bound passkeyInvite token threaded from ?invite= on the invite-acceptance flow; it
    // is recorded only when supplied so a plain self-add register asserts it was NOT sent.
    async passkeyRegisterBegin(email: string, displayName?: string, inviteToken?: string): Promise<PasskeyRegisterBegin> {
      s.registerBeginArgs.push({ email, ...(displayName !== undefined ? { displayName } : {}), ...(inviteToken !== undefined ? { inviteToken } : {}) });
      return s.registerBeginResult;
    },
    async passkeyRegisterFinish(email: string, credential: PasskeyAttestationCredential, displayName?: string, inviteToken?: string): Promise<PasskeyFinish> {
      s.registerFinishArgs.push({ email, credential, ...(displayName !== undefined ? { displayName } : {}), ...(inviteToken !== undefined ? { inviteToken } : {}) });
      return s.registerFinishResult;
    },
    async passkeyLoginBegin(email?: string): Promise<PasskeyLoginBegin> {
      s.loginBeginArgs.push(email !== undefined ? { email } : {});
      return s.loginBeginResult;
    },
    async passkeyLoginFinish(challengeId: string, credential: PasskeyAssertionCredential): Promise<PasskeyFinish> {
      s.loginFinishArgs.push({ challengeId, credential });
      return s.loginFinishResult;
    },
    // The step-up ceremony: stepup/begin issues a fresh request-options challenge, stepup/finish verifies
    // the assertion and returns the single-use step-up token. The stub records the begin count and the
    // finish (challengeId + credential) so the wire-body assertions read what the engine receives.
    async stepUpBegin(): Promise<PasskeyLoginBegin> {
      s.stepUpBeginCalls++;
      return s.stepUpBeginResult;
    },
    async stepUpFinish(challengeId: string, credential: PasskeyAssertionCredential): Promise<{ ok: true; stepUpToken: string } | { ok: false; reason: string }> {
      s.stepUpFinishArgs.push({ challengeId, credential });
      return s.stepUpFinishResult;
    },
    async passkeyLogout(): Promise<{ ok: boolean }> {
      s.logoutCalls++;
      return { ok: true };
    },
    // The first-run send: the engine is a no-oracle generic 200 on this route, so the stub returns the
    // same { ok:true } always; bootstrapSendThrows simulates the one distinguishable case (transport).
    async bootstrapSendLink(): Promise<{ ok: boolean }> {
      s.bootstrapSendCalls++;
      if (s.bootstrapSendThrows !== undefined) throw s.bootstrapSendThrows;
      return { ok: true };
    },
  };
  return stub as unknown as EngineClient;
}

// A FlowHandles capture: records the status nodes set and whether onSuccess ran, so the success/cancel/
// unknown assertions can read the outcome without a live shell.
interface HandlesCapture {
  statuses: Array<ShimNode | null>;
  successRan: boolean;
  busyHistory: boolean[];
  handles: { setStatus: (n: HTMLElement | null) => void; setBusy: (b: boolean, a?: string) => void; onSuccess: () => Promise<void> };
}
function makeHandles(): HandlesCapture {
  const cap: HandlesCapture = {
    statuses: [], successRan: false, busyHistory: [],
    handles: {
      setStatus: (n: HTMLElement | null) => { cap.statuses.push(n as unknown as ShimNode | null); },
      setBusy: (b: boolean) => { cap.busyHistory.push(b); },
      onSuccess: async () => { cap.successRan = true; },
    },
  };
  return cap;
}
function lastStatusText(cap: HandlesCapture): string {
  for (let i = cap.statuses.length - 1; i >= 0; i--) { const n = cap.statuses[i]; if (n) return n.textContent; }
  return "";
}

// The byte fixtures shared across the sections (the option/credential round-trips).
interface PasskeyFixtures { challenge: Uint8Array; userHandle: Uint8Array; credId: Uint8Array; }

// SECTION 1: PURE helpers. Option/credential decode + encode round-trips and the copy/feature
// tables, none of which touch the screen flows. Split out of main() so each section is its own
// named function; bodies are unchanged.
async function testPureHelpers(fx: PasskeyFixtures): Promise<void> {
  const { challenge, userHandle, credId } = fx;
  console.log("\n-- creationOptionsFromBegin: base64url option fields decode to exact bytes --");
  {
    const begin: PasskeyCreationOptions = {
      rp: { id: "engine.test", name: "Downpipes" },
      user: { id: b64urlEncode(userHandle), name: "you@example.com", displayName: "You" },
      challenge: b64urlEncode(challenge),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
      timeout: 120000,
      attestation: "none",
      excludeCredentials: [{ type: "public-key", id: b64urlEncode(credId), transports: ["internal", "hybrid", "made-up-token"] }],
    };
    const out = creationOptionsFromBegin(begin);
    ok("challenge decodes to the exact bytes", bytesEq(bufToU8(out.challenge), challenge));
    ok("user.id decodes to the exact handle bytes", bytesEq(bufToU8(out.user.id), userHandle));
    ok("user.name/displayName pass through", out.user.name === "you@example.com" && out.user.displayName === "You");
    ok("rp passes through", out.rp.id === "engine.test" && out.rp.name === "Downpipes");
    ok("pubKeyCredParams pass through (ES256 then RS256)", out.pubKeyCredParams.length === 2 && out.pubKeyCredParams[0]!.alg === -7 && out.pubKeyCredParams[1]!.alg === -257);
    ok("timeout + attestation pass through", out.timeout === 120000 && out.attestation === "none");
    const exc = out.excludeCredentials ?? [];
    ok("excludeCredentials id decodes to the exact credential id bytes", exc.length === 1 && bytesEq(bufToU8(exc[0]!.id as ArrayBuffer), credId));
    ok("excludeCredentials keeps only known transports (drops the unknown token)", JSON.stringify(exc[0]!.transports) === JSON.stringify(["internal", "hybrid"]));
  }

  console.log("\n-- requestOptionsFromBegin: base64url request fields decode to exact bytes --");
  {
    const begin: PasskeyRequestOptions = {
      challenge: b64urlEncode(challenge),
      rpId: "engine.test",
      userVerification: "preferred",
      timeout: 120000,
      allowCredentials: [{ type: "public-key", id: b64urlEncode(credId), transports: ["usb"] }],
    };
    const out = requestOptionsFromBegin(begin);
    ok("challenge decodes to the exact bytes", bytesEq(bufToU8(out.challenge), challenge));
    ok("rpId passes through", out.rpId === "engine.test");
    ok("userVerification passes through", out.userVerification === "preferred");
    const allow = out.allowCredentials ?? [];
    ok("allowCredentials id decodes to the exact credential id bytes", allow.length === 1 && bytesEq(bufToU8(allow[0]!.id as ArrayBuffer), credId));
    // usernameless: an empty allowCredentials stays empty (the browser offers any resident passkey).
    const empty = requestOptionsFromBegin({ challenge: b64urlEncode(challenge), rpId: "engine.test" });
    ok("absent allowCredentials yields an empty list (usernameless flow)", (empty.allowCredentials ?? []).length === 0);
  }

  console.log("\n-- attestationCredentialToWire: a create() result encodes to the finish wire shape --");
  {
    const clientDataJSON = rnd(80);
    const attestationObject = rnd(200);
    const cred: AttestationCredentialLike = {
      rawId: toBuf(credId),
      response: { clientDataJSON: toBuf(clientDataJSON), attestationObject: toBuf(attestationObject), getTransports: () => ["internal"] },
    };
    const wire = attestationCredentialToWire(cred);
    ok("id is base64url(rawId)", wire.id === b64urlEncode(credId) && wire.rawId === wire.id);
    ok("type is public-key", wire.type === "public-key");
    ok("clientDataJSON round-trips through base64url", bytesEq(b64urlDecode(wire.response.clientDataJSON), clientDataJSON));
    ok("attestationObject round-trips through base64url", bytesEq(b64urlDecode(wire.response.attestationObject), attestationObject));
    ok("transports captured from getTransports()", JSON.stringify(wire.response.transports) === JSON.stringify(["internal"]));
    // No getTransports(): the transports field is omitted (exactOptionalPropertyTypes-friendly).
    const noT = attestationCredentialToWire({ rawId: toBuf(credId), response: { clientDataJSON: toBuf(clientDataJSON), attestationObject: toBuf(attestationObject) } });
    ok("transports omitted when the browser reports none", noT.response.transports === undefined);
  }

  console.log("\n-- assertionCredentialToWire: a get() result encodes to the finish wire shape --");
  {
    const clientDataJSON = rnd(80);
    const authenticatorData = rnd(37);
    const signature = rnd(70);
    const credWithHandle: AssertionCredentialLike = {
      rawId: toBuf(credId),
      response: { clientDataJSON: toBuf(clientDataJSON), authenticatorData: toBuf(authenticatorData), signature: toBuf(signature), userHandle: toBuf(userHandle) },
    };
    const wire = assertionCredentialToWire(credWithHandle);
    ok("id is base64url(rawId)", wire.id === b64urlEncode(credId) && wire.rawId === wire.id);
    ok("type is public-key", wire.type === "public-key");
    ok("clientDataJSON round-trips", bytesEq(b64urlDecode(wire.response.clientDataJSON), clientDataJSON));
    ok("authenticatorData round-trips", bytesEq(b64urlDecode(wire.response.authenticatorData), authenticatorData));
    ok("signature round-trips", bytesEq(b64urlDecode(wire.response.signature), signature));
    ok("userHandle round-trips when present", wire.response.userHandle !== undefined && bytesEq(b64urlDecode(wire.response.userHandle), userHandle));
    // A null userHandle (common for a non-resident assertion): the field is omitted.
    const noHandle = assertionCredentialToWire({ rawId: toBuf(credId), response: { clientDataJSON: toBuf(clientDataJSON), authenticatorData: toBuf(authenticatorData), signature: toBuf(signature), userHandle: null } });
    ok("userHandle omitted when null", noHandle.response.userHandle === undefined);
  }

  console.log("\n-- webauthnSupported: feature-detect truth table --");
    ok("both present -> supported", webauthnSupported({ hasCredentials: true, hasPublicKeyCredential: true }));
    ok("no PublicKeyCredential -> unsupported", !webauthnSupported({ hasCredentials: true, hasPublicKeyCredential: false }));
    ok("no navigator.credentials -> unsupported", !webauthnSupported({ hasCredentials: false, hasPublicKeyCredential: true }));
    ok("neither -> unsupported", !webauthnSupported({ hasCredentials: false, hasPublicKeyCredential: false }));

  console.log("\n-- reasonMessage / passkeyErrorMessage: honest copy, no em dash --");
  {
    ok("unknown_credential names an unregistered passkey", /not registered/i.test(reasonMessage("unknown_credential", "login")));
    ok("already_registered names a re-registration", /already registered/i.test(reasonMessage("already_registered", "register")));
    ok("challenge names an expiry", /expired/i.test(reasonMessage("challenge", "login")));
    ok("origin/rpid names the CONSOLE_ORIGIN mismatch", /CONSOLE_ORIGIN/.test(reasonMessage("origin", "login")));
    ok("an unrecognised reason maps to a calm generic line", /try again/i.test(reasonMessage("totally-new-reason", "login")));
    // forbidden is the engine's coarse refusal of an UNPROVEN enrolment (no admin-token bootstrap proof,
    // an invalid invite, or not the caller's own email). The register copy must name the real ways
    // forward (the admin token on the connect screen; an Owner's invite), never a dead "try again".
    // The forbidden copy leads with the REAL remedies (the email set-up link, an
    // invite) and no longer advertises the legacy bearer token; the last-resort
    // token entry lives one level down in the sign-in help view instead.
    ok("forbidden (register) does NOT advertise the admin token", !/admin token/i.test(reasonMessage("forbidden", "register")));
    ok("forbidden (register) leads with the email set-up link", /set-up link/i.test(reasonMessage("forbidden", "register")));
    ok("forbidden (register) names the invite alternative", /invite/i.test(reasonMessage("forbidden", "register")));
    ok("forbidden (register) does NOT say plain try-again-only", !/^Could not set up the passkey\. Please try again\.$/.test(reasonMessage("forbidden", "register")));
    ok("forbidden (login) stays an honest refusal", /refused/i.test(reasonMessage("forbidden", "login")));
    // passkeyErrorMessage DOMException cases.
    const cancelLogin = passkeyErrorMessage(named("NotAllowedError"), "login");
    ok("NotAllowedError reads as cancelled or timed out (login)", /cancelled or timed out/i.test(cancelLogin));
    const cancelReg = passkeyErrorMessage(named("NotAllowedError"), "register");
    ok("NotAllowedError reads as cancelled or timed out (register)", /cancelled or timed out/i.test(cancelReg));
    ok("NotSupportedError names an unsupported authenticator", /cannot create/i.test(passkeyErrorMessage(named("NotSupportedError"), "register")));
    ok("SecurityError names the https/site requirement", /secure \(https\)/i.test(passkeyErrorMessage(named("SecurityError"), "login")));
    ok("InvalidStateError (register) suggests signing in instead", /sign in/i.test(passkeyErrorMessage(named("InvalidStateError"), "register")));
    ok("a plain transport error reads as could-not-reach", /could not reach the engine/i.test(passkeyErrorMessage(new Error("Failed to fetch"), "login")));

    // A BROWSER REFUSAL WITH AN UNENUMERATED NAME MUST NOT READ AS AN UNREACHABLE ENGINE.
    // Every DOMException case above is asserted through `named()`, which builds a plain Error
    // carrying a name, so until now nothing here had ever passed a REAL DOMException through this function
    // and the class of error that actually reaches it in a browser went untested.
    //
    // The live failure: an account over 64 credentials makes register/begin emit an excludeCredentials
    // list Chromium refuses, and it throws DOMException("The `excludeCredentials` attribute exceeds the
    // maximum allowed size (64).") named `RangeError` without consulting an authenticator. `RangeError`
    // matches no named branch, the message carries no HTTP status so classifyError answers `network`, and
    // the console told the operator to check the engine was reachable while the engine was answering 200s.
    // It fired on the break-glass recovery path, AFTER the recovery code had already been consumed.
    const rangeErr = new DOMException("The `excludeCredentials` attribute exceeds the maximum allowed size (64).", "RangeError");
    const rangeReg = passkeyErrorMessage(rangeErr, "register");
    ok("a real DOMException is still an Error (the precondition the name branches rely on)", rangeErr instanceof Error && rangeErr.name === "RangeError");
    ok("an unenumerated DOMException does NOT claim the engine is unreachable (register)", !/could not reach the engine/i.test(rangeReg));
    ok("it names the browser as the refuser instead (register)", /browser refused/i.test(rangeReg));
    ok("and it says plainly that the engine answered (register)", /engine was reached and answered/i.test(rangeReg));
    ok("an unenumerated DOMException does NOT claim the engine is unreachable (login)", !/could not reach the engine/i.test(passkeyErrorMessage(rangeErr, "login")));
    // NEVER RENDER THE DOMException MESSAGE: it can carry the rp id and other deployment detail, so it is
    // logged rather than shown, exactly as the sibling branches do.
    ok("the DOMException's own message is not spliced into the copy", !rangeReg.includes("excludeCredentials"));
    // THE NEGATIVE CONTROL THAT KEEPS THIS FROM BEING A BLANKET REWRITE. A genuine fetch failure throws a
    // TypeError, never a DOMException, and it must KEEP the reachability sentence, which is the one state
    // that sentence was written for. Without this, "no message ever says could-not-reach" would pass.
    ok("a genuine fetch TypeError still reads as could-not-reach (register)", /could not reach the engine/i.test(passkeyErrorMessage(new TypeError("Load failed"), "register")));
    ok("a genuine fetch TypeError still reads as could-not-reach (login)", /could not reach the engine/i.test(passkeyErrorMessage(new TypeError("Failed to fetch"), "login")));
    // And a DOMException whose name IS enumerated must still take its own, better branch rather than the
    // new generic one: the new test is a floor under the unnamed cases, not a ceiling over the named ones.
    ok("a real NotAllowedError DOMException still reads as cancelled or timed out", /cancelled or timed out/i.test(passkeyErrorMessage(new DOMException("cancelled", "NotAllowedError"), "register")));
    ok("a real SecurityError DOMException still names the https requirement", /secure \(https\)/i.test(passkeyErrorMessage(new DOMException("insecure", "SecurityError"), "login")));
    ok("the new browser-refusal copy contains no em dash (house style)", !rangeReg.includes("—") && !passkeyErrorMessage(rangeErr, "login").includes("—"));
    // House style: no em dash anywhere in the copy these produce.
    const allCopy = [
      reasonMessage("unknown_credential", "login"), reasonMessage("already_registered", "register"),
      reasonMessage("challenge", "login"), reasonMessage("origin", "login"), reasonMessage("signature", "login"),
      reasonMessage("clone", "login"), reasonMessage("user_present", "login"), reasonMessage("bad_request", "register"),
      reasonMessage("bad_request", "login"), reasonMessage("x", "login"),
      reasonMessage("forbidden", "register"), reasonMessage("forbidden", "login"),
      cancelLogin, cancelReg, passkeyErrorMessage(named("NotSupportedError"), "register"),
      passkeyErrorMessage(named("SecurityError"), "login"), passkeyErrorMessage(named("AbortError"), "login"),
      passkeyErrorMessage(new Error("boom"), "register"),
    ].join(" ");
    ok("no copy contains an em dash (house style)", !allCopy.includes("—"));
  }
}

// SECTION 2: LOGIN flow (real runLogin with stubs); REQUEST BODIES + success/cancel/unknown.
async function testLoginFlow(fx: PasskeyFixtures): Promise<void> {
  const { userHandle, credId } = fx;
  console.log("\n-- runLogin: success path builds the right begin/finish bodies and boots --");
  {
    const s = freshEngineState();
    const reqChallenge = rnd(32);
    s.loginBeginResult = {
      ok: true,
      challengeId: "login-chal-123",
      publicKey: { challenge: b64urlEncode(reqChallenge), rpId: "engine.test", userVerification: "preferred", allowCredentials: [{ type: "public-key", id: b64urlEncode(credId) }] },
    };
    s.loginFinishResult = { ok: true, email: "you@example.com" };
    // The authenticator returns this assertion; the screen must encode exactly these bytes.
    const clientDataJSON = rnd(80), authenticatorData = rnd(37), signature = rnd(70);
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(clientDataJSON), authenticatorData: toBuf(authenticatorData), signature: toBuf(signature), userHandle: toBuf(userHandle) } } };

    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();

    ok("login/begin called once with the email", s.loginBeginArgs.length === 1 && s.loginBeginArgs[0]!.email === "you@example.com");
    // The decoded request options were handed to navigator.credentials.get with the exact challenge bytes.
    ok("get() received the decoded challenge bytes", wa.lastGetOptions !== null && bytesEq(bufToU8(wa.lastGetOptions.challenge), reqChallenge));
    ok("get() received the decoded allowCredentials id", wa.lastGetOptions !== null && (wa.lastGetOptions.allowCredentials ?? []).length === 1 && bytesEq(bufToU8((wa.lastGetOptions.allowCredentials ?? [])[0]!.id as ArrayBuffer), credId));
    // login/finish carries the begin's challengeId and the b64url-encoded assertion.
    ok("login/finish called once", s.loginFinishArgs.length === 1);
    const ff = s.loginFinishArgs[0]!;
    ok("login/finish carries the begin challengeId", ff.challengeId === "login-chal-123");
    ok("login/finish credential id is base64url(rawId)", ff.credential.id === b64urlEncode(credId));
    ok("login/finish clientDataJSON round-trips", bytesEq(b64urlDecode(ff.credential.response.clientDataJSON), clientDataJSON));
    ok("login/finish authenticatorData round-trips", bytesEq(b64urlDecode(ff.credential.response.authenticatorData), authenticatorData));
    ok("login/finish signature round-trips", bytesEq(b64urlDecode(ff.credential.response.signature), signature));
    ok("login/finish userHandle round-trips", ff.credential.response.userHandle !== undefined && bytesEq(b64urlDecode(ff.credential.response.userHandle), userHandle));
    ok("onSuccess ran on a verified login (the cookie boot path)", cap.successRan);
    ok("busy was toggled on then off", cap.busyHistory.length >= 2 && cap.busyHistory[0] === true && cap.busyHistory[cap.busyHistory.length - 1] === false);
  }

  console.log("\n-- runLogin: usernameless (no email) omits the email on begin --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: true, challengeId: "c2", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    s.loginFinishResult = { ok: true, email: "resident@example.com" };
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: toBuf(userHandle) } } };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "", cap.handles);
    await flushAsync();
    ok("login/begin called with NO email when none supplied", s.loginBeginArgs.length === 1 && s.loginBeginArgs[0]!.email === undefined);
    ok("usernameless login still boots on success", cap.successRan);
  }

  console.log("\n-- runLogin: cancel (get throws NotAllowedError) -> honest status, no finish, no boot --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: true, challengeId: "c3", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "throw", name: "NotAllowedError" };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("login/finish NOT called on a cancel", s.loginFinishArgs.length === 0);
    ok("onSuccess NOT run on a cancel", !cap.successRan);
    ok("an inline status was shown", lastStatusText(cap).length > 0);
    ok("the status reads as cancelled or timed out", /cancelled or timed out/i.test(lastStatusText(cap)));
    ok("busy was reset to false after the cancel", cap.busyHistory[cap.busyHistory.length - 1] === false);
  }

  console.log("\n-- runLogin: get() returns null -> treated as a cancel, no finish, no boot --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: true, challengeId: "c3b", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "null" };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("login/finish NOT called on a null credential", s.loginFinishArgs.length === 0);
    ok("onSuccess NOT run on a null credential", !cap.successRan);
    ok("a null credential reads as cancelled/timed out", /cancelled or timed out/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runLogin: unknown credential (finish ok:false) -> unknown-credential copy, no boot --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: true, challengeId: "c4", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    s.loginFinishResult = { ok: false, reason: "unknown_credential" };
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: null } } };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("login/finish WAS called (the assertion was produced)", s.loginFinishArgs.length === 1);
    ok("onSuccess NOT run on an unknown credential", !cap.successRan);
    ok("the status is the unknown-credential copy", /not registered/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runLogin: begin fails (ok:false) -> no get(), no finish, honest status --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: false, reason: "challenge" };
    wa.lastGetOptions = null;
    wa.nextGet = { kind: "throw", name: "ShouldNotBeCalled" };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("get() NOT called when begin failed", wa.lastGetOptions === null);
    ok("login/finish NOT called when begin failed", s.loginFinishArgs.length === 0);
    ok("onSuccess NOT run when begin failed", !cap.successRan);
    ok("the begin reason copy is shown", /expired/i.test(lastStatusText(cap)));
  }
}

// SECTION 2b: STEP-UP re-auth flow (real runStepUp with stubs); ASVS V7.5.1.
// The step-up ceremony is wired to the gated sensitive routes: a fresh passkey assertion mints a
// single-use step-up token the transport replays on the retry. These vectors pin the success path (the
// token is returned), the begin-failure path (null), the cancel/no-passkey path (null), and the wire body
// (the finish carries the begin's challengeId and the b64url-encoded assertion).
async function testStepUpFlow(fx: PasskeyFixtures): Promise<void> {
  const { userHandle, credId } = fx;
  console.log("\n-- runStepUp: success path returns the single-use token and carries the begin challengeId --");
  {
    const s = freshEngineState();
    const reqChallenge = rnd(32);
    s.stepUpBeginResult = {
      ok: true,
      challengeId: "stepup-chal-7",
      publicKey: { challenge: b64urlEncode(reqChallenge), rpId: "engine.test", userVerification: "preferred", allowCredentials: [{ type: "public-key", id: b64urlEncode(credId) }] },
    };
    s.stepUpFinishResult = { ok: true, stepUpToken: "stk-abc123" };
    const clientDataJSON = rnd(80), authenticatorData = rnd(37), signature = rnd(70);
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(clientDataJSON), authenticatorData: toBuf(authenticatorData), signature: toBuf(signature), userHandle: toBuf(userHandle) } } };

    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();

    ok("stepup/begin called once", s.stepUpBeginCalls === 1);
    ok("get() received the decoded step-up challenge bytes", wa.lastGetOptions !== null && bytesEq(bufToU8(wa.lastGetOptions.challenge), reqChallenge));
    ok("stepup/finish called once", s.stepUpFinishArgs.length === 1);
    const sf = s.stepUpFinishArgs[0]!;
    ok("stepup/finish carries the begin challengeId", sf.challengeId === "stepup-chal-7");
    ok("stepup/finish credential id is base64url(rawId)", sf.credential.id === b64urlEncode(credId));
    ok("stepup/finish clientDataJSON round-trips", bytesEq(b64urlDecode(sf.credential.response.clientDataJSON), clientDataJSON));
    ok("stepup/finish signature round-trips", bytesEq(b64urlDecode(sf.credential.response.signature), signature));
    ok("the single-use step-up token is returned on success", token === "stk-abc123");
  }

  console.log("\n-- runStepUp: begin ok:false -> no get(), no finish, returns null --");
  {
    const s = freshEngineState();
    s.stepUpBeginResult = { ok: false, reason: "challenge" };
    wa.lastGetOptions = null;
    wa.nextGet = { kind: "throw", name: "ShouldNotBeCalled" };
    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();
    ok("get() NOT called when stepup/begin failed", wa.lastGetOptions === null);
    ok("stepup/finish NOT called when begin failed", s.stepUpFinishArgs.length === 0);
    ok("runStepUp returns null on a begin failure", token === null);
  }

  console.log("\n-- runStepUp: cancel (get throws NotAllowedError) -> no finish, returns null --");
  {
    const s = freshEngineState();
    s.stepUpBeginResult = { ok: true, challengeId: "stepup-c2", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "throw", name: "NotAllowedError" };
    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();
    ok("stepup/finish NOT called on a cancel", s.stepUpFinishArgs.length === 0);
    ok("runStepUp returns null on a cancel / no-passkey", token === null);
  }

  console.log("\n-- runStepUp: get() returns null -> treated as a cancel, no finish, returns null --");
  {
    const s = freshEngineState();
    s.stepUpBeginResult = { ok: true, challengeId: "stepup-c3", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "null" };
    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();
    ok("stepup/finish NOT called on a null credential", s.stepUpFinishArgs.length === 0);
    ok("runStepUp returns null on a null credential", token === null);
  }

  console.log("\n-- runStepUp: the ceremony ANNOUNCES itself before the browser sheet opens --");
  {
    // The defect this pins. Its two siblings set a status node and a busy label before touching
    // navigator.credentials; this one did neither, so the passkey sheet appeared with nothing in front of it,
    // in the middle of an action the operator had already confirmed. bodyTextAtGet is read INSIDE the
    // WebAuthn stub, so it can only pass if the announcement was on screen when the sheet opened.
    const s = freshEngineState();
    s.stepUpBeginResult = { ok: true, challengeId: "stepup-c5", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    s.stepUpFinishResult = { ok: true, stepUpToken: "stk-announced" };
    wa.bodyTextAtGet = "";
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: null } } };
    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();
    ok("the passkey prompt was announced BEFORE the sheet opened", wa.bodyTextAtGet.includes("Confirm with your passkey to continue"));
    ok("and the announcement is gone once the ceremony ends", !bodyText().includes("Confirm with your passkey to continue"));
    ok("the success path is unchanged by the announcement", token === "stk-announced");
  }

  console.log("\n-- runStepUpOutcome: the three outcomes are DISTINGUISHABLE, and the fourth is merged on purpose --");
  {
    // Returning a bare null made a refused begin, a dismissed prompt, a device with no passkey and a rejected
    // finish one indistinguishable answer, which is why the copy downstream had to cover all of them at once.
    const begin = freshEngineState();
    begin.stepUpBeginResult = { ok: false, reason: "challenge" };
    wa.nextGet = { kind: "throw", name: "ShouldNotBeCalled" };
    const beginOutcome = await runStepUpOutcome(makeEngineStub(begin));
    ok("a refused begin reports begin-refused", !beginOutcome.ok && beginOutcome.reason === "begin-refused");

    const cancelled = freshEngineState();
    cancelled.stepUpBeginResult = { ok: true, challengeId: "stepup-c6", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "throw", name: "NotAllowedError" };
    const cancelledOutcome = await runStepUpOutcome(makeEngineStub(cancelled));
    ok("a dismissed prompt reports no-assertion", !cancelledOutcome.ok && cancelledOutcome.reason === "no-assertion");

    // THE DELIBERATE MERGE, asserted rather than left implicit. WebAuthn answers a dismissed prompt and a
    // device with no matching credential with the SAME NotAllowedError, on purpose, so that no site can
    // enumerate whether a passkey exists. A null credential is the same state by another route. Splitting
    // them here would be guessing, so they are one reason and the copy covers both.
    const nullCred = freshEngineState();
    nullCred.stepUpBeginResult = { ok: true, challengeId: "stepup-c7", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    wa.nextGet = { kind: "null" };
    const nullOutcome = await runStepUpOutcome(makeEngineStub(nullCred));
    ok("a null credential reports the SAME reason as a cancel, merged deliberately", !nullOutcome.ok && nullOutcome.reason === "no-assertion");

    const refused = freshEngineState();
    refused.stepUpBeginResult = { ok: true, challengeId: "stepup-c8", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    refused.stepUpFinishResult = { ok: false, reason: "unknown_credential" };
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: null } } };
    const refusedOutcome = await runStepUpOutcome(makeEngineStub(refused));
    ok("a refused finish reports finish-refused", !refusedOutcome.ok && refusedOutcome.reason === "finish-refused");

    // Three reasons, three sentences, and every one of them says the action did not happen. The engine's
    // check runs before it dispatches, so whatever went wrong, nothing was written.
    const messages = (["begin-refused", "no-assertion", "finish-refused"] as const).map((r) => stepUpFailureMessage(r));
    ok("each outcome has its OWN sentence", new Set(messages).size === 3);
    ok("and every one of them says nothing was changed", messages.every((m) => /nothing was changed/i.test(m)));
    ok("none of them reads as a lapsed session", messages.every((m) => /session is still active/i.test(m)));
  }

  console.log("\n-- the failure reason reaches the copy, and is CONSUMED so it cannot outlive its failure --");
  {
    // The reason cannot ride in the error: gatedFetch surfaces the ORIGINAL 401 when the ceremony hands back
    // no token, so there is nowhere in it to put one. It rides in a single slot that the reader consumes.
    noteStepUpFailure("finish-refused");
    const first = errorDetail(new Error(`approve: ${STEPUP_REQUIRED_MARKER}: 401`));
    ok("a step-up 401 renders the RECORDED reason's copy", first === stepUpFailureMessage("finish-refused"));
    const second = errorDetail(new Error(`approve: ${STEPUP_REQUIRED_MARKER}: 401`));
    ok("a second read gets the general advice, not the spent reason", second !== first && /approve the passkey prompt when it appears/i.test(second));
    // The no-record state is REAL rather than a gap: a token or Access session never runs a ceremony at all.
    ok("with no ceremony recorded the general advice stands", /still active/i.test(second));
  }

  console.log("\n-- runStepUp: finish ok:false -> returns null (no token minted) --");
  {
    const s = freshEngineState();
    s.stepUpBeginResult = { ok: true, challengeId: "stepup-c4", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    s.stepUpFinishResult = { ok: false, reason: "unknown_credential" };
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: null } } };
    const token = await runStepUp(makeEngineStub(s));
    await flushAsync();
    ok("stepup/finish WAS called (the assertion was produced)", s.stepUpFinishArgs.length === 1);
    ok("runStepUp returns null when the finish refuses", token === null);
  }
}

// SECTION 3: REGISTER flow (real runRegister with stubs).
async function testRegisterFlow(fx: PasskeyFixtures): Promise<void> {
  const { userHandle, credId } = fx;
  console.log("\n-- runRegister: success + first-registrant bootstrap -> Owner note + boot --");
  {
    const s = freshEngineState();
    const regChallenge = rnd(32);
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:you@example.com",
      publicKey: {
        rp: { id: "engine.test", name: "Downpipes" },
        user: { id: b64urlEncode(userHandle), name: "you@example.com", displayName: "you@example.com" },
        challenge: b64urlEncode(regChallenge),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
        timeout: 120000, attestation: "none", excludeCredentials: [],
      },
    };
    s.registerFinishResult = { ok: true, email: "you@example.com", bootstrapped: true, role: "owner" };
    const clientDataJSON = rnd(80), attestationObject = rnd(220);
    wa.nextCreate = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(clientDataJSON), attestationObject: toBuf(attestationObject), getTransports: () => ["internal"] } } };

    const cap = makeHandles();
    await runRegister(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();

    ok("register/begin called once with the email", s.registerBeginArgs.length === 1 && s.registerBeginArgs[0]!.email === "you@example.com");
    ok("create() received the decoded challenge bytes", wa.lastCreateOptions !== null && bytesEq(bufToU8(wa.lastCreateOptions.challenge), regChallenge));
    ok("create() received the decoded user.id handle", wa.lastCreateOptions !== null && bytesEq(bufToU8(wa.lastCreateOptions.user.id), userHandle));
    ok("register/finish called once with the email", s.registerFinishArgs.length === 1 && s.registerFinishArgs[0]!.email === "you@example.com");
    const rf = s.registerFinishArgs[0]!;
    ok("register/finish credential id is base64url(rawId)", rf.credential.id === b64urlEncode(credId));
    ok("register/finish clientDataJSON round-trips", bytesEq(b64urlDecode(rf.credential.response.clientDataJSON), clientDataJSON));
    ok("register/finish attestationObject round-trips", bytesEq(b64urlDecode(rf.credential.response.attestationObject), attestationObject));
    ok("onSuccess ran on a verified registration", cap.successRan);
    ok("the bootstrap-Owner note is surfaced", /Owner/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runRegister: a non-bootstrap success boots without the Owner note --");
  {
    const s = freshEngineState();
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:second@example.com",
      publicKey: { rp: { id: "engine.test", name: "Downpipes" }, user: { id: b64urlEncode(userHandle), name: "second@example.com", displayName: "second@example.com" }, challenge: b64urlEncode(rnd(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] },
    };
    s.registerFinishResult = { ok: true, email: "second@example.com", bootstrapped: false, role: "viewer" };
    wa.nextCreate = { kind: "credential", cred: { rawId: toBuf(rnd(48)), response: { clientDataJSON: toBuf(rnd(80)), attestationObject: toBuf(rnd(200)) } } };
    const cap = makeHandles();
    await runRegister(makeEngineStub(s), "second@example.com", cap.handles);
    await flushAsync();
    ok("a non-bootstrap registration still boots", cap.successRan);
    ok("the status does not claim Owner for a non-bootstrap registrant", !/Owner/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runRegister: already-registered (finish ok:false) -> honest copy, no boot --");
  {
    const s = freshEngineState();
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:you@example.com",
      publicKey: { rp: { id: "engine.test", name: "Downpipes" }, user: { id: b64urlEncode(userHandle), name: "you@example.com", displayName: "you@example.com" }, challenge: b64urlEncode(rnd(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] },
    };
    s.registerFinishResult = { ok: false, reason: "already_registered" };
    wa.nextCreate = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), attestationObject: toBuf(rnd(200)) } } };
    const cap = makeHandles();
    await runRegister(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("onSuccess NOT run when already registered", !cap.successRan);
    ok("the already-registered copy is shown", /already registered/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runRegister: cancel (create throws NotAllowedError) -> honest status, no finish, no boot --");
  {
    const s = freshEngineState();
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:you@example.com",
      publicKey: { rp: { id: "engine.test", name: "Downpipes" }, user: { id: b64urlEncode(userHandle), name: "you@example.com", displayName: "you@example.com" }, challenge: b64urlEncode(rnd(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] },
    };
    wa.nextCreate = { kind: "throw", name: "NotAllowedError" };
    const cap = makeHandles();
    await runRegister(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    ok("register/finish NOT called on a cancel", s.registerFinishArgs.length === 0);
    ok("onSuccess NOT run on a register cancel", !cap.successRan);
    ok("the cancel copy is shown", /cancelled or timed out/i.test(lastStatusText(cap)));
  }

  console.log("\n-- runRegister: forbidden (begin ok:false) -> bootstrap guidance + connect affordance, no ceremony, no boot --");
  {
    // The engine refuses an UNPROVEN enrolment with a coarse forbidden: most commonly the first-Owner
    // bootstrap attempted without the admin token (the engine's registration gate accepts only an
    // ADMIN_TOKEN bearer on an empty role table). The flow must surface the honest guidance WITH the
    // connect-screen affordance, never the dead generic retry, and must not reach the create() ceremony
    // or the finish POST.
    const s = freshEngineState();
    s.registerBeginResult = { ok: false, reason: "forbidden" };
    const cap = makeHandles();
    await runRegister(makeEngineStub(s), "first@example.com", cap.handles);
    await flushAsync();
    ok("register/finish NOT called on a forbidden begin", s.registerFinishArgs.length === 0);
    ok("onSuccess NOT run on a forbidden begin", !cap.successRan);
    ok("the forbidden copy leads with the email set-up link, not the token", /set-up link/i.test(lastStatusText(cap)) && !/admin token/i.test(lastStatusText(cap)));
    const statusNode = [...cap.statuses].reverse().find((n) => n !== null) ?? null;
    ok(
      "no connect-with-token affordance rides the banner (the last resort lives in the help view)",
      statusNode !== null && statusNode.findButtonByText("Connect with the admin token") === null,
    );
  }

  console.log("\n-- runBootstrapSend: the first-run email-the-owner link (no oracle) --");
  {
    // Success: one POST, the honestly-conditional copy ("if this engine has no Owner yet..."), no boot.
    const s = freshEngineState();
    const cap = makeHandles();
    await runBootstrapSend(makeEngineStub(s), cap.handles);
    await flushAsync();
    ok("bootstrap send POSTs exactly once", s.bootstrapSendCalls === 1);
    ok("onSuccess NOT run (sending a link signs nobody in)", !cap.successRan);
    ok("the copy is honestly conditional about the engine's state", /if this engine has no owner yet/i.test(lastStatusText(cap)) && /nothing is sent once an owner exists/i.test(lastStatusText(cap)));
    // NEW CONTRACT (bootstrap-banner-repeats-env-var + email-service-troubleshoot-eager): the help
    // section beside the button owns the where-it-goes / one-use / 24-hour facts, so the post-send
    // banner no longer restates them and never names the env var; the Email Service troubleshooting
    // moved INTO this post-send banner (failure prose belongs after the press, not beside an
    // unpressed button).
    ok("the banner names no env-var internals (BOOTSTRAP_OWNER_EMAIL)", !/BOOTSTRAP_OWNER_EMAIL/.test(lastStatusText(cap)));
    ok("the post-send banner carries the Email Service troubleshooting", /email service/i.test(lastStatusText(cap)));
    ok("busy was set and cleared around the send", cap.busyHistory[0] === true && cap.busyHistory[cap.busyHistory.length - 1] === false);
  }
  {
    // Transport fault: the one distinguishable failure maps through the honest could-not-reach copy.
    const s = freshEngineState();
    s.bootstrapSendThrows = new Error("Failed to fetch");
    const cap = makeHandles();
    await runBootstrapSend(makeEngineStub(s), cap.handles);
    await flushAsync();
    ok("a transport fault reads as could-not-reach", /could not reach the engine/i.test(lastStatusText(cap)));
    ok("onSuccess NOT run on a transport fault", !cap.successRan);
  }

  // -------------------------------------------------------------------------------------------------
  // The post-send banner, held against the ENGINE'S OWN GATES rather than against itself.
  //
  // WHY. The engine's `emailConfigured` (router-destinations.ts) reads only EMAIL_FROM and asks only
  // whether it contains "@". EMAIL_FROM ships as a committed default in wrangler.toml, and so does the
  // send_email binding, so the flag is TRUE on a fresh deployment with no operator action, on a domain
  // the customer does not own. Meanwhile the send's FIRST gate is the owner address
  // (router-auth-flow.ts, skip "owner-email-not-configured"), a per-deployment secret that is
  // deliberately never committed, and the flag does not look at it at all. So a first-run customer is
  // told email is configured, presses the button, and nothing arrives.
  //
  // The console cannot fix that flag and must not gate on it. What it CAN do is refuse to be
  // confidently wrong: name every prerequisite, say it cannot check them, and keep the route that needs
  // none of them beside the uncertainty. These assertions hold that copy to the engine's real gate list,
  // so a gate added or renamed over there forces this copy to be re-read rather than quietly going stale
  // the way the single-cause version did.
  // -------------------------------------------------------------------------------------------------
  console.log("\n-- the bootstrap banner, checked against the engine's own gate list --");
  {
    const p = engineRoots(HERE).map((r) => resolve(r, "src/admin/router-auth-flow.ts")).find((f) => existsSync(f));
    if (p === undefined) {
      // CANNOT CHECK rather than SKIP. On a console-only clone the rest of this file is a real run and the
      // exit code stays 0; the line says which half did not happen.
      //
      // THE REQUIRE ARM WAS WRONG IN TWO WAYS, and both are the same mistake. It was unreachable, because
      // until this file joined validate:workspace:chain nothing ran it with REQUIRE_ENGINE set. And it
      // recorded a FAILED ASSERTION, which puts "the console is wrong" in the log and exits 1 when the
      // truth is that no comparison took place. A could-not-check is exit 2, and it must not be counted as
      // a failing assertion or the failure total stops meaning what it says.
      console.log("CANNOT CHECK the engine-derived bootstrap-gate comparison: no engine checkout reachable");
      if (process.env.REQUIRE_ENGINE === "1") {
        console.error("validate-passkey-login: REFUSED, REQUIRE_ENGINE=1 and no engine checkout is reachable.\n" +
            "  The bootstrap banner is held to the engine's own list of skip reasons in router-auth-flow.ts,\n" +
            "  so with no engine that comparison cannot run and will not report that it did.\n" +
            "  Point it at one with DOWNPIPES_ENGINE=/path/to/engine and re-run.",); process.exit(2);
      }
    } else {
      const src = readFileSync(p, "utf8");
      const start = src.indexOf("sendBootstrapLink");
      const region = start === -1 ? "" : src.slice(start);
      const skips = new Set([...region.matchAll(/return skip\("([a-z-]+)"\)/g)].map((m) => m[1] as string));
      ok("the engine's bootstrap route still declares its skip reasons", skips.size >= 5);
      // The CONFIGURATION-class gates: the ones a deployer can get wrong and the banner must speak to.
      // Pinned as a set, so a new one fails here and the copy gets re-read. Deliberately not a count.
      const configGates = ["owner-email-not-configured", "email-not-configured", "from-not-configured"];
      for (const g of configGates) ok(`the engine still gates on ${g}`, skips.has(g));
      const unexpected = [...skips].filter((s) => !configGates.includes(s) && !["console-origin-unset", "origin-mismatch", "mint-failed", "not-available"].includes(s));
      ok("the engine has added no bootstrap gate this copy has not been reviewed against", unexpected.length === 0);
      if (unexpected.length > 0) console.log(`       new engine skip reason(s): ${unexpected.join(", ")}. Re-read the post-send banner in src/screens/passkey/flows.ts.`);

      // The banner must speak to each configuration gate, in plain words rather than by env-var name.
      const s2 = freshEngineState();
      const cap2 = makeHandles();
      await runBootstrapSend(makeEngineStub(s2), cap2.handles);
      await flushAsync();
      const banner = lastStatusText(cap2);
      ok("the banner speaks to the owner address (owner-email-not-configured)", /owner address pinned at deployment/i.test(banner));
      ok("the banner speaks to the sender address (from-not-configured)", /sender address on a domain/i.test(banner));
      ok("the banner speaks to the send binding (email-not-configured)", /email service/i.test(banner));
      // The specific trap that made emailConfigured a lie: the sender ships as a default the customer
      // does not own, so it must be flagged as worth checking even when Email Service is on.
      ok("the banner flags the shipped default sender as worth checking", /ships the sender address as a default on a domain you do not own/i.test(banner));
      ok("the banner does not claim this screen can check any of it", /cannot check any of it/i.test(banner));
      ok("the working route stays beside the uncertainty", /admin-token sign-in/i.test(banner));
      ok("the banner still names no env-var internals", !/BOOTSTRAP_OWNER_EMAIL|EMAIL_FROM|INVITE_EMAIL_FROM/.test(banner));
    }
  }

  // -------------------------------------------------------------------------------------------------
  // emailConfigured must never gate a control. It is the flag described above: true out of the box on a
  // domain the customer cannot send from, and blind to the gate that actually fails first. Hiding the
  // button on it would be worse than showing it, because it would hide the first-run route from exactly
  // the deployments where it works while leaving it visible on ones where it does not. The console
  // therefore does not read it at all, and this assertion keeps that true.
  // -------------------------------------------------------------------------------------------------
  console.log("\n-- emailConfigured is not permitted to gate console behaviour --");
  {
    // Read with node rather than grep: a NUL byte anywhere in a scanned file makes grep report a silent
    // clean, which cost this repo a real false negative.
    const srcDir = resolve(HERE, "../src");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const f = join(d, n);
        return statSync(f).isDirectory() ? walk(f) : [f];
      });
    const users: string[] = [];
    for (const f of walk(srcDir)) {
      if (!f.endsWith(".ts")) continue;
      // The demo seed builds a fake setup-state payload; it is a fixture, not a consumer.
      if (f.includes("/lib/demo/")) continue;
      for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
        if (!line.includes("emailConfigured")) continue;
        // A type declaration and a comment are not a gate; a read of the value is.
        const stripped = line.replace(/\/\/.*$/, "").trim();
        if (stripped === "" || /^emailConfigured\??:\s*boolean;?$/.test(stripped)) continue;
        users.push(`${f.slice(srcDir.length + 1)}:${i + 1}: ${stripped}`);
      }
    }
    ok("no console source branches on emailConfigured", users.length === 0);
    for (const u of users) console.log(`       ${u}`);
  }
}

// SECTION 3b: INVITE acceptance (/register?invite=TOKEN drives REGISTER + threads the token).
// The real end-to-end break this closes: an invited teammate lands on /register?invite=<token>; the
// screen must FORCE the register (set-up) flow and thread the single-use, email-bound passkeyInvite token
// to BOTH register/begin and register/finish so the engine binds the new credential to the invited email.
async function testInviteFlow(fx: PasskeyFixtures): Promise<void> {
  const { userHandle, credId } = fx;
  console.log("\n-- runRegister(inviteToken): the token is sent in BOTH the begin and the finish body --");
  {
    const s = freshEngineState();
    const regChallenge = rnd(32);
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:invited@example.com",
      publicKey: {
        rp: { id: "engine.test", name: "Downpipes" },
        user: { id: b64urlEncode(userHandle), name: "invited@example.com", displayName: "invited@example.com" },
        challenge: b64urlEncode(regChallenge),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
        timeout: 120000, attestation: "none", excludeCredentials: [],
      },
    };
    s.registerFinishResult = { ok: true, email: "invited@example.com", bootstrapped: false, role: "viewer" };
    wa.nextCreate = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), attestationObject: toBuf(rnd(220)), getTransports: () => ["internal"] } } };

    const INVITE = "passkeyInvite-abc123";
    const cap = makeHandles();
    // This is the exact call the screen's set-up button makes on an invite: runRegister(engine, email,
    // handles, inviteToken). Driving it here proves the token reaches BOTH engine calls.
    await runRegister(makeEngineStub(s), "invited@example.com", cap.handles, INVITE);
    await flushAsync();

    ok("register/begin called once", s.registerBeginArgs.length === 1);
    ok("the invite token is sent in the register/BEGIN body", s.registerBeginArgs[0]!.inviteToken === INVITE);
    ok("register/finish called once", s.registerFinishArgs.length === 1);
    ok("the invite token is sent in the register/FINISH body", s.registerFinishArgs[0]!.inviteToken === INVITE);
    ok("the invited registration boots on a verified finish", cap.successRan);
  }

  console.log("\n-- passkeyScreen.render(/register?invite=...): FORCES the set-up flow as the primary action --");
  {
    installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
    connect("https://engine.test");
    // The invite link the engine emails: ${CONSOLE_ORIGIN}/#/register?invite=<token>. The router resolves
    // it to the /register route (owned by this same screen); here we drive the screen with that match.
    const match: RouteMatch = { pattern: "/register", params: {}, query: new URLSearchParams("invite=passkeyInvite-abc123"), path: "/register" };
    // `as never` on the match, which is this repo's idiom at the other screen-render call sites. The
    // Screen interface types render's parameter as ScreenContext, but passkey.ts's implementation
    // declares `render(match: RouteMatch)` and reads nothing else, so a RouteMatch is exactly what it
    // wants and the cast is provable rather than a silencing.
    const node = passkeyScreen.render(match as never) as unknown as ShimNode;

    // Both controls still exist, but the screen FORCES set-up: the heading + copy are enrolment-framed and
    // the "Set up a passkey" control is the PRIMARY button (btn--primary), not "Sign in".
    const setupBtn = node.findButtonByText("Set up a passkey");
    const loginBtn = node.findButtonByText("Sign in with a passkey");
    ok("the set-up control is present on the invite screen", setupBtn !== null);
    ok("the sign-in control is still present (the quiet alternative)", loginBtn !== null);
    ok("the heading is enrolment-framed (Set up your passkey)", node.textIncludes("Set up your passkey"));
    // The /register landing serves BOTH arrivals from the same engine-minted link
    // (a teammate's role-grant invite AND the first-Owner bootstrap email), so the
    // copy is neutral about which: it names the passkey set-up and the
    // first-passkey-makes-you-Owner consequence rather than asserting "invited".
    ok("the copy frames the link as passkey set-up for the email it was sent to", node.textIncludes("sets up your passkey") && node.textIncludes("email it was sent to"));
    ok("the SET-UP control is the primary action on an invite (btn--primary)", (setupBtn?.className.includes("btn--primary") ?? false));
    // One primary action per state (the calm sign-in contract): the alternative is a
    // QUIET ghost link, never a competing second button.
    const loginBtnClasses = loginBtn?.className ?? "";
    ok(
      "the SIGN-IN control is demoted to a quiet ghost link on an invite",
      loginBtnClasses.includes("btn--ghost") && !loginBtnClasses.includes("btn--primary"),
    );
    // An email field is present (the invited teammate enters the email the invite was sent to).
    ok("an email field is present on the invite screen", node.querySelectorAll("input").length >= 1);
  }

  console.log("\n-- passkeyScreen.render(/register), a bare arrival (the admin-token sign-in landing): offers a way to a second Owner --");
  {
    // The admin-token block (renderAdminTokenBlock, flows.ts) connects the client and navigates
    // straight to /register with no invite token and no recovery-flow prefill, so this is exactly
    // that landing. It never calls whoami first (that is the defect this control fixes), so this
    // screen's own "Invite your team" link is the only way a token session reaches a role grant.
    let navigateTo: string | null = null;
    let refreshCalls = 0;
    installNav({
      navigate: (to) => { navigateTo = to; },
      onUnauthorised: () => {},
      refreshIdentity: async () => { refreshCalls += 1; },
      onAuthenticated: async () => {},
      signOut: () => {},
    });
    connect("https://engine.test");
    const match: RouteMatch = { pattern: "/register", params: {}, query: new URLSearchParams(""), path: "/register" };
    const node = passkeyScreen.render(match as never) as unknown as ShimNode;

    const inviteOwnerBtn = node.findButtonByText("Invite your team");
    ok("a bare /register arrival offers the Invite your team control", inviteOwnerBtn !== null);
    ok("it names the admin-token session it is for", node.textIncludes("Signed in with the admin token?"));
    ok("it states what the grant achieves (a second Owner, so the token can be retired)", node.textIncludes("a second Owner exists before you retire the token"));
    // The invite link is ABSENT from the invite-screen and cold-registerLead cases above by
    // construction (this whole block sits inside the "no invite, no prefill" branch); confirm the
    // one exercised here is the same control and that clicking it does what the copy promises:
    // resolve identity first, then take the operator to the onboarding invite step.
    inviteOwnerBtn!.click();
    ok("clicking it resolves identity first (refreshIdentity), so the token's Owner authority is recognised before the invite form's roles.write gate reads it", refreshCalls === 1);
    ok("clicking it navigates to the onboarding invite step (Invite your team)", navigateTo === "/onboarding/invite");
  }

  console.log("\n-- a plain /passkey LOGIN sends NO inviteToken (the self-add / sign-in paths are unchanged) --");
  {
    const s = freshEngineState();
    s.loginBeginResult = { ok: true, challengeId: "no-invite-1", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    s.loginFinishResult = { ok: true, email: "you@example.com" };
    wa.nextGet = { kind: "credential", cred: { rawId: toBuf(credId), response: { clientDataJSON: toBuf(rnd(80)), authenticatorData: toBuf(rnd(37)), signature: toBuf(rnd(70)), userHandle: toBuf(userHandle) } } };
    const cap = makeHandles();
    await runLogin(makeEngineStub(s), "you@example.com", cap.handles);
    await flushAsync();
    // Login never touches the register endpoints, so an inviteToken can never ride a plain sign-in: assert
    // neither register call was made at all (the only place inviteToken is carried).
    ok("login boots on a verified sign-in", cap.successRan);
    ok("a plain login makes NO register/begin call (so no inviteToken)", s.registerBeginArgs.length === 0);
    ok("a plain login makes NO register/finish call (so no inviteToken)", s.registerFinishArgs.length === 0);
  }

  console.log("\n-- a plain /passkey REGISTER (no invite) sends NO inviteToken (self-add body unchanged) --");
  {
    const s = freshEngineState();
    s.registerBeginResult = {
      ok: true, challengeScope: "reg:self@example.com",
      publicKey: { rp: { id: "engine.test", name: "Downpipes" }, user: { id: b64urlEncode(userHandle), name: "self@example.com", displayName: "self@example.com" }, challenge: b64urlEncode(rnd(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [] },
    };
    s.registerFinishResult = { ok: true, email: "self@example.com", bootstrapped: true, role: "owner" };
    wa.nextCreate = { kind: "credential", cred: { rawId: toBuf(rnd(48)), response: { clientDataJSON: toBuf(rnd(80)), attestationObject: toBuf(rnd(200)) } } };
    const cap = makeHandles();
    // No inviteToken argument: the normal self-add / first-registrant bootstrap path.
    await runRegister(makeEngineStub(s), "self@example.com", cap.handles);
    await flushAsync();
    ok("self-add register/begin carries NO inviteToken", s.registerBeginArgs.length === 1 && s.registerBeginArgs[0]!.inviteToken === undefined);
    ok("self-add register/finish carries NO inviteToken", s.registerFinishArgs.length === 1 && s.registerFinishArgs[0]!.inviteToken === undefined);
  }
}

// SECTION 4: RENDER the unauthenticated-but-reachable state -> the live passkey login.
async function testRender(): Promise<void> {
  console.log("\n-- passkeyScreen.render: unauthenticated-but-reachable shows the live login, not a 401 --");
  {
    // installNav so the navigate()/refreshIdentity()/onAuthenticated() bridges the screen wires are inert
    // no-ops under the test (the flow assertions above drive onSuccess via the captured handles, not the
    // real bridge). onAuthenticated is included so the call satisfies the NavBridge shape.
    installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
    // Connect a (token-free) engine so getEngine() is non-null: the engine is REACHABLE.
    connect("https://engine.test");
    // WebAuthn IS supported (the stub set navigator.credentials + PublicKeyCredential).
    ok("WebAuthn detected as supported under the stub", webauthnSupported({ hasCredentials: true, hasPublicKeyCredential: true }));

    const match: RouteMatch = { pattern: "/passkey", params: {}, query: new URLSearchParams("next=%2Fdownpipes"), path: "/passkey" };
    const node = passkeyScreen.render(match as never) as unknown as ShimNode;

    ok("the screen renders a Sign in with a passkey control", node.findButtonByText("Sign in with a passkey") !== null);
    // NEW CONTRACT (signin-footer-standing-reassurance): the standing footer naming Cloudflare
    // Access, the admin token and the challenge mechanics is gone from view one (the sign-in view
    // carries the primary passkey button and nothing else to weigh up); the alternatives line lives
    // in the help view, asserted after the trigger below.
    ok("the sign-in view does NOT front-load admin-token jargon", !node.textIncludes("admin token"));
    ok("it is NOT a dead signed-out 401 (no 'not valid or has expired' Access copy)", !node.textIncludes("not valid or has expired"));

    // The two-view contract (the setup-first IA): the sign-in view carries ONE
    // primary decision; everything first-time lives one click away behind the
    // help trigger. Opening it must reveal the separated single-action blocks:
    // new engine (email the owner), lost passkey (recovery code); plus the
    // invited hint line, the add-a-passkey path with its email field and the
    // first-registrant-becomes-Owner note, and the honest alternatives line.
    const helpTrigger = node.findButtonByText("First time here, or need another way in?");
    ok("the sign-in view offers the one help trigger", helpTrigger !== null);
    ok("the sign-in view does NOT front-load the Set-up control", node.findButtonByText("Set up a passkey") === null);
    ok("the sign-in view does NOT front-load the email-the-owner affordance", node.findButtonByText("Email the owner a set-up link") === null);
    helpTrigger!.click();
    // The alternatives framing moved INTO the help view with the other ways in
    // (signin-footer-standing-reassurance): same honesty, one view later.
    ok("help view: states the engine's-own-sign-in framing (not Access-only)", node.textIncludes("engine's own sign-in"));
    ok("help view: names the Access + token alternatives (console works with any of the three)", node.textIncludes("Cloudflare Access") && node.textIncludes("admin token"));
    ok("help view: the first-run email-the-owner affordance appears", node.findButtonByText("Email the owner a set-up link") !== null);
    ok("help view: the recovery-code path appears", node.findButtonByText("Use a recovery code") !== null);
    // The first-time admin-token sign-in is a clear option here (owner direction); there is NO
    // "Set up a passkey" control for a visitor with no account (a passkey is set up only by
    // accepting an invite link or right after an admin-token sign-in).
    ok("help view: the admin-token sign-in appears (the first-time path)", node.findButtonByText("Sign in with the admin token") !== null);
    ok("help view: no 'Set up a passkey' control for a no-account visitor", node.findButtonByText("Set up a passkey") === null);
    ok("help view: the become-a-named-Owner note appears", node.textIncludes("Owner"));
    ok("help view: the admin-token input is present", node.querySelectorAll("input").length >= 1);
    ok("help view: a way back to the sign-in view exists", node.findButtonByText("Back to sign in") !== null);
  }

  console.log("\n-- passkeyScreen.render: WebAuthn UNSUPPORTED shows an honest notice, no ceremony buttons --");
  {
    // Remove PublicKeyCredential so the screen's feature-detect reports unsupported.
    const g = globalThis as unknown as Record<string, unknown>;
    const savedPKC = g.PublicKeyCredential;
    delete g.PublicKeyCredential;
    connect("https://engine.test");
    const match: RouteMatch = { pattern: "/passkey", params: {}, query: new URLSearchParams(""), path: "/passkey" };
    const node = passkeyScreen.render(match as never) as unknown as ShimNode;
    ok("no Sign-in button is shown when WebAuthn is unsupported", node.findButtonByText("Sign in with a passkey") === null);
    ok("no Set-up button is shown when WebAuthn is unsupported", node.findButtonByText("Set up a passkey") === null);
    ok("an honest no-passkey-support notice is shown", node.textIncludes("does not support passkeys"));
    ok("the unsupported notice names the Access/token fallback", node.textIncludes("Cloudflare Access") || node.textIncludes("admin token"));
    // restore for any later use
    g.PublicKeyCredential = savedPKC;
  }
}

// SECTION 7: AN ANSWER MUST NOT READ AS AN UNREACHABLE ENGINE.
//
// passkeyErrorMessage and recoveryTransportMessage used to send every non-DOMException to "Could not reach
// the engine", which is the one sentence an operator acts on by going to look at the network, the tunnel and
// DNS. The engine client folds the answered status into its throw, so the console was holding the proof that
// the engine had answered and discarding it. Same class as the malformed-2xx correction in errors.ts.
//
// THE ERROR SHAPES ARE NOT HAND-MADE. Every case below is produced by driving the REAL client-passkey call
// over the REAL Transport against a stubbed fetch, so the thrown message is composed by client-transport.ts
// failResponse/parseJson exactly as it is in a browser. A test that fabricates `new Error("...: 500")` is
// asserting against its own idea of the throw and would keep passing if the transport changed its shape.
//
// THE STATUSES ARE NOT INVENTED EITHER. They are what the engine and the console's own worker actually
// answer on /admin/auth/*: engine/src/admin/router-auth-flow.ts 501s EVERY ceremony when CONSOLE_ORIGIN is
// unset, rate-limits the unauthenticated sign-in routes per IP, 404s an unknown sub-path, and lets the
// last-resort handler 500; the console worker stamps its own binding-absent 503.
//
// AND THE KNOWN POSITIVE IS THE POINT OF THE SECTION. A repair that made everything read as an answer would
// be worse than the defect, so the last case is a fetch that genuinely threw and it MUST still read as
// unreachable, in both functions.
async function testAnsweredIsNotUnreachable(): Promise<void> {
  console.log("\n-- an engine that ANSWERED must not be reported as unreachable --");
  const g = globalThis as unknown as { fetch: unknown };
  const savedFetch = g.fetch;
  const savedError = console.error;
  // Transport's constructor is (base: string, token?: string). This used to be handed an object literal
  // { base, headers }, which type-checked nowhere and did two silently wrong things at runtime: this.base
  // became the object, so every URL the transport built read "[object Object]/admin/auth/...", and the
  // literal's `headers` was dead because headers() is a method on the class and an own property of the
  // ARGUMENT is never consulted. Neither showed up because the fetch below is stubbed and ignores its URL.
  const t = new Transport("https://engine.test");
  // thrownFor drives the real login/begin over a stubbed fetch and hands back what the transport threw.
  // console.error is silenced only for the duration: both functions deliberately log the raw error for the
  // operator, and that logging is not what is under test here.
  const thrownFor = async (respond: () => Response): Promise<unknown> => {
    g.fetch = async () => respond();
    console.error = () => {};
    try {
      await passkeyLoginBegin(t, "you@example.com");
      return null;
    } catch (e) {
      return e;
    } finally {
      console.error = savedError;
    }
  };
  const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
  const unreachableCopy = /could not reach the engine/i;
  try {
    // Each case: what answered, and the phrase the operator must be given instead of a reachability claim.
    const answered: { label: string; respond: () => Response; expect: RegExp }[] = [
      { label: "501 passkey_not_configured (CONSOLE_ORIGIN unset)", respond: () => json({ ok: false, reason: "passkey_not_configured" }, 501), expect: /501/ },
      { label: "429 from the per-IP sign-in rate limiter", respond: () => json({ error: "slow down" }, 429, { "retry-after": "30" }), expect: /too many requests/i },
      { label: "500 from the engine's last-resort handler", respond: () => json({ error: "internal" }, 500), expect: /500/ },
      { label: "503 the console worker has no ENGINE binding", respond: () => json({ error: "engine-binding-absent" }, 503), expect: /ENGINE service binding/ },
      // A 404 serving HTML is the wrong-address shape client-transport.ts names: an engine URL pointing at a
      // static host or a proxy. The status matters and this case was mis-specified once, with a 502, which
      // the transport deliberately keeps as `server` because a 5xx HTML page is most often Cloudflare's 1101
      // in front of a real engine that is BROKEN rather than absent. Keeping the 404 preserves the case the
      // gate actually exists for; the 500 case above already covers the broken-engine reading.
      { label: "a web page served where engine data was expected (404 HTML, wrong address)", respond: () => new Response("<html><body>hello</body></html>", { status: 404, headers: { "content-type": "text/html" } }), expect: /web page/i },
      { label: "a 2xx whose body could not be read", respond: () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }), expect: /not a reachability problem/i },
    ];
    for (const c of answered) {
      const err = await thrownFor(c.respond);
      const login = passkeyErrorMessage(err, "login");
      const register = passkeyErrorMessage(err, "register");
      const recovery = recoveryTransportMessage(err);
      ok(`${c.label}: passkey login copy does NOT claim the engine was unreachable`, !unreachableCopy.test(login));
      ok(`${c.label}: passkey register copy does NOT claim the engine was unreachable`, !unreachableCopy.test(register));
      ok(`${c.label}: recovery copy does NOT claim the engine was unreachable`, !unreachableCopy.test(recovery));
      ok(`${c.label}: the operator is told what actually happened`, c.expect.test(login));
      // The reviewed sentence is the SAME one a block error or a toast would give for this failure, which is
      // the whole reason it is reached through errorDetail rather than written again here.
      ok(`${c.label}: the copy is errorDetail's reviewed sentence, not a second account`, login === errorDetail(err));
    }

    // THE KNOWN POSITIVE. fetch itself threw, carrying no status: nothing answered, so the reachability copy
    // is a fact and must survive. If this ever goes green while the block above is also green because
    // everything reads as an answer, the repair has eaten its own control.
    const unreachable = await thrownFor(() => { throw new TypeError("Failed to fetch"); });
    ok("KNOWN POSITIVE: a genuinely unreachable engine still reads as unreachable (login)", unreachableCopy.test(passkeyErrorMessage(unreachable, "login")));
    ok("KNOWN POSITIVE: a genuinely unreachable engine still reads as unreachable (register)", unreachableCopy.test(passkeyErrorMessage(unreachable, "register")));
    ok("KNOWN POSITIVE: a genuinely unreachable engine still reads as unreachable (recovery)", unreachableCopy.test(recoveryTransportMessage(unreachable)));
    // The unreachable copy still names the ceremony, and still never renders the raw message (a fetch
    // TypeError's text can carry the engine's internal hostname).
    ok("the unreachable login copy names signing in, the register copy names setting up", /sign in with a passkey/.test(passkeyErrorMessage(unreachable, "login")) && /set up a passkey/.test(passkeyErrorMessage(unreachable, "register")));
    ok("the unreachable copy does not render the raw fetch message", !passkeyErrorMessage(unreachable, "login").includes("Failed to fetch"));

    // The DOMException branches must be untouched by all of this: a cancel is not an engine answer and must
    // not be re-routed through the classifier.
    ok("a cancelled gesture is still a cancel, not an engine answer", /cancelled or timed out/i.test(passkeyErrorMessage(named("NotAllowedError"), "login")));

    // House style holds on every new sentence this section can produce.
    const produced = [passkeyErrorMessage(unreachable, "login"), recoveryTransportMessage(unreachable)].join(" ");
    ok("no em dash in the copy this section exercises (house style)", !produced.includes("—"));
  } finally {
    g.fetch = savedFetch;
    console.error = savedError;
  }
}

// main is a thin orchestrator: it builds the shared byte fixtures and runs each section in the
// original source order so `node test/validate-passkey-login.ts` runs the full suite unchanged.
async function main(): Promise<void> {
  // Build a realistic set of byte fixtures shared across the option/credential tests.
  const fx: PasskeyFixtures = { challenge: rnd(32), userHandle: rnd(32), credId: rnd(48) };

  await testPureHelpers(fx);
  await testLoginFlow(fx);
  await testStepUpFlow(fx);
  await testRegisterFlow(fx);
  await testInviteFlow(fx);
  await testRender();
  await testAnsweredIsNotUnreachable();

  // Clean up the store so a re-run is isolated.
  signOut();

  console.log(failures === 0 ? "\nPASSKEY-LOGIN VECTORS PASS" : `\n${failures} FAILURE(S)`);
    if (failures > 0) process.exit(1);
}

// named builds a DOMException-shaped error with a given .name (the screen reads err.name only).
function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

main().catch((err) => {
  console.error("\nVALIDATE-PASSKEY-LOGIN THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
