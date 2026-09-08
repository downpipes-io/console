// THE GATE-REFUSAL REACHABILITY VALIDATOR, and its whole reason for existing is the click.
//
// Run with: node test/validate-gate-refusal-reachable.ts
//
// THE DEFECT IT CLOSES. A control gated with the `disabled` property is removed from the tab order.
// There is no keystroke that reaches it, so a keyboard or screen-reader user cannot discover WHY the
// console will not let them act, and on a phone the failure is total: the reason was carried in a
// `title`, which fires on hover, and a touch device has no hover. The console had 36 controls in that
// state while ten others already used the right pattern (sources-downpipes/helpers.ts actionChip,
// components/detail-drawer.ts), which named it in its own words: aria-disabled plus a visually-hidden
// reason, focusable, never a hover-only title.
//
// WHY THE MIGRATION NEEDS A TEST AND NOT A READING. `aria-disabled` is an announcement, not an
// enforcement. Dropping `disabled` for it hands the control back its click. If any migrated site still
// attaches a handler on its gated branch, an authorisation refusal becomes a live action, on screens
// that include key rotation, licence activation and role membership. So every site below is DRIVEN:
// rendered in its refused state, then clicked, and the assertion is that a recording engine was never
// called and the caller's own effect sink never fired. That is a negative control per site, not a
// per-suite hand-wave.
//
// WHY THE SHIM IS THE RIGHT INSTRUMENT FOR IT, and this is the subtle part. The shared dom-shim's
// click() dispatches unconditionally; it does NOT model the browser's suppression of clicks on a
// disabled element. Under a real browser a click test on a `disabled` button proves nothing, because
// the browser would have swallowed it whether or not a handler was attached. Under the shim the click
// reaches every attached listener, so a click that produces no effect proves UNATTACHMENT, which is
// exactly the property that has to hold once `disabled` is gone. The instrument is strictly stronger
// than the thing it is standing in for.
//
// WHAT EACH CASE ASSERTS, in order:
//   1. FOCUSABLE. No `disabled` attribute and no `disabled` property, so the control keeps its place
//      in the tab order and its reason is reachable by keyboard.
//   2. ANNOUNCED. aria-disabled="true", so assistive technology states the refusal.
//   3. READABLE WITHOUT A MOUSE. The reason appears in the control's own textContent, as a real text
//      node. Not an aria-label: a bare span has the implicit role `generic`, where ARIA prohibits
//      aria-label, and this console has already shipped one refusal whose only remedy was an
//      aria-label on a generic element, so it looked remediated and could silently not fire.
//   4. INERT. A click fires nothing.
// and for the allowed caller, case 5: the control really is live, so a passing suite cannot be
// achieved by rendering nothing (the vacuous pass this repo has caught before).

import type { EngineClient, Caller, PushDestinationView } from "../src/api.ts";
import type { ConfigSnapshot } from "../src/screens/integrations/state.ts";
import { refuseWithReason } from "../src/screens/common.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { h } from "../src/lib/dom.ts";
import { installDomShim, qs, textOf, flushAsync, markConnected, type ShimNode } from "./dom-shim.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// The effect sink. Every callback a refused control could possibly reach lands
// here, so "the click did nothing" is measured rather than inferred from the
// absence of an exception.
// ---------------------------------------------------------------------------
const effects: string[] = [];
function sink(what: string): () => void {
  return () => {
    effects.push(what);
  };
}
function resetEffects(): void {
  effects.length = 0;
}

// recordingEngine is a Proxy over nothing: ANY method the screen calls is recorded by name and
// resolves. A hand-written stub only records the calls its author thought of, so a handler that
// fired an unexpected engine method would look like silence. This one cannot miss a call.
//
// `overrides` exists for the SYNCHRONOUS members. Not everything on the client is an async call: the
// IdP card asks for samlMetadataUrl(id) and renders the STRING it gets back, and a proxy that answers
// every member with a promise hands a Promise to appendChild, which fails deep inside the DOM shim
// with an error that looks like a shim fault rather than a fixture one. Naming the synchronous
// members is honest; widening the proxy to guess would not be.
function recordingEngine(overrides: Record<string, unknown> = {}): EngineClient {
  return new Proxy(overrides, {
    get(t: Record<string, unknown>, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        effects.push(`engine.${prop}(${args.length})`);
        return Promise.resolve({});
      };
    },
  }) as unknown as EngineClient;
}

