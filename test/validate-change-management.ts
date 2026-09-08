// Validator for CHANGE MANAGEMENT (Require Change Number) on the CONSOLE side. The engine is the authority and
// is tested separately; this proves the console glue: the change-reference header ENCODING the engine decodes,
// the transport attaching it, a change-controlled client method actually SENDING it, requireChange being a
// no-op when the policy is off (and failing open on a read fault), and the audit "change" target rendering the
// CR number with a LOUD Emergency Change marker. Run with: node test/validate-change-management.ts

import { installDomShim } from "./dom-shim.ts";
import { encodeChangeHeader, type ChangeRef } from "../src/lib/change-ref.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { EngineClient } from "../src/lib/api/client.ts";
import { requireChange } from "../src/components/require-change.ts";
import { reset as resetRing, snapshot } from "../src/lib/client-diag/ring.ts";
import { describeTarget } from "../src/screens/access-security/audit-display.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// tick flushes the microtask + macrotask queue so an awaited policy read + the modal mount settle before the
// test inspects the DOM. clickButton finds a mounted button by its (partial) label and fires its click handler.
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
function bodyButtons(): Array<{ textContent: string; click: () => void }> {
  const body = (globalThis as unknown as { document: { body: { querySelectorAll: (s: string) => Array<{ textContent: string; click: () => void }> } } }).document.body;
  return body.querySelectorAll("button");
}
function clickButton(label: string): void {
  const btn = bodyButtons().find((b) => (b.textContent ?? "").includes(label));
  if (!btn) throw new Error(`button not found: ${label}`);
  btn.click();
}
function setFieldValue(id: string, value: string): void {
  const el = (globalThis as unknown as { document: { getElementById: (i: string) => { value: string } | null } }).document.getElementById(id);
  if (el === null) throw new Error(`field not found: ${id}`);
  el.value = value;
}

