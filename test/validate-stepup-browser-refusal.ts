// A BROWSER THAT REFUSED THE STEP-UP, REPORTED AS A DEVICE WITH NO PASSKEY, WITH ADVICE THAT MAKES IT WORSE.
//
// Chromium refuses a WebAuthn `get` whose allowCredentials list exceeds 64 entries, throwing a
// DOMException named `RangeError` before any authenticator is consulted, regardless of where the genuine
// credential sits in the list: it is a verdict on list size, not a device or user refusal.
//
// WHY THAT REACHES THIS FILE. scheduler-do-stepup.ts's stepUpBegin emits an account's ENTIRE credential list
// into allowCredentials. So an account holding 65 or more credentials cannot complete a step-up at all --
// and step-up is what gates /passkey/credentials/delete, which is the only way to get back under the
// ceiling. The engine's own count only ever grows.
//
// AND THE DESCRIPTION IS THE DEFECT, exactly as it is for the register path. runStepUpOutcome must not
// catch every throw bare and answer `no-assertion`, whose copy is:
//
//   "...Try again and approve the prompt; if no prompt appears, this device has no passkey enrolled for you
//    and you can enrol one from Security."
//
// No prompt appears, because the browser threw before opening one. So the operator would be told to enrol
// another passkey, which takes the account from 65 to 66 -- further above the ceiling, in the only
// direction that cannot be undone. That is not merely a misdescription; it prescribes the action that
// deepens the harm.
//
// The register path already tells a browser refusal from a transport fault (passkeyErrorMessage). This
// file drives the SAME DOMException down BOTH paths, so the register path is a differential control: it
// proves the misdescription belongs to the step-up path rather than to the error.
//
// Run: node test/validate-stepup-browser-refusal.ts


let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