// SAML_URLS are the synchronous string members the IdP connection card renders directly.
const SAML_URLS = {
  samlMetadataUrl: (id: string) => `https://engine.example.test/saml/${id}/metadata`,
  samlAcsUrl: (id: string) => `https://engine.example.test/saml/${id}/acs`,
};

// ---------------------------------------------------------------------------
// Shim readers. The shim keeps the `disabled` PROPERTY and the reflected
// ATTRIBUTE separately (an h() attrs literal reaches only setAttribute; an
// imperative `btn.disabled = true` reaches the property setter, which also
// mirrors into the attribute). A migration check that read only one of the two
// would pass on a site that still gates through the other, so both are read.
// ---------------------------------------------------------------------------
function disabledAnyWay(n: ShimNode): boolean {
  return n.getAttribute("disabled") !== null || (n as unknown as { disabled?: boolean }).disabled === true;
}
function ariaDisabled(n: ShimNode): string {
  return n.getAttribute("aria-disabled") ?? "";
}
// qs returns null for a miss, and the absent-control guards below test for undefined. Normalising
// here is not tidiness: without it a missing control reaches disabledAnyWay as null and the run dies
// mid-suite, and worse, a `!== undefined` presence check passes on null, which is a false PASS on the
// one assertion whose job is to prove the case was not vacuous.
function byDp(root: ShimNode, dp: string): ShimNode | undefined {
  return qs(root, `[data-dp="${dp}"]`) ?? undefined;
}

// clickListenerCount reads the shim's own listener registry for the element. This is the DECISIVE
// negative control and it exists because the effect sink alone can be too weak: reattaching the
// real handler to a refused integrations button would NOT be
// caught, because that handler opens a form and never touches the engine, so the sink stayed empty
// and the suite stayed green. A test that cannot fail on the exact defect it is guarding is worse
// than no test, so the count is read directly: zero handlers is the property that has to hold.
function clickListenerCount(n: ShimNode): number {
  const reg = (n as unknown as { listeners?: Record<string, unknown[]> }).listeners;
  return reg?.click?.length ?? 0;
}

// documentSize counts every node under the shim's body, so an effect that only shows up as an
// overlay, modal or drawer being mounted is still an effect. The engine sink cannot see those.
function documentSize(): number {
  const body = (globalThis as unknown as { document?: { body?: ShimNode } }).document?.body;
  if (!body) return 0;
  let n = 0;
  const walk = (node: ShimNode): void => {
    n++;
    for (const c of (node as unknown as { childNodes: ShimNode[] }).childNodes) walk(c);
  };
  walk(body);
  return n;
}

// assertRefusedAndInert is the per-site negative control, and every migrated site runs it.
// reasonFragment is checked as a SUBSTRING of the control's own text so the assertion binds to the
// operator-visible sentence, not to a variable name.
function assertRefusedAndInert(label: string, node: ShimNode | undefined, reasonFragment: string): void {
  if (node === undefined) {
    ok(`${label}: the refused control renders at all`, false);
    return;
  }
  ok(`${label}: keeps its place in the tab order (no disabled attribute or property)`, !disabledAnyWay(node));
  ok(`${label}: announces the refusal (aria-disabled=true)`, ariaDisabled(node) === "true");
  const text = textOf(node);
  ok(`${label}: carries its reason as real text, reachable with no mouse and no hover`, text.includes(reasonFragment));
  ok(`${label}: no click handler is attached on the refused branch`, clickListenerCount(node) === 0);
  resetEffects();
  const before = documentSize();
  (node as unknown as { click: () => void }).click();
  const grew = documentSize() - before;
  ok(`${label}: a click in the refused state calls nothing and mounts nothing`, effects.length === 0 && grew === 0);
  if (effects.length > 0 || grew !== 0) console.log(`       effects seen: ${JSON.stringify(effects)}, document grew by ${grew}`);
}