// decodeHeader reverses encodeChangeHeader (base64url -> JSON), the same decode the engine's decodeChangeHeader
// performs, so the round-trip proves the console and engine agree on the wire shape.
function decodeHeader(v: string): unknown {
  const b64 = v.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function main(): Promise<void> {
  console.log("CHANGE MANAGEMENT (console) VECTORS");
  installDomShim();

  // 1) encodeChangeHeader round-trips a reference for the engine to decode (url-safe, no padding).
  {
    const ref: ChangeRef = { number: "CHG0012345", emergency: false, reason: null };
    const h = encodeChangeHeader(ref);
    ok("encodeChangeHeader is url-safe (no + / =)", !/[+/=]/.test(h));
    ok("encodeChangeHeader round-trips a normal reference", JSON.stringify(decodeHeader(h)) === JSON.stringify(ref));
    const em: ChangeRef = { number: null, emergency: true, reason: "prod outage" };
    ok("encodeChangeHeader round-trips an emergency reference", JSON.stringify(decodeHeader(encodeChangeHeader(em))) === JSON.stringify(em));
  }

  // 2) Transport.headers attaches x-downpipes-change ONLY when a reference is supplied.
  {
    const t = new Transport("https://engine.example.com", "tok");
    const withRef = t.headers({ number: "CHG-1", emergency: false, reason: null });
    ok("headers(change) sets x-downpipes-change", typeof withRef["x-downpipes-change"] === "string" && withRef["x-downpipes-change"].length > 0);
    ok("headers() (no change) omits x-downpipes-change", t.headers()["x-downpipes-change"] === undefined);
  }

  // 3) A change-controlled client method SENDS the reference; the same method without one omits it.
  {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(JSON.stringify({ destinations: [], defaultId: null }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new EngineClient("https://engine.example.com", "tok");
      await client.removeDestination("d1", { number: "CHG-77", emergency: false, reason: null });
      const sent = calls[calls.length - 1]?.headers["x-downpipes-change"];
      ok("removeDestination(change) sends the reference as x-downpipes-change", typeof sent === "string" && (decodeHeader(sent) as ChangeRef).number === "CHG-77");
      await client.removeDestination("d2");
      ok("removeDestination() without a reference omits the header", calls[calls.length - 1]?.headers["x-downpipes-change"] === undefined);

      // setChangeNumberPolicy posts the flag to the owner-only change-number-policy route.
      (globalThis as { fetch: unknown }).fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
        return new Response(JSON.stringify({ requireChangeNumber: true }), { status: 200 });
      }) as typeof fetch;
      const policy = await client.setChangeNumberPolicy(true);
      ok("setChangeNumberPolicy posts to /admin/config/change-number-policy and returns the flag", calls[calls.length - 1]?.url.endsWith("/admin/config/change-number-policy") === true && policy.requireChangeNumber === true);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // 4) requireChange is a NO-OP when the policy is off (proceed with no reference, no modal), and fails OPEN on
  // a policy-read fault (the engine still enforces, so the action proceeds and is refused server-side if needed).
  {
    resetRing();
    const off = { getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: false }) } as unknown as EngineClient;
    const r = await requireChange(off, "Remove this destination", "destination-delete");
    ok("requireChange is a no-op when the policy is off (proceed, no reference)", r.proceed === true && r.change === null);
    const faulty = { getConfigApprovalPolicy: async () => { throw new Error("boom"); } } as unknown as EngineClient;
    const rf = await requireChange(faulty, "Remove this destination", "destination-delete");
    ok("requireChange fails open on a policy-read fault (proceed, no reference)", rf.proceed === true && rf.change === null);
    // Failing open is only defensible because it is RECORDED. The operator is about to be sent at a
    // change-controlled action with no prompt and no reference, and this ring entry is the whole
    // compensating control, so the skip is explicable afterwards from the support pack. Nothing
    // asserted it until now, which is how it could have been dropped without anything going red.
    const gateRows = snapshot().records.filter((r) => r.kind === "gov-gate");
    ok("the skipped prompt is RECORDED, which is what makes failing open defensible",
      gateRows.some((r) => String(r.govGate) === "change-prompt-skipped-policy-read-failed"));
    ok("the recorded gate names the action whose prompt was skipped",
      gateRows.some((r) => String(r.adminOp) === "destination-delete"));
  }

  // 5) The audit "change" target renders the CR number for a normal change, and an Emergency Change LOUDLY.
  {
    const normal = describeTarget({ kind: "change", actionKind: "dest-remove", emergency: false, changeNumber: "CHG-100", reason: null });
    const normalText = normal.textContent ?? "";
    ok("describeTarget renders a normal change with its number + action", /CHG-100/.test(normalText) && /dest-remove/.test(normalText));
    const emergency = describeTarget({ kind: "change", actionKind: "dest-remove", emergency: true, changeNumber: null, reason: "outage" });
    const emText = emergency.textContent ?? "";
    ok("describeTarget renders an Emergency Change loudly with the reason", /EMERGENCY CHANGE/.test(emText) && /outage/.test(emText));
  }

  // 6) When the policy is ON, requireChange opens the change modal: a NORMAL change returns the number; an
  // EMERGENCY change returns the justification; a CANCEL aborts. (Exercises the modal UX + collectChange.)
  {
    const on = { getConfigApprovalPolicy: async () => ({ requireConfigApproval: false, requireChangeNumber: true }) } as unknown as EngineClient;

    const pNormal = requireChange(on, "Repoint the destination", "destination-upsert");
    await tick();
    setFieldValue("cm-change-number", "CHG-555");
    clickButton("Confirm change");
    const rNormal = await pNormal;
    ok("a normal change returns the entered change number", rNormal.proceed === true && rNormal.change?.emergency === false && rNormal.change?.number === "CHG-555");

    const pEmergency = requireChange(on, "Remove the destination", "destination-delete");
    await tick();
    clickButton("Emergency Change"); // the affordance to switch into emergency mode
    setFieldValue("cm-emergency-reason", "prod outage, repointing now");
    clickButton("Confirm change");
    const rEmergency = await pEmergency;
    ok("an Emergency Change returns an emergency reference with the justification", rEmergency.proceed === true && rEmergency.change?.emergency === true && rEmergency.change?.reason === "prod outage, repointing now");

    const pCancel = requireChange(on, "Apply the restore", "restore-apply");
    await tick();
    clickButton("Cancel");
    const rCancel = await pCancel;
    ok("cancelling the modal aborts (proceed:false, no reference)", rCancel.proceed === false && rCancel.change === null);
  }

  if (failures > 0) {
    console.log(`\nFAIL: ${failures} change-management assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nCHANGE MANAGEMENT (console) VECTORS PASS");
}

await main();
