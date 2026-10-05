// validate-api: the key ceremony's audit-intent WRITE (REAL CODE).
//
// Coverage (section 7 from the original single-file suite):
//   recordCeremonyIntent() -> recordAuditIntent, the wire contract.
//   The invite write that shared this section (setRole from the first run's team step) moved with its control
//   to the setup surface, and its checks to test/validate-setup-surface.ts, which renders that page under
//   the full DOM shim.
//
// The store/nav bridge is passed in by the flows coordinator (validate-api-flows.ts) so the
// shim is installed and the shared modules are imported exactly once.

import type * as Store from "../src/lib/store.ts";
import type * as Nav from "../src/lib/nav.ts";

import { type Harness, ShimElement, type ShimNode } from "./validate-api-shared.ts";

export async function runOnboardingFlows(
  h: Harness,
  store: typeof Store,
  _nav: typeof Nav,
): Promise<void> {
  const ok = h.ok.bind(h);

  // Store ordering (finding console-test-002-08): `store` is the live singleton shared with
  // the other groups in this suite. This group seeds the caller and engine before it reads
  // them. The deliberate contract is LINEAR execution (the orchestrator awaits each group in
  // order) with each group seeding the store before use. Do NOT reorder or parallelise the
  // groups, and do NOT rely on store state leaking in from an earlier group.

  // ==========================================================================
  // SECTION 7: the key ceremony's audit-intent WRITE (REAL CODE)
  //
  // A prior gap audit flagged the first run's two engine writes as untested.
  //   1. recordCeremonyIntent() -> EngineClient.recordAuditIntent("key-ceremony-intent"): a fire-and-forget
  //      audit INTENT marker taken at the ceremony's attempt. The no-custody invariant is that it carries ONLY
  //      {action} -- never a key, never a fingerprint. This section captures the real request body and asserts
  //      it is exactly {action:"key-ceremony-intent"} with no extra keys, against the real EngineClient method
  //      with a captured fetch (that method is what recordCeremonyIntent calls).
  //   2. "Grant role" -> EngineClient.setRole(email, role) moved with its control to the setup surface's team
  //      view; test/validate-setup-surface.ts drives it through the real page.
  // ==========================================================================
  console.log("\n-- the key ceremony audit-intent write (real code) --");

  // 7-pre. The shim document needs a body for toast() (the success path announces via a
  // toast region appended to document.body). installDomShim is already in effect (the
  // flows coordinator installed it); add a body element so the success-path toast does not
  // throw. Idempotent.
  {
    const doc = (globalThis as unknown as { document: { body?: ShimNode } }).document;
    if (!doc.body) doc.body = new ShimElement("body");
  }

  // 7d. recordAuditIntent wire contract (the method recordCeremonyIntent calls): the POST
  // body is EXACTLY {action:"key-ceremony-intent"} -- no key, no fingerprint, no extra
  // fields. Driven against the REAL EngineClient method with a captured global fetch.
  {
    store.connect("https://engine.test");
    const engine = store.getEngine();
    let capturedBody: unknown ;
    let capturedMethod: string | undefined;
    let capturedPath = "";
    const origFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as unknown as { fetch: (input: string, init?: { method?: string; body?: string }) => Promise<unknown> }).fetch =
      async (input, init) => {
        capturedPath = String(input);
        capturedMethod = init?.method;
        capturedBody = init?.body !== undefined ? JSON.parse(init.body) : undefined;
        // A minimal Response double: parseJson reads .ok then .text().
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "evt-1", action: "key-ceremony-intent", at: "2026-01-01T00:00:00Z" }) };
      };
    try {
      await engine?.recordAuditIntent("key-ceremony-intent");
    } finally {
      (globalThis as { fetch?: unknown }).fetch = origFetch;
    }
    ok("7d: recordAuditIntent POSTs to /admin/audit/intent", capturedPath.endsWith("/admin/audit/intent"));
    ok("7d: recordAuditIntent uses POST", capturedMethod === "POST");
    ok("7d: intent body carries the action", (capturedBody as { action?: string } | undefined)?.action === "key-ceremony-intent");
    // The no-custody assertion: the body has EXACTLY one key (action). Any key/fingerprint/
    // value smuggled in fails here.
    const bodyKeys = capturedBody && typeof capturedBody === "object" ? Object.keys(capturedBody as object) : [];
    ok("7d: intent body has exactly one field (action only)", bodyKeys.length === 1 && bodyKeys[0] === "action");
    // Belt-and-braces negative control: explicitly no key/fingerprint fields.
    ok("7d: intent body carries no key/fingerprint field (no-custody)", !bodyKeys.includes("key") && !bodyKeys.includes("fingerprint") && !bodyKeys.includes("private") && !bodyKeys.includes("value"));
  }
}