// assertLive is the anti-vacuity control. Without it every assertion above is satisfiable by a
// screen that renders no control at all in the allowed case too, which is a suite that measures
// nothing. It requires the SAME control, for the permitted caller, to be reachable AND to fire.
function assertLive(label: string, node: ShimNode | undefined): void {
  if (node === undefined) {
    ok(`${label}: the permitted caller gets the control`, false);
    return;
  }
  ok(`${label}: the permitted caller's control is not refused`, !disabledAnyWay(node) && ariaDisabled(node) !== "true");
  ok(`${label}: the permitted caller's control HAS a handler (so zero-handlers above measures something)`, clickListenerCount(node) > 0);
  resetEffects();
  (node as unknown as { click: () => void }).click();
  ok(`${label}: the permitted caller's click reaches something`, effects.length > 0);
}

const OWNER: Caller = { email: "owner@example.test", role: "owner", customRole: null } as unknown as Caller;
const VIEWER: Caller = { email: "viewer@example.test", role: "viewer", customRole: null } as unknown as Caller;

async function main(): Promise<void> {
  installDomShim();
  installNav({
    navigate: (to: string) => effects.push(`navigate(${to})`),
    onUnauthorised: () => effects.push("onUnauthorised"),
    refreshIdentity: async () => undefined,
    onAuthenticated: async () => undefined,
    signOut: () => effects.push("signOut"),
  });
  setWhoamiAvailable(true);

  // -------------------------------------------------------------------------
  console.log("\n-- the helper itself: refuseWithReason --");
  {
    // The helper is checked directly before any screen is trusted to it, because every site below
    // inherits whatever it does. A defect here would present as 36 sites quietly not migrated.
    const btn = h("button", { type: "button" }, "Do the thing") as unknown as ShimNode;
    refuseWithReason(btn as unknown as HTMLElement, "Requires the Owner role.");
    ok("helper: does not set disabled (the control stays focusable)", !disabledAnyWay(btn));
    ok("helper: sets aria-disabled", ariaDisabled(btn) === "true");
    ok("helper: the reason is in the element's text", textOf(btn).includes("Requires the Owner role."));
    ok("helper: the label is not destroyed by the reason", textOf(btn).startsWith("Do the thing"));
    // Read as an ATTRIBUTE, which is what the helper writes and what a browser honours. The shim does
    // not mirror the `title` property onto the attribute in either direction, so a helper written
    // through the property would read as titleless to every getAttribute in this repo's suite while
    // being fine in a browser. The helper sets the attribute for exactly that reason.
    ok("helper: keeps the title so a mouse user loses nothing", btn.getAttribute("title") === "Requires the Owner role.");
    // The reason must be a TEXT node under a visually-hidden span, not an aria-label. This is the
    // trap this console has already been bitten by: aria-label on an implicit-generic element is
    // prohibited by ARIA and may be dropped, so the one remedy present is the one that can silently
    // not fire.
    const hidden = qs(btn, ".visually-hidden");
    ok("helper: the reason rides in a visually-hidden span, not an ARIA attribute", hidden !== undefined && textOf(hidden).includes("Requires the Owner role."));
    ok("helper: no aria-label is used as the carrier", btn.getAttribute("aria-label") === null);
    resetEffects();
    (btn as unknown as { click: () => void }).click();
    ok("helper: the refused control has no handler of its own", effects.length === 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- config-history: Take a snapshot now (access.policy) --");
  {
    const { snapshotButton } = await import("../src/screens/config-history.ts");
    setCaller(VIEWER);
    const refused = snapshotButton(recordingEngine(), sink("reload")) as unknown as ShimNode;
    assertRefusedAndInert("config-history snapshot", refused, "Requires");
    setCaller(OWNER);
    const live = snapshotButton(recordingEngine(), sink("reload")) as unknown as ShimNode;
    assertLive("config-history snapshot", live);
    await flushAsync();
  }

  // -------------------------------------------------------------------------
  console.log("\n-- integrations: Manage a configured channel (notify.config) --");
  {
    const { renderSetupBody } = await import("../src/screens/integrations/panels.ts");
    const { CATALOGUE } = await import("../src/screens/integrations/catalogue.ts");
    const vendor = CATALOGUE.find((v) => v.channelKind !== undefined && v.kind === "notify");
    if (vendor === undefined) {
      ok("integrations: a notify vendor with a channel kind exists in the catalogue", false);
    } else {
      const snap = { channels: [{ id: "ch1", name: "Ops on-call", kind: vendor.channelKind, enabled: true }], rules: [], downpipes: [] } as unknown as ConfigSnapshot;
      setCaller(VIEWER);
      const refused = renderSetupBody(recordingEngine(), vendor, "refused", snap, sink("reload")) as unknown as ShimNode;
      assertRefusedAndInert("integrations manage", byDp(refused, "integrations.button.edit"), "Requires");
      setCaller(OWNER);
      const live = renderSetupBody(recordingEngine(), vendor, "allowed", snap, sink("reload")) as unknown as ShimNode;
      // Manage opens a form rather than calling the engine, so the anti-vacuity check here is that the
      // permitted caller's control is unrefused; the form itself is already driven end to end by
      // test/validate-integrations.ts.
      const liveBtn = byDp(live, "integrations.button.edit");
      ok("integrations manage: the permitted caller's control is not refused", liveBtn !== undefined && !disabledAnyWay(liveBtn) && ariaDisabled(liveBtn) !== "true");
      ok("integrations manage: the permitted caller's control HAS a handler", liveBtn !== undefined && clickListenerCount(liveBtn) > 0);
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n-- sources: Re-attach a source needing attention (downpipe.write) --");
  {
    const { driftTier } = await import("../src/screens/sources/tiers.ts");
    const missing = [{ binding: "SRC_KV_app_db", type: "kv" as const, downpipes: ["app db"] }];
    const found = { kv: [], r2: [], d1: [], secrets: [], tokenPresent: true } as unknown as Parameters<typeof driftTier>[2];
    setCaller(VIEWER);
    const refused = driftTier(recordingEngine(), missing, found, { refresh: sink("refresh"), opGate: false, ownerGate: false }) as unknown as ShimNode;
    assertRefusedAndInert("sources re-attach", byDp(refused, "sources.button.reattach"), "Requires");
  }

  // -------------------------------------------------------------------------
  console.log("\n-- settings: the S3-drop push toggle (a precondition, not a permission) --");
  {
    const { renderPushDestination } = await import("../src/screens/settings/push.ts");
    // s3 is the whole point of this case: canTogglePush is false for the s3 sink because the redacted
    // view carries no access key id, so the refusal here is a PRECONDITION rather than a permission.
    // A reason is no less essential for being about state instead of about who you are.
    const s3View: PushDestinationView = {
      present: true, enabled: true, sink: "s3", format: "ocsf",
      s3: { bucket: "audit-drop", region: "ap-southeast-2", prefix: "downpipes/" },
      trail: [],
    } as unknown as PushDestinationView;
    const engine = new Proxy(
      { getPush: () => Promise.resolve(s3View) },
      {
        get(t: Record<string, unknown>, prop: string | symbol) {
          if (typeof prop !== "string") return undefined;
          if (prop in t) return t[prop];
          return (...args: unknown[]) => {
            effects.push(`engine.${prop}(${args.length})`);
            return Promise.resolve({});
          };
        },
      },
    ) as unknown as EngineClient;
    setCaller(OWNER);
    const card = renderPushDestination(engine) as unknown as ShimNode;
    // The panel paints into its card only while the card is connected (paint-before-leave), so an
    // unconnected card would render nothing and every assertion below would pass vacuously.
    markConnected(card);
    await flushAsync();
    const toggle = byDp(card, "settings.button.push-state");
    ok("settings push toggle: the s3 view really did reach the toggle (not a vacuous skip)", toggle !== undefined);
    assertRefusedAndInert("settings push toggle", toggle, "re-collects the access key");
  }

  // =========================================================================
  // BATCH TWO: the declarative family, where the pair rode in an h() attrs object (often inside a
  // conditional spread) and the handler is attached on the allowed branch only. Same standard.
  // =========================================================================

  // -------------------------------------------------------------------------
  console.log("\n-- notifications: the shared gated primary button (notify.config) --");
  {
    const { primaryButton } = await import("../src/screens/notifications/shared.ts");
    const { ICON_PLUS } = await import("../src/lib/icons.ts");
    setCaller(VIEWER);
    const refused = primaryButton("Add a channel", ICON_PLUS, false, sink("notifications.onClick")) as unknown as ShimNode;
    assertRefusedAndInert("notifications primary", refused, "Requires");
    const live = primaryButton("Add a channel", ICON_PLUS, true, sink("notifications.onClick")) as unknown as ShimNode;
    assertLive("notifications primary", live);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- credentials: Track an item, and the pending-cleanup row's confirm --");
  {
    const { renderList, renderPendingCleanupRow } = await import("../src/screens/credentials/list.ts");
    setCaller(VIEWER);
    const refusedList = renderList(recordingEngine(), [], sink("credentials.reload")) as unknown as ShimNode;
    assertRefusedAndInert("credentials add", byDp(refusedList, "credentials.button.add#2"), "needs the Operator, Approver or Owner role");
    const row = { label: "cf-api-token", state: "pending-cleanup", lifecycle: "functional" } as never;
    const refusedRow = renderPendingCleanupRow(recordingEngine(), row, "readonly", sink("credentials.reload")) as unknown as ShimNode;
    assertRefusedAndInert("credentials cleanup confirm", byDp(refusedRow, "credentials.button.del#2"), "needs the Operator, Approver or Owner role");
    setCaller(OWNER);
    const liveList = renderList(recordingEngine(), [], sink("credentials.reload")) as unknown as ShimNode;
    const liveAdd = byDp(liveList, "credentials.button.add#1");
    ok("credentials add: the permitted caller's control is not refused and has a handler", liveAdd !== undefined && !disabledAnyWay(liveAdd) && clickListenerCount(liveAdd) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- security centre: the posture override action (posture.write) --");
  {
    const { renderPosture } = await import("../src/screens/security-centre/posture.ts");
    const report = {
      score: 50,
      generatedAt: "2026-08-05T00:00:00Z",
      checks: [{ id: "c1", title: "A check", severity: "high", status: "fail", autoStatus: "fail", control: "CIS 11.5", detail: "why", remediation: "do this", how: "measured" }],
    } as never;
    setCaller(VIEWER);
    const refused = renderPosture(recordingEngine(), report, sink("posture.reload")) as unknown as ShimNode;
    assertRefusedAndInert("security-centre override", byDp(refused, "security-centre.button.mk-btn#2"), "is Owner only");
    setCaller(OWNER);
    const live = renderPosture(recordingEngine(), report, sink("posture.reload")) as unknown as ShimNode;
    assertLive("security-centre override", byDp(live, "security-centre.button.mk-btn#1"));
  }

  // -------------------------------------------------------------------------
  console.log("\n-- sources: the account-browsing token Save (Owner) --");
  {
    const { tokenEntry } = await import("../src/screens/sources/token-entry.ts");
    setCaller(VIEWER);
    const refused = tokenEntry(recordingEngine(), false, "Verify and save", sink("sources.refresh")) as unknown as ShimNode;
    assertRefusedAndInert("sources token save", byDp(refused, "sources.button.save#3"), "Requires");
    setCaller(OWNER);
    const live = tokenEntry(recordingEngine(), true, "Verify and save", sink("sources.refresh")) as unknown as ShimNode;
    const liveBtn = byDp(live, "sources.button.save#2");
    ok("sources token save: the permitted caller's control is not refused and has a handler", liveBtn !== undefined && !disabledAnyWay(liveBtn) && clickListenerCount(liveBtn) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- restore: Verify restorability and Drill this run --");
  {
    const { renderProofCard } = await import("../src/screens/restore-flow/proof.ts");
    // runId "" is what makes both refusals fire without depending on the caller's capabilities, and it
    // is also the honest fixture: a run with no id is exactly the state whose reason a customer needs.
    const noIdRun = { runId: "", index: 1, status: "ok", startedAt: 0, finishedAt: 0 } as never;
    setCaller(OWNER);
    const refused = renderProofCard(recordingEngine(), noIdRun, "dp1") as unknown as ShimNode;
    assertRefusedAndInert("restore verify", byDp(refused, "restore-flow.button.verify"), "no");
    assertRefusedAndInert("restore drill", byDp(refused, "restore-flow.button.drill"), "no");
    const withIdRun = { runId: "r-1", index: 1, status: "ok", startedAt: 0, finishedAt: 0 } as never;
    const live = renderProofCard(recordingEngine(), withIdRun, "dp1") as unknown as ShimNode;
    const liveVerify = byDp(live, "restore-flow.button.verify");
    ok("restore verify: with a run id the control is live and wired", liveVerify !== undefined && !disabledAnyWay(liveVerify) && clickListenerCount(liveVerify) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- restore: the calendar's Next month at the current month --");
  {
    const { renderCalendarView } = await import("../src/screens/restore-flow/date-picker.ts");
    // This is the one site in the migration where the click was attached UNCONDITIONALLY, riding in
    // the same attrs object and relying on `disabled` for the browser to swallow it. It is therefore
    // the site where a careless migration would have handed a live action back, so the negative
    // control matters most here even though the action itself is only a month of paging.
    const args = {
      state: { id: "dp1", config: { name: "app db" } },
      allStates: [],
      grid: [],
      monthAnchorMs: Date.now(),
      selectedDay: null,
      onChangeDownpipe: null,
      onPrevMonth: sink("calendar.onPrevMonth"),
      onNextMonth: sink("calendar.onNextMonth"),
      onDayPick: sink("calendar.onDayPick"),
      onOpenRunPicker: sink("calendar.onOpenRunPicker"),
      onPickRun: sink("calendar.onPickRun"),
    } as never;
    const atCurrent = renderCalendarView(args) as unknown as ShimNode;
    assertRefusedAndInert("calendar next month", byDp(atCurrent, "restore-flow.button.next"), "current month");
    // Anti-vacuity: a month ago the same control must page.
    const pastArgs = { ...(args as unknown as Record<string, unknown>), monthAnchorMs: Date.now() - 45 * 24 * 60 * 60 * 1000 } as never;
    const past = renderCalendarView(pastArgs) as unknown as ShimNode;
    assertLive("calendar next month", byDp(past, "restore-flow.button.next"));
  }

  // -------------------------------------------------------------------------
  console.log("\n-- destinations: Verify and save (Owner) --");
  {
    const { destinationForm } = await import("../src/screens/destination-form.ts");
    setCaller(VIEWER);
    const fctx = { engineAccountId: null, engineR2Buckets: [], sourceR2Buckets: new Set<string>(), discoveryRead: true, downpipesRead: true } as never;
    const refused = destinationForm(recordingEngine(), fctx, { confirmReplace: false, onSaved: sink("destination.onSaved") } as never) as unknown as ShimNode;
    assertRefusedAndInert("destination save", byDp(refused, "destination-form.button.save#2"), "Requires");
    setCaller(OWNER);
    const live = destinationForm(recordingEngine(), fctx, { confirmReplace: false, onSaved: sink("destination.onSaved") } as never) as unknown as ShimNode;
    const liveBtn = byDp(live, "destination-form.button.save#1");
    ok("destination save: the permitted caller's control is not refused and has a handler", liveBtn !== undefined && !disabledAnyWay(liveBtn) && clickListenerCount(liveBtn) > 0);
  }

  // =========================================================================
  // BATCH THREE and FOUR: the higher-consequence screens, done last on purpose. The pattern and the
  // instrument were proven on benign controls first; these are identity, keys, licence and role
  // membership, where a refusal that became a live action is the whole risk of this migration.
  // =========================================================================

  // -------------------------------------------------------------------------
  console.log("\n-- identity: the four IdP connection controls (idp.manage) --");
  {
    const { renderConnections } = await import("../src/screens/idp-connections/list.ts");
    const { certRolloverSection } = await import("../src/screens/idp-connections/cert-rollover.ts");
    const conn = { id: "c1", label: "Okta", kind: "saml", enabled: true, certs: [], createdAt: "2026-01-01T00:00:00Z" } as never;
    setCaller(VIEWER);
    const refused = renderConnections(recordingEngine(SAML_URLS), [conn], false, sink("idp.reload")) as unknown as ShimNode;
    for (const dp of ["idp-connections.button.test-control", "idp-connections.button.toggle-control", "idp-connections.button.remove"]) {
      assertRefusedAndInert(`idp ${dp.split(".").pop()}`, byDp(refused, dp), "Requires");
    }
    const rollover = certRolloverSection(recordingEngine(), conn, false, sink("idp.reload")) as unknown as ShimNode;
    assertRefusedAndInert("idp cert rollover", byDp(rollover, "idp-connections.button.cert-rollover"), "Requires");
    setCaller(OWNER);
    const live = renderConnections(recordingEngine(SAML_URLS), [conn], true, sink("idp.reload")) as unknown as ShimNode;
    const liveToggle = byDp(live, "idp-connections.button.toggle-control");
    ok("idp toggle: the permitted caller's control is not refused and has a handler", liveToggle !== undefined && !disabledAnyWay(liveToggle) && clickListenerCount(liveToggle) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- licence: activation, removal, rollback and the pending verify --");
  {
    const { activationSection } = await import("../src/screens/licence/activation.ts");
    const { rollbackControl } = await import("../src/screens/licence/rollback.ts");
    const lic = { tier: "community", source: "none", present: false, consoleSet: true } as never;
    setCaller(VIEWER);
    const refused = activationSection(recordingEngine(), lic, sink("licence.reload"), "anchor") as unknown as ShimNode;
    assertRefusedAndInert("licence activate", byDp(refused, "licence.button.submit"), "Requires");
    const removeBtn = byDp(refused, "licence.button.remove");
    if (removeBtn !== undefined) assertRefusedAndInert("licence remove", removeBtn, "Requires");
    const rb = rollbackControl(recordingEngine(), { urgent: false } as never, sink("licence.reload")) as unknown as ShimNode;
    assertRefusedAndInert("licence rollback", byDp(rb, "licence.button.rollback"), "Requires");
    setCaller(OWNER);
    const live = activationSection(recordingEngine(), lic, sink("licence.reload"), "anchor") as unknown as ShimNode;
    const liveSubmit = byDp(live, "licence.button.submit");
    ok("licence activate: the permitted caller's control is not refused and has a handler", liveSubmit !== undefined && !disabledAnyWay(liveSubmit) && clickListenerCount(liveSubmit) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- keys: the ceremony and the break-glass rotation (Owner) --");
  {
    const { renderPostureTab } = await import("../src/screens/keys/posture.ts");
    const { renderRotationSection } = await import("../src/screens/keys/rotation.ts");
    setCaller(VIEWER);
    const posture = renderPostureTab(recordingEngine()) as unknown as ShimNode;
    await flushAsync();
    const gen = byDp(posture, "keys.button.generate") ?? byDp(posture, "keys.button.generate-operational");
    ok("keys: a ceremony control rendered for the refused caller (not a vacuous case)", gen !== undefined);
    assertRefusedAndInert("keys generate", gen, "Requires the Owner role");
    const rotation = renderRotationSection(recordingEngine()) as unknown as ShimNode;
    await flushAsync();
    assertRefusedAndInert("keys rotate", byDp(rotation, "keys.button.rotate"), "Requires the Owner role");
    setCaller(OWNER);
    const liveRotation = renderRotationSection(recordingEngine()) as unknown as ShimNode;
    await flushAsync();
    const liveRotate = byDp(liveRotation, "keys.button.rotate");
    ok("keys rotate: the Owner's control is not refused and has a handler", liveRotate !== undefined && !disabledAnyWay(liveRotate) && clickListenerCount(liveRotate) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- access: role membership (roles.write) --");
  {
    const { renderRolesTable } = await import("../src/screens/access-security/roles-members.ts");
    const rows = [{ email: "someone@example.test", role: "operator", active: true }] as never;
    setCaller(VIEWER);
    const refused = renderRolesTable(recordingEngine(), rows, sink("roles.reload"), {} as never) as unknown as ShimNode;
    assertRefusedAndInert("roles add member", byDp(refused, "access-security.button.add#2"), "Requires");
    setCaller(OWNER);
    const live = renderRolesTable(recordingEngine(), rows, sink("roles.reload"), {} as never) as unknown as ShimNode;
    const liveAdd = byDp(live, "access-security.button.add#1");
    ok("roles add member: the permitted caller's control is not refused and has a handler", liveAdd !== undefined && !disabledAnyWay(liveAdd) && clickListenerCount(liveAdd) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- access: the custom role builder (access.policy) --");
  {
    const { renderRolesPanel } = await import("../src/screens/access-security/roles.ts");
    setCaller(VIEWER);
    const refused = renderRolesPanel(recordingEngine()) as unknown as ShimNode;
    await flushAsync();
    assertRefusedAndInert("roles builder", byDp(refused, "access-security.button.builder"), "Requires");
    setCaller(OWNER);
    const live = renderRolesPanel(recordingEngine()) as unknown as ShimNode;
    await flushAsync();
    assertLive("roles builder", byDp(live, "access-security.button.builder"));
  }

  // -------------------------------------------------------------------------
  console.log("\n-- licence: the update preview, the live apply, and the pending verify --");
  {
    const { availableUpdateBody } = await import("../src/screens/licence/update-available-body.ts");
    const { pendingUpdateBody } = await import("../src/screens/licence/update-pending-body.ts");
    const env = { out: h("div"), reload: sink("update.reload"), restoreFocus: sink("update.restoreFocus"), canManage: false, destConfigured: true, ownVersion: "0.1.10", expectedConsoleVersion: "0.1.10" } as never;
    const updates = { available: true, current: "0.1.9", latest: "0.1.10", requiredSteps: [], components: null } as never;
    const refused = availableUpdateBody(recordingEngine(), updates, env) as unknown as ShimNode;
    assertRefusedAndInert("licence update preview", byDp(refused, "licence.button.preview"), "Requires");
    const updateBtn = byDp(refused, "licence.button.update");
    if (updateBtn !== undefined) assertRefusedAndInert("licence update apply", updateBtn, "Requires");
    else ok("licence update apply: the control rendered for the refused caller", false);
    const pending = pendingUpdateBody(recordingEngine(), { kind: "pending", toVersion: "0.1.10", recommendedVersion: "0.1.10" }, env) as unknown as ShimNode;
    assertRefusedAndInert("licence pending verify", byDp(pending, "licence.button.verify"), "Requires");
    // Anti-vacuity for the pair: with the capability, the same two controls are live and wired.
    const liveEnv = { ...(env as unknown as Record<string, unknown>), canManage: true, out: h("div") } as never;
    const live = availableUpdateBody(recordingEngine(), updates, liveEnv) as unknown as ShimNode;
    const livePreview = byDp(live, "licence.button.preview");
    const liveUpdate = byDp(live, "licence.button.update");
    ok("licence update preview: the permitted caller's control is live and wired", livePreview !== undefined && !disabledAnyWay(livePreview) && clickListenerCount(livePreview) > 0);
    ok("licence update apply: the permitted caller's control is live and wired", liveUpdate !== undefined && clickListenerCount(liveUpdate) > 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n-- onboarding: Generate my keys on the connect-keys card --");
  {
    // This is one of the two sites that wrote `disabled: true` AND `aria-disabled: "true"` on the same
    // button, which is the shape that looks migrated and is not: `disabled` takes the control out of the
    // tab order, so the ARIA state it advertises is announced to nobody.
    const { OB_CARDS_CONNECT_KEYS } = await import("../src/screens/onboarding/carousel-cards-connect-keys.ts");
    const card = OB_CARDS_CONNECT_KEYS.find((c) => c.id === "generate");
    if (card === undefined) {
      ok("onboarding connect-keys: the generate card is in the deck", false);
    } else {
      setCaller(VIEWER);
      const slot = h("div");
      const nav = { back: sink("onboarding.back"), advance: sink("onboarding.advance"), markPassed: sink("onboarding.markPassed") } as never;
      card.mount(slot, nav);
      await flushAsync();
      assertRefusedAndInert("onboarding generate keys", byDp(slot as unknown as ShimNode, "onboarding.button.generate"), "Requires the Owner role");
      setCaller(OWNER);
      const liveSlot = h("div");
      card.mount(liveSlot, nav);
      await flushAsync();
      // Anti-vacuity by HANDLER PRESENCE rather than by driving the click. The Owner's handler runs the
      // browser key ceremony, which touches no engine method and reaches no callback this suite owns, so
      // "the click reached something" would be measuring the fixture rather than the control. Handler
      // presence is the property that makes the zero-handlers assertion above mean anything.
      const liveGen = byDp(liveSlot as unknown as ShimNode, "onboarding.button.generate");
      ok("onboarding generate keys: the Owner's control is not refused and HAS a handler", liveGen !== undefined && !disabledAnyWay(liveGen) && ariaDisabled(liveGen) !== "true" && clickListenerCount(liveGen) > 0);
    }
  }

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} -- gate-refusal reachability (${checks} checks)`);
  if (failures > 0) process.exitCode = 1;
}

void main();