// ---- a minimal DOM shim, in the same hand-rolled style the other console validators use (no jsdom) ------
class ShimNode {
  tagName: string;
  children: ShimNode[] = [];
  text_ = "";
  attrs = new Map<string, string>();
  constructor(_kind: string, tag = "") {
    this.tagName = tag.toUpperCase();
  }
  appendChild(n: ShimNode): ShimNode {
    this.children.push(n);
    return n;
  }
  append(...n: ShimNode[]): void {
    for (const c of n) this.children.push(c);
  }
  replaceChildren(...n: ShimNode[]): void {
    this.children = [...n];
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  get classList() {
    return { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  get style(): Record<string, string> {
    return {};
  }
  get textContent(): string {
    return this.text_ + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text_ = v == null ? "" : String(v);
    this.children = [];
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  __shim: true,
  createElement: (tag: string) => new ShimNode("element", tag),
  createElementNS: (_ns: string, tag: string) => new ShimNode("element", tag),
  createTextNode: (t: string) => {
    const n = new ShimNode("text");
    n.text_ = t == null ? "" : String(t);
    return n;
  },
  createDocumentFragment: () => new ShimNode("fragment"),
  body: new ShimNode("element", "body"),
  readyState: "complete",
};
g.Node = ShimNode;
g.window = globalThis;
if (!("location" in g)) g.location = { origin: "https://console.test", pathname: "/", search: "" };

// ---- the WebAuthn stub. It throws a REAL DOMException, because that is what the code under test branches
// on and an Error with a doctored .name would let a broken branch look mended. ----------------------------
type Behaviour = { kind: "credential"; cred: unknown } | { kind: "null" } | { kind: "throw"; err: unknown };
const wa: { nextCreate: Behaviour; nextGet: Behaviour } = { nextCreate: { kind: "null" }, nextGet: { kind: "null" } };
function resolve(b: Behaviour): unknown {
  if (b.kind === "credential") return b.cred;
  if (b.kind === "null") return null;
  throw b.err;
}
Object.defineProperty(g, "navigator", {
  configurable: true,
  writable: true,
  value: {
    credentials: {
      create: async () => resolve(wa.nextCreate),
      get: async () => resolve(wa.nextGet),
    },
  },
});
g.PublicKeyCredential = function PublicKeyCredential() {};

import type { EngineClient } from "../src/api.ts";
import { b64urlEncode } from "../src/bytes.ts";
import { stepUpFailureMessage } from "../src/lib/errors.ts";
import { runRegister, runStepUpOutcome } from "../src/screens/passkey.ts";

// THE EXACT DOMException Chromium throws, name and message reproduced verbatim.
const CEILING_ERROR = new DOMException("The `allowCredentials` attribute exceeds the maximum allowed size (64).", "RangeError");
const EXCLUDE_CEILING_ERROR = new DOMException("The `excludeCredentials` attribute exceeds the maximum allowed size (64).", "RangeError");

function rnd(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// A step-up engine stub: begin always succeeds, finish returns a token. Only the browser varies.
function stepUpEngine(finishOk = true): EngineClient {
  return {
    async stepUpBegin() {
      return { ok: true as const, challengeId: "stepup-1", publicKey: { challenge: b64urlEncode(rnd(32)), rpId: "engine.test", allowCredentials: [] } };
    },
    async stepUpFinish() {
      return finishOk ? { ok: true as const, stepUpToken: "stk-1" } : { ok: false as const, reason: "bad_assertion" };
    },
  } as unknown as EngineClient;
}

// A believable assertion credential, so the positive control can actually succeed.
function assertionCredential(): unknown {
  return {
    id: "cred-1",
    rawId: rnd(32).buffer,
    type: "public-key",
    response: {
      clientDataJSON: rnd(32).buffer,
      authenticatorData: rnd(37).buffer,
      signature: rnd(64).buffer,
      userHandle: rnd(16).buffer,
    },
  };
}

async function main(): Promise<void> {
  console.log("KNOWN POSITIVE: the rig can complete a step-up, so a failure below means something --");
  {
    wa.nextGet = { kind: "credential", cred: assertionCredential() };
    const out = await runStepUpOutcome(stepUpEngine());
    ok("a clean ceremony returns ok with a token", out.ok === true && out.token === "stk-1");
  }

  console.log("\nTHE SWEPT EDGE: the browser refuses the assertion at allowCredentials > 64 --");
  let ceilingReason = "";
  {
    wa.nextGet = { kind: "throw", err: CEILING_ERROR };
    const out = await runStepUpOutcome(stepUpEngine());
    ok("the ceremony fails", out.ok === false);
    ceilingReason = out.ok === false ? out.reason : "";
    console.log(`         reason reported: ${JSON.stringify(ceilingReason)}`);
    console.log(`         copy shown:      ${JSON.stringify(stepUpFailureMessage(ceilingReason as never))}`);
  }

  console.log("\nNEGATIVE CONTROLS: states that MUST classify differently from the ceiling refusal --");
  let cancelReason = "";
  let nullReason = "";
  {
    // A genuine cancel/timeout. WebAuthn merges "dismissed" and "no matching credential" into one
    // NotAllowedError on purpose (anti-enumeration), and this validator does NOT ask for those to be split.
    wa.nextGet = { kind: "throw", err: new DOMException("The operation either timed out or was not allowed.", "NotAllowedError") };
    const cancelled = await runStepUpOutcome(stepUpEngine());
    cancelReason = cancelled.ok === false ? cancelled.reason : "";
    ok("a cancelled prompt still reports no-assertion (the deliberate merge is preserved)", cancelReason === "no-assertion");

    wa.nextGet = { kind: "null" };
    const nulled = await runStepUpOutcome(stepUpEngine());
    nullReason = nulled.ok === false ? nulled.reason : "";
    ok("a null credential still reports no-assertion (the deliberate merge is preserved)", nullReason === "no-assertion");

    // A TRANSPORT fault out of the engine call, which is a different failure with different advice.
    const brokenTransport = {
      async stepUpBegin(): Promise<never> {
        throw new TypeError("Failed to fetch");
      },
      async stepUpFinish(): Promise<never> {
        throw new TypeError("Failed to fetch");
      },
    } as unknown as EngineClient;
    wa.nextGet = { kind: "credential", cred: assertionCredential() };
    const transport = await runStepUpOutcome(brokenTransport);
    ok("a transport fault does not claim the device has no passkey", transport.ok === false && transport.reason !== "no-assertion");
  }

  console.log("\nTHE VERDICT: is the refusal honest? --");
  {
    ok("the browser's size refusal is NOT reported as the same state as a cancelled prompt", ceilingReason !== cancelReason);
    ok("the browser's size refusal is NOT reported as the same state as a null credential", ceilingReason !== nullReason);

    const copy = stepUpFailureMessage(ceilingReason as never);
    // THE HARM TEST, and the reason this is worse than a bland wrong sentence. The account is over a ceiling
    // it can only cross in one direction, and the merged copy's remedy is to enrol another passkey.
    ok("the copy does NOT tell the operator to enrol another passkey", !/enrol one from Security/i.test(copy));
    ok("the copy does NOT assert that this device has no passkey enrolled", !/no passkey enrolled for you/i.test(copy));
    ok("the copy says the browser refused it", /browser/i.test(copy));
    ok("the copy still states nothing was changed", /nothing was changed/i.test(copy));
  }

  console.log("\nDIFFERENTIAL CONTROL: the SAME class of error down the REGISTER path, which is already fixed there --");
  {
    // If the register path names this honestly and the step-up path does not, the fault is the step-up
    // path's, not the error's. Driving both from one file is what makes that a control rather than a claim.
    let shown = "";
    wa.nextCreate = { kind: "throw", err: EXCLUDE_CEILING_ERROR };
    await runRegister(
      {
        async passkeyRegisterBegin() {
          return { ok: true as const, challengeId: "reg-1", publicKey: { challenge: b64urlEncode(rnd(32)), rp: { id: "engine.test", name: "e" }, user: { id: b64urlEncode(rnd(16)), name: "a@b.test", displayName: "a" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } };
        },
        async passkeyRegisterFinish() {
          return { ok: false as const, reason: "bad_request" };
        },
      } as unknown as EngineClient,
      "a@b.test",
      {
        setStatus: (n: unknown) => {
          shown = (n as { textContent?: string } | null)?.textContent ?? "";
        },
        setBusy: () => {},
        onSuccess: async () => {},
      },
    );
    ok("the register path names the BROWSER as the refuser", /browser/i.test(shown));
    ok("the register path does not send the operator to the network", !/could not reach/i.test(shown));
    console.log(`         register copy: ${JSON.stringify(shown.slice(0, 160))}`);
  }

  console.log(failures === 0 ? `\nvalidate-stepup-browser-refusal: ALL PASS (${checks} checks)` : `\nvalidate-stepup-browser-refusal: ${failures} of ${checks} FAILED`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

await main();
