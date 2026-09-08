// validate-api: the onboarding wizard's two engine WRITES (REAL CODE).
//
// Coverage (section 7 from the original single-file suite):
//   7: recordCeremonyIntent() -> recordAuditIntent and renderInviteForm's
//      "Grant role" -> setRole, both driven through the REAL onboardingCeremonyScreen
//      (src/screens/onboarding-ceremony.ts), never a copy of their logic.
//
// The store/nav bridge is passed in by the flows coordinator (validate-api-flows.ts) so the
// shim is installed and the shared modules are imported exactly once.

import type {
  Caller,
} from "../src/api.ts";

import type * as Store from "../src/lib/store.ts";
import type * as Nav from "../src/lib/nav.ts";

import {
  type Harness,
  flushAsync,
  markConnected,
  querySelectorShim,
  querySelectorAllShim,
  textOf,
  ShimElement,
  type ShimNode,
} from "./validate-api-shared.ts";

export async function runOnboardingFlows(
  h: Harness,
  store: typeof Store,
  nav: typeof Nav,
): Promise<void> {
  const ok = h.ok.bind(h);

  // Store ordering: `store` is the live singleton shared with
  // the other groups in this suite. This group seeds the caller and engine before it reads
  // them. The deliberate contract is LINEAR execution (the orchestrator awaits each group in
  // order) with each group seeding the store before use. Do NOT reorder or parallelise the
  // groups, and do NOT rely on store state leaking in from an earlier group.

  // ==========================================================================
  // SECTION 7: onboarding wizard's two engine WRITES (REAL CODE)
  //
  // The onboarding wizard performs exactly two engine writes, both previously untested:
  //   1. recordCeremonyIntent() -> EngineClient.recordAuditIntent("key-ceremony-intent"):
  //      a fire-and-forget audit INTENT marker recorded after the key ceremony. The
  //      no-custody invariant is that it carries ONLY {action} -- never a key, never a
  //      fingerprint. A regression that started sending a fingerprint in the intent body
  //      would silently break that invariant; this section captures the real request body
  //      and asserts it is exactly {action:"key-ceremony-intent"} with no extra keys.
  //   2. renderInviteForm's "Grant role" -> EngineClient.setRole(email, role): the only
  //      role write in onboarding. Its degrade matters. CONTRACT UPDATED (UX findings
  //      send-invite-label-overclaims + invite-d3-false-pending): the button is now
  //      "Grant role" (the call is a role-table upsert, not necessarily an email send);
  //      D1-D4 shipped, so the success copy states the stored fact plainly with NO
  //      "subject to the engine enforcing D3" caveat; ONLY a 404/501 (an engine build
  //      without the role store) renders the pendingEngineNote degrade, any other
  //      failure (a 500/503, a network fault) renders the retryable blockError rather
  //      than being dressed up as a missing feature; a 401 still routes to signed-out.
  //      A 200 carrying the minted inviteToken renders the copyable /#/register?invite=
  //      enrolment link (render-only; finding grant-vs-invite-link-contradiction).
  //
  // Both are driven through the REAL onboardingCeremonyScreen (src/screens/onboarding-
  // ceremony.ts), never a copy of its logic: the screen is rendered on the invite step
  // with a fake EngineClient injected onto the store's real client instance, and the real
  // "Grant role" button is clicked. recordAuditIntent's wire contract is exercised
  // against the real EngineClient method with a captured fetch (that method is what the
  // wizard's recordCeremonyIntent calls).
  // ==========================================================================
  console.log("\n-- onboarding audit-intent + invite/setRole writes (real code) --");

  // 7-pre. The shim document needs a body for toast() (the success path announces via a
  // toast region appended to document.body). installDomShim is already in effect (the
  // flows coordinator installed it); add a body element so the success-path toast does not
  // throw. Idempotent.
  {
    const doc = (globalThis as unknown as { document: { body?: ShimNode } }).document;
    if (!doc.body) doc.body = new ShimElement("body");
  }

  const onboardingMod = await import("../src/screens/onboarding-ceremony.ts");

  // setRoleResult is the shape EngineClient.setRole resolves to (RoleEntry); only the
  // fields the success copy reads (email, role) are asserted.
  type SetRoleArgs = { email: string; role: string };

  // driveInvite renders the REAL onboarding wizard on the invite step for an Owner (so the
  // invite form renders -- the form is Owner-gated; canDo("owner") reads the store caller),
  // injects a setRole double with the given behaviour, fills the email field, selects the
  // role, clicks the real "Grant role" button (the new contract: the old "Send invite"
  // label overclaimed an email send the console cannot see), and reports what happened:
  // the captured setRole arguments, whether goSignedOut fired, whether the handler threw
  // (an unhandled rejection escaping the handler's own try/catch), and the rendered output
  // text. It rebuilds the world each call so scenarios are independent. The ok entry may
  // carry the engine-minted inviteToken the 200 body returns alongside the entry.
  async function driveInvite(
    behaviour: { kind: "ok"; entry: SetRoleArgs & { inviteToken?: string } } | { kind: "throw"; error: Error },
    opts: { email: string; role?: "viewer" | "operator" | "approver" } = { email: "teammate@example.com" },
  ): Promise<{ captured: SetRoleArgs | null; signedOut: boolean; threw: boolean; outputText: string; rootText: string }> {
    const owner: Caller = { method: "access", email: "owner@maelstrom.au", role: "owner", groups: [], isOnlyOwner: false };
    store.setCaller(owner);
    store.connect("https://engine.test");
    const engine = store.getEngine();
    if (!engine) return { captured: null, signedOut: false, threw: false, outputText: "", rootText: "" };

    let signedOut = false;
    nav.installNav({
      navigate: () => {},
      onUnauthorised: () => { signedOut = true; },
      refreshIdentity: async () => {},
      signOut: () => {},
      onAuthenticated: async () => {},
    });

    let captured: SetRoleArgs | null = null;
    // setRole now resolves to a MutationResult (the change-control gate may defer a role change): the
    // success path wraps the entry as { status:"applied", value }. The onboarding handler narrows on
    // res.status, so the double must return that discriminated shape (not a bare RoleEntry).
    (engine as unknown as { setRole: (email: string, role: string) => Promise<{ status: "applied"; value: SetRoleArgs }> }).setRole = async (email, role) => {
      captured = { email, role };
      if (behaviour.kind === "throw") throw behaviour.error;
      return { status: "applied", value: behaviour.entry };
    };

    // Catch a handler that throws instead of degrading (the exact regression this section
    // guards: "renders the pendingEngineNote degrade rather than throwing"). The real
    // handler is an async click listener, so an escaped throw surfaces as an unhandled
    // rejection rather than a synchronous throw at click().
    let threw = false;
    const onRejection = () => { threw = true; };
    process.on("unhandledRejection", onRejection);

    try {
      const root = onboardingMod.onboardingCeremonyScreen.render({
        pattern: "/onboarding/:step",
        params: { step: "invite" },
        query: new URLSearchParams(),
        path: "/onboarding/invite",
        engine,
        caller: owner,
        navigate: () => {},
      });
      markConnected(root);

      const emailInput = querySelectorShim(root, "#ob-invite-email");
      if (emailInput) (emailInput as { value: string }).value = opts.email;
      if (opts.role) {
        const roleSelect = querySelectorShim(root, "#ob-invite-role");
        if (roleSelect) (roleSelect as { value: string }).value = opts.role;
      }

      // The button is "Grant role" (new contract, finding send-invite-label-overclaims:
      // the call is a setRole upsert; whether an email goes out depends on engine config).
      const sendBtn = querySelectorAllShim(root, "button").find((b) => textOf(b).includes("Grant role"));
      if (sendBtn) (sendBtn as { click: () => void }).click();

      await flushAsync();

      // The verdict region the handler writes into (role="status"); fall back to the whole
      // root if not located so an assertion on missing copy fails loudly rather than passing
      // vacuously on an empty string.
      const out = querySelectorShim(root, ".ob-verdict");
      return {
        captured,
        signedOut,
        threw,
        outputText: out ? textOf(out) : "",
        rootText: textOf(root),
      };
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }

  // 7a. setRole REAL FAULT (a 503): NEW CONTRACT (finding invite-d3-false-pending) -- a
  // real failure renders the retryable blockError, never the pendingEngineNote (dressing
  // a 500/503 up as a missing feature masked real errors); the handler does not throw;
  // the engine was actually called with the entered email + default role.
  {
    const r = await driveInvite({ kind: "throw", error: new Error("set role: 503") }, { email: "ada@example.com" });
    ok("7a: setRole was called (real handler reached the write)", r.captured !== null);
    ok("7a: setRole received the entered email", r.captured?.email === "ada@example.com");
    ok("7a: setRole received the default role (viewer)", r.captured?.role === "viewer");
    ok("7a: a real fault (503) renders the retryable block error", r.rootText.includes("The engine returned an error") && r.rootText.includes("Retry"));
    ok("7a: a real fault is NOT dressed up as pending engine support", !r.rootText.includes("Pending engine support"));
    ok("7a: the handler did NOT throw (degraded, not crashed)", r.threw === false);
    ok("7a: a non-2xx is NOT routed to signed-out", r.signedOut === false);
  }

  // 7a2. setRole on an engine build WITHOUT the role store (a 404): the one case the
  // pendingEngineNote degrade is still honest for (a 501 reads the same), naming the D3
  // role store as the dependency.
  {
    const r = await driveInvite({ kind: "throw", error: new Error("set role: 404") }, { email: "ada@example.com" });
    ok("7a2: a 404 renders the pendingEngineNote degrade", r.rootText.includes("Pending engine support"));
    ok("7a2: the 404 degrade names the D3 role store", r.rootText.includes("D3"));
    ok("7a2: a 404 does not throw", r.threw === false);
    ok("7a2: a 404 is NOT routed to signed-out", r.signedOut === false);
  }

  // 7b. setRole 401: routes to signed-out (goSignedOut), does not throw, and does NOT
  // render the pendingEngineNote (the handler returns early on unauthorised).
  {
    const r = await driveInvite({ kind: "throw", error: new Error("set role: 401") }, { email: "grace@example.com" });
    ok("7b: a 401 routes to signed-out", r.signedOut === true);
    ok("7b: a 401 does not throw", r.threw === false);
    ok("7b: a 401 does not render the pendingEngineNote degrade", !r.rootText.includes("Pending engine support"));
  }

  // 7c. setRole SUCCESS: NEW CONTRACT (finding invite-d3-false-pending) -- D1-D4 shipped,
  // so the success copy states the stored fact plainly and must NOT carry the old
  // "subject to the engine enforcing D3" caveat (it told the Owner an enforced grant was
  // unenforced). With no inviteToken in the 200 body, the out-of-band hint renders.
  {
    const r = await driveInvite(
      { kind: "ok", entry: { email: "linus@example.com", role: "operator" } },
      { email: "linus@example.com", role: "operator" },
    );
    ok("7c: setRole received the selected role (operator)", r.captured?.role === "operator");
    ok("7c: success reflects the stored member", r.outputText.includes("linus@example.com") && r.outputText.includes("operator"));
    ok("7c: success states the stored fact plainly", r.outputText.includes("Role stored for"));
    ok("7c: success carries NO unenforced-D3 caveat (D1-D4 shipped)", !r.outputText.includes("Subject to the engine enforcing D3"));
    ok("7c: with no invite token, the out-of-band hint renders", r.outputText.includes("out of band"));
    ok("7c: success does not throw", r.threw === false);
    ok("7c: success does not sign out", r.signedOut === false);
  }

  // 7c2. setRole SUCCESS carrying the minted inviteToken (finding grant-vs-invite-link-
  // contradiction): the 200 body's token renders as the copyable /#/register?invite=
  // enrolment link (the only artefact that passes the engine's registration gate), shown
  // once and never persisted.
  {
    const r = await driveInvite(
      { kind: "ok", entry: { email: "ada@example.com", role: "viewer", inviteToken: "tok-onb-1" } },
      { email: "ada@example.com" },
    );
    ok("7c2: the 200's inviteToken renders the enrolment link", r.outputText.includes("/#/register?invite=tok-onb-1"));
    ok("7c2: the link copy says it is shown once and not stored", r.outputText.includes("Shown once") && r.outputText.includes("does not store it"));
    ok("7c2: success with a token does not throw", r.threw === false);
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

  // The onboarding invite form POSTs /admin/roles, which the engine gates on roles.write (Owner AND
  // access-admin), the same capability the main Access roles table uses. It must gate on roles.write, not the
  // owner ladder: gating on canDo("owner") alone under-grants a control the engine allows.
  {
    const { renderInviteForm } = await import("../src/screens/onboarding/team.ts");
    store.connect("https://engine.test");
    const eng = store.getEngine();
    if (eng) {
      const aa: Caller = { method: "access", email: "aa@example.com", role: "access-admin", groups: [], isOnlyOwner: false };
      store.setCaller(aa);
      const aaForm = renderInviteForm(eng);
      ok("B40: an access-admin (holds roles.write) sees the invite form", querySelectorShim(aaForm, "#ob-invite-email") !== null);
      ok("B40: the access-admin is not shown the gate reason", !textOf(aaForm).includes("needs the roles.write capability"));
      const owner: Caller = { method: "access", email: "o@example.com", role: "owner", groups: [], isOnlyOwner: false };
      store.setCaller(owner);
      ok("B40: an owner still sees the invite form (unchanged)", querySelectorShim(renderInviteForm(eng), "#ob-invite-email") !== null);
      const viewer: Caller = { method: "access", email: "v@example.com", role: "viewer", groups: [], isOnlyOwner: false };
      store.setCaller(viewer);
      const vForm = renderInviteForm(eng);
      ok(
        "B40: a viewer sees the PERMISSION reason in customer language, not the raw id, and not the form",
        textOf(vForm).includes("needs permission to manage roles and members") && !textOf(vForm).includes("roles.write") && querySelectorShim(vForm, "#ob-invite-email") === null,
      );
    }
  }
}
