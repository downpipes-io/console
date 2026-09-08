// GATED-ROUTE 202 DECODE: every console call site that reads a route the engine may answer with HTTP 202.
//
//   node test/validate-gated-202-decode.ts
//
// THE CLASS. The engine has two dual-control gates, and both answer an accepted-but-not-applied mutation
// with a 202 rather than a 200:
//
//   - the CHANGE-CONTROL gate (engine scheduler-do.ts gatedConfigMutation) -> 202 { queued, id, status,
//     contentHash }, read console-side by Transport.parseJsonOrPending;
//   - the OWNER-ACTION gate (engine scheduler-do.ts ownerActionJson / router-core.ts
//     ownerActionQueuedResponse) -> 202 { ownerActionQueued, id, status }, read console-side by
//     Transport.parseJsonOrOwnerAction.
//
// Transport.parseJson (client-transport.ts) throws ONLY on a non-2xx. A 202 is a 2xx, so a call site that
// reads a gated route through parseJson parses the QUEUE RECEIPT as if it were the applied record. Whatever
// field the screen then reads is absent, and what the operator is told depends on which field it was:
//
//   - a missing `ok` read as false          -> a FALSE FAILURE for a request the engine accepted;
//   - a missing `retired` / a bare refresh  -> a FALSE SUCCESS for a change that has not happened;
//   - a missing `counts`                    -> a raw TypeError where a queued message belonged;
//   - a missing `outcome`                   -> a retry storm, then "the outcome could not be read".
//
// A false failure is the worst of them on a mutation the operator can repeat: it drives the WRONG remedial
// action (retry, or conclude the setting is unchanged) for a change that is about to take effect.
//
// This validator pins BOTH DIRECTIONS at every site the sweep found decoding a 202-capable route, because
// half a proof is how this class survived: a 202 must resolve to the queued/pending discriminant, and a real
// engine refusal must STILL throw with the engine's own reason.
//
// AND IT PINS EVERY SCREEN, not just the named one. Sections A and B are CLIENT-layer proofs: they show the
// decoder resolves a 202 to the queued discriminant. They say nothing about whether the screen READS that
// discriminant, so with only those, all five screens' queued branches could be deleted and this file would
// still pass. Sections C and D close that: C drives the cf-config capture-mode select, and D drives the other
// four (the coverage-inventory modal, the retire-break-glass control, the account chooser, the SAML
// signing-certificate rollover) through their real render and their real handlers. Each of the five is
// mutation-proven: delete its queued branch and this file goes red on that branch alone.
//
// Australian English, no em dashes, precise claims.

import { installDomShim, textOf, flushAsync, qs, qsa, markConnected, type ShimNode } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

const { EngineClient } = await import("../src/lib/api/client.ts");
const { cfConfigDiscoverySection } = await import("../src/screens/sources-downpipes/detail-config-section.ts");
const nav = await import("../src/lib/nav.ts");
// The three D-section screens import the nav bridge (goSignedOut / navigate). Installing it once here keeps a
// queued-toast "View" action or an unauthorised branch from throwing.
nav.installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// stubFetch installs a single canned Response for the next call(s) and returns the restore function.
// The body is served as text() (what Transport reads) and json() (what the clone-readers read).
function stubFetch(status: number, body: unknown): () => void {
  const orig = globalThis.fetch;
  const text = JSON.stringify(body);
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text) as unknown),
      clone() {
        return this as unknown;
      },
    } as unknown as Response)) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

const engine = new EngineClient("https://engine.example.com");

// The change-control gate's 202 body and the owner-action gate's 202 body, byte-shaped as the engine sends
// them (scheduler-do.ts gatedConfigMutation / ownerActionJson).
const QUEUED_CHANGE = { queued: true, id: "chg_1", status: "pending", contentHash: "h" };
const QUEUED_OWNER = { ownerActionQueued: true, id: "oa_1", status: "pending" };
// A real engine refusal: a 400 carrying the engine's coarse reason. The failure path must still fire, and
// must still carry the reason, on every one of these sites.
const REFUSAL = { error: "that is not allowed here" };

async function threw(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

console.log("-- (A) the change-control gate's 202, at every site that reads a gated config mutation --");

// A1. cf-config capture mode (engine kind `cf-config-mode-set`, scheduler-do-routing.ts POST /cf-config/mode).
// THE NAMED SITE: a queued 202 used to arrive with no `ok`, and the select's else branch told the operator
// the capture mode could not be changed.
{
  let restore = stubFetch(202, QUEUED_CHANGE);
  const res = await engine.setCfConfigMode("dp1", "manual");
  restore();
  ok("(A1a) setCfConfigMode resolves a 202 to pending, never to an ok-less record", res.status === "pending" && res.changeId === "chg_1");
  restore = stubFetch(200, { ok: true });
  const applied = await engine.setCfConfigMode("dp1", "manual");
  restore();
  ok("(A1b) the gate-off 200 still resolves to the applied record", applied.status === "applied" && applied.value.ok === true);
  restore = stubFetch(400, REFUSAL);
  const msg = await threw(() => engine.setCfConfigMode("dp1", "manual"));
  restore();
  ok("(A1c) a real refusal STILL throws, carrying the engine's reason", (msg ?? "").includes("that is not allowed here"));
}

// A2. coverage inventory (engine kind `coverage-inventory`, scheduler-do-routing-signals.ts
// POST /coverage/inventory). A queued 202 carries no `counts`, and the security centre destructured it.
{
  let restore = stubFetch(202, QUEUED_CHANGE);
  const res = await engine.setCoverageInventory({} as never);
  restore();
  ok("(A2a) setCoverageInventory resolves a 202 to pending, never to a counts-less record", res.status === "pending" && res.changeId === "chg_1");
  restore = stubFetch(200, { counts: { kv: 1, r2: 0, d1: 0, secrets: 0 } });
  const applied = await engine.setCoverageInventory({} as never);
  restore();
  ok("(A2b) the gate-off 200 still resolves to the stored counts", applied.status === "applied" && applied.value.counts.kv === 1);
  restore = stubFetch(400, REFUSAL);
  const msg = await threw(() => engine.setCoverageInventory({} as never));
  restore();
  ok("(A2c) a real refusal STILL throws, carrying the engine's reason", (msg ?? "").includes("that is not allowed here"));
}

console.log("\n-- (B) the owner-action gate's 202, at every site that reads a gated owner mutation --");

// B1. discovery accounts (engine kind `discovery-accounts-set`, scheduler-do-routing-config.ts
// POST /sources/discovery-accounts). Its sibling one route over, setDiscoveryToken, has always decoded this.
{
  let restore = stubFetch(202, QUEUED_OWNER);
  const res = await engine.setDiscoveryAccounts(["acc1"], "acc1");
  restore();
  ok("(B1a) setDiscoveryAccounts resolves a 202 to queued, never to a discovery status", res.status === "queued" && res.queued.id === "oa_1");
  restore = stubFetch(200, { present: true });
  const applied = await engine.setDiscoveryAccounts(["acc1"], "acc1");
  restore();
  ok("(B1b) the gate-off 200 still resolves to the discovery status", applied.status === "result");
  restore = stubFetch(400, REFUSAL);
  const msg = await threw(() => engine.setDiscoveryAccounts(["acc1"], "acc1"));
  restore();
  ok("(B1c) a real refusal STILL throws, carrying the engine's reason", (msg ?? "").includes("that is not allowed here"));
}

// B2. break-glass retire (engine kind `break-glass-retire`, scheduler-do-routing-config.ts
// POST /policy/break-glass-retired). The worst false success in the set: the screen said the static token
// could no longer sign in while it still could.
{
  let restore = stubFetch(202, QUEUED_OWNER);
  const res = await engine.retireBreakGlassToken();
  restore();
  ok("(B2a) retireBreakGlassToken resolves a 202 to queued, never to a retired record", res.status === "queued" && res.queued.id === "oa_1");
  restore = stubFetch(200, { retired: true });
  const applied = await engine.retireBreakGlassToken();
  restore();
  ok("(B2b) the gate-off 200 still resolves to retired:true", applied.status === "result" && applied.value.retired === true);
  restore = stubFetch(400, { error: "no other way in exists yet" });
  const msg = await threw(() => engine.retireBreakGlassToken());
  restore();
  ok("(B2c) the refuse-until-break-glass reason STILL reaches the screen", (msg ?? "").includes("no other way in exists yet"));
}

// B3. update settle, the KEEP direction (engine kind `update-settle`, router-updates.ts). A queued 202 has
// no `outcome`, which the retry ladder read as "not yet" and re-submitted.
{
  let restore = stubFetch(202, QUEUED_OWNER);
  const res = await engine.settleUpdate("tok");
  restore();
  ok("(B3a) settleUpdate resolves a 202 to queued, never to an outcome-less settle", res.status === "queued" && res.id === "oa_1");
  restore = stubFetch(200, { outcome: "applied" });
  const applied = await engine.settleUpdate("tok");
  restore();
  ok("(B3b) the gate-off 200 still resolves to the settle outcome", applied.status === "result" && applied.value.outcome === "applied");
  restore = stubFetch(400, REFUSAL);
  const msg = await threw(() => engine.settleUpdate("tok"));
  restore();
  ok("(B3c) a real refusal STILL throws, carrying the engine's reason", (msg ?? "").includes("that is not allowed here"));
}

// B4. SAML signing-certificate rollover (engine kind `idp-conn-cert`, router-identity.ts POST
// /admin/idp/connections/cert). This one is not a site that decoded the 202 wrongly: until the console gained
// a caller at all there was NO site, so the whole rollover was terminal-only. The decoder is pinned here at
// the moment the caller lands, so it can never be added back through parseJson.
{
  let restore = stubFetch(202, QUEUED_OWNER);
  const res = await engine.rolloverIdpSigningCerts("c1", "append", ["-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----"]);
  restore();
  ok("(B4a) rolloverIdpSigningCerts resolves a 202 to queued, never to an ok-less record", res.status === "queued" && res.queued.id === "oa_1");
  restore = stubFetch(200, { ok: true });
  const applied = await engine.rolloverIdpSigningCerts("c1", "append", ["-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----"]);
  restore();
  ok("(B4b) the gate-off 200 still resolves to the applied record", applied.status === "result" && applied.value.ok === true);
  restore = stubFetch(400, { error: "cert rollover applies only to a SAML connection" });
  const msg = await threw(() => engine.rolloverIdpSigningCerts("c1", "replace", ["-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----"]));
  restore();
  ok("(B4c) a real refusal STILL throws, carrying the engine's reason", (msg ?? "").includes("cert rollover applies only to a SAML connection"));
}

// B4d. The two modes are two DIFFERENT bodies, and sending the wrong one at the wrong time is what breaks
// sign-in: append merges onto the pinned set, replace prunes everything not pasted. The client is the only
// place that choice is encoded, so the body it puts on the wire is pinned rather than assumed.
{
  const seen: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, init?: { body?: unknown }) => {
    seen.push(String(init?.body ?? ""));
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      text: () => Promise.resolve('{"ok":true}'), json: () => Promise.resolve({ ok: true }),
      clone() { return this as unknown; },
    } as unknown as Response);
  }) as typeof fetch;
  await engine.rolloverIdpSigningCerts("c1", "append", ["PEM-A"]);
  await engine.rolloverIdpSigningCerts("c1", "replace", ["PEM-A"]);
  globalThis.fetch = orig;
  ok("(B4d) append sends addCerts, so the pinned set is merged rather than truncated", seen[0] === JSON.stringify({ connId: "c1", addCerts: ["PEM-A"] }));
  ok("(B4e) replace sends certs, so the retired certificate is pruned only when asked", seen[1] === JSON.stringify({ connId: "c1", certs: ["PEM-A"] }));
}

console.log("\n-- (C) the named site's UI: the capture-mode select, through its real change handler --");

// The select is built by the real cfConfigDiscoverySection and its change handler is the code under test.
// A fake engine serves the three answers in turn; the toast text is read out of the document.
interface ModeHandle {
  sel: { value: string; disabled: boolean; dispatchEvent: (e: unknown) => void };
  reloads: () => number;
}
function openModeSection(setMode: () => Promise<unknown>): ModeHandle {
  let reloads = 0;
  const fake = {
    setCfConfigMode: () => setMode(),
    rediscoverCfConfig: () => Promise.reject(new Error("not used")),
    listDestinations: () => Promise.reject(new Error("not used")),
  } as unknown as InstanceType<typeof EngineClient>;
  const dp = { id: "dp1", name: "cf", source: { type: "cf-config", cfConfigMode: "auto" } } as never;
  const state = { config: dp, cfConfigDiscovery: null } as never;
  const node = cfConfigDiscoverySection(fake, dp, state, true, () => {
    reloads++;
  });
  const doc = (globalThis as unknown as { document: { body: { appendChild: (n: unknown) => void } } }).document;
  doc.body.appendChild(node);
  const sel = findSelect(node);
  return { sel, reloads: () => reloads };
}
// findSelect walks the built node for the capture-mode select by its aria-label (the same handle the
// token-source validator uses), rather than by position, so a layout change cannot silently point this
// test at a different control.
function findSelect(node: unknown): ModeHandle["sel"] {
  const stack: Array<Record<string, unknown>> = [node as Record<string, unknown>];
  while (stack.length > 0) {
    const n = stack.pop() as Record<string, unknown>;
    const attrs = n.getAttribute as ((k: string) => string | null) | undefined;
    if (typeof attrs === "function" && attrs.call(n, "aria-label") === "Cloudflare config capture mode") {
      return n as unknown as ModeHandle["sel"];
    }
    const kids = n.childNodes as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(kids)) stack.push(...kids);
  }
  throw new Error("capture-mode select not found");
}
function bodyText(): string {
  return textOf((globalThis as unknown as { document: { body: unknown } }).document.body as never);
}
function countOf(needle: string): number {
  return (bodyText().match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

// C1. THE DEFECT, at the UI. A queued 202 must raise the queued-for-approval toast and must NOT raise the
// could-not-change failure toast. Both halves are counted as a DELTA, because a toast outlives the node
// that raised it.
{
  const failBefore = countOf("Could not change capture mode");
  const queuedBefore = countOf("queued for approval");
  const h = openModeSection(() => Promise.resolve({ status: "pending", changeId: "chg_1", raw: {} }));
  h.sel.value = "manual";
  h.sel.dispatchEvent(makeEvent({ type: "change" }));
  await flushAsync();
  ok("(C1a) a queued 202 raises the queued-for-approval toast", countOf("queued for approval") === queuedBefore + 1);
  ok("(C1b) a queued 202 raises NO 'could not change capture mode' failure toast", countOf("Could not change capture mode") === failBefore);
  ok("(C1c) the select is reverted, because the mode has NOT changed yet", h.sel.value === "auto");
  ok("(C1d) no section reload on the queued path (nothing to re-read)", h.reloads() === 0);
}

// C2. THE FAILURE PATH STILL FIRES. An engine that answers the applied shape with ok:false is a real
// failure, and it must still say so: a fix that swallowed this would be the same defect pointing the other
// way.
{
  const failBefore = countOf("Could not change capture mode");
  const h = openModeSection(() => Promise.resolve({ status: "applied", value: { ok: false, error: "surface set is empty" } }));
  h.sel.value = "manual";
  h.sel.dispatchEvent(makeEvent({ type: "change" }));
  await flushAsync();
  ok("(C2a) a real ok:false STILL raises the failure toast", countOf("Could not change capture mode") === failBefore + 1);
  ok("(C2b) the engine's own reason is carried into it", bodyText().includes("surface set is empty"));
  ok("(C2c) the select is reverted on the failure path", h.sel.value === "auto");
}

// C3. THE SUCCESS PATH IS UNCHANGED. The gate-off 200 must still confirm and reload.
{
  const h = openModeSection(() => Promise.resolve({ status: "applied", value: { ok: true } }));
  h.sel.value = "manual";
  h.sel.dispatchEvent(makeEvent({ type: "change" }));
  await flushAsync();
  ok("(C3a) an applied ok:true confirms the new mode", bodyText().includes("Capture mode set to manual."));
  ok("(C3b) the section reloads onto the new mode", h.reloads() === 1);
}

console.log("\n-- (D) the other four screens' queued branches, at the SCREEN --");

// Sections A and B pin the CLIENT. A screen that ignores what the client returns is still broken, and until
// this section existed the queued branch in each of these four files could be deleted with this validator
// still green. Each case drives the real render, clicks the real control, and reads the toast out of the
// document, so deleting the branch it names turns this file red.

const docBody = (): ShimNode => (globalThis as unknown as { document: { body: ShimNode } }).document.body;

// clickModalButton drives the REAL modal (openModal / confirmModal) rather than stubbing it, so the
// confirm-before-mutate ordering stays part of what is proven here.
async function clickModalButton(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(docBody(), ".dialog--modal");
  if (!surface) throw new Error(`clickModalButton: no open modal for "${label}"`);
  const btn = qsa(surface, "button").find((b) => textOf(b).includes(label));
  if (!btn) throw new Error(`clickModalButton: no button labelled "${label}" in the open modal`);
  btn.click();
  await flushAsync();
}

const QUEUED_OWNER_RESULT = { status: "queued", queued: { ownerActionQueued: true, id: "oa_1", status: "pending" } };
// Change management is OFF in these fixtures, so requireChange proceeds without a prompt and the screen's own
// queued branch is what the assertions land on.
const NO_CHANGE_NUMBER = () => Promise.resolve({ requireConfigApproval: false, requireChangeNumber: false });

// D1. security-centre.ts, the coverage-inventory modal (change-control gate). The queued 202 carries no
// `counts`, and the destructure below the branch is a raw TypeError, so this case would not merely assert a
// wrong toast without the branch: it would throw.
{
  const { openPopulateInventoryModal } = await import("../src/screens/security-centre.ts");
  const savedBefore = countOf("Inventory saved");
  const queuedBefore = countOf("queued for approval");
  let reloads = 0;
  const engineStub = { setCoverageInventory: () => Promise.resolve({ status: "pending", changeId: "chg_1", raw: {} }) } as never;
  openPopulateInventoryModal(engineStub, () => {
    reloads++;
  });
  await clickModalButton("Save inventory");
  ok("(D1a) a queued inventory save raises the queued-for-approval toast", countOf("queued for approval") === queuedBefore + 1);
  ok("(D1b) it names the inventory, so the operator knows WHAT is queued", bodyText().includes("This inventory is queued for approval"));
  ok("(D1c) it does NOT claim the inventory was saved", countOf("Inventory saved") === savedBefore);
  ok("(D1d) no gap-view reload on the queued path (nothing was stored)", reloads === 0);
}

// D1b. The gate-off 200 still confirms the stored counts and reloads, so the branch above cannot be a
// blanket swallow of the success path.
{
  const { openPopulateInventoryModal } = await import("../src/screens/security-centre.ts");
  const savedBefore = countOf("Inventory saved");
  let reloads = 0;
  const engineStub = { setCoverageInventory: () => Promise.resolve({ status: "applied", value: { counts: { kv: 2, r2: 1, d1: 0, secrets: 3 } } }) } as never;
  openPopulateInventoryModal(engineStub, () => {
    reloads++;
  });
  await clickModalButton("Save inventory");
  ok("(D1e) an applied 200 still confirms the stored counts", countOf("Inventory saved") === savedBefore + 1);
  ok("(D1f) the counts in the toast are the engine's own", bodyText().includes("2 KV, 1 R2, 0 D1, 3 secrets"));
  ok("(D1g) the gap view reloads on the applied path", reloads === 1);
}

// D2. security-centre/access.ts, the retire-break-glass control (owner-action gate). The worst false success
// in the set: the screen said the static token could no longer sign in while it still could.
{
  const { renderRecoveryAccess } = await import("../src/screens/security-centre/access.ts");
  const retiredBefore = countOf("The static token can no longer sign in.");
  const queuedBefore = countOf("queued for a second owner to approve");
  let reloads = 0;
  const engineStub = {
    retireBreakGlassToken: () => Promise.resolve(QUEUED_OWNER_RESULT),
    getConfigApprovalPolicy: NO_CHANGE_NUMBER,
  } as never;
  const status = { recoveryCodesRemaining: 8, breakGlassTokenRetired: false, tokenFallbackDisabled: false } as never;
  const root = renderRecoveryAccess(engineStub, status, true, () => {
    reloads++;
  });
  markConnected(root);
  const retireBtn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "security-centre.button.retire#1");
  if (!retireBtn) throw new Error("(D2) the retire control did not render");
  retireBtn.click();
  await clickModalButton("Retire token");
  ok("(D2a) a queued retire raises the queued-for-a-second-owner toast", countOf("queued for a second owner to approve") === queuedBefore + 1);
  ok("(D2b) it names the retire, so the operator knows WHAT is queued", bodyText().includes("Retiring the break-glass token is queued"));
  ok(
    "(D2c) it does NOT claim the static token can no longer sign in, because it still can",
    countOf("The static token can no longer sign in.") === retiredBefore,
  );
  ok("(D2d) the card still reloads, so the state line is re-read rather than assumed", reloads === 1);
}

// D2b. The gate-off 200 still says the token is retired, so the branch above is not swallowing the real one.
{
  const { renderRecoveryAccess } = await import("../src/screens/security-centre/access.ts");
  const retiredBefore = countOf("The static token can no longer sign in.");
  const engineStub = {
    retireBreakGlassToken: () => Promise.resolve({ status: "result", value: { retired: true } }),
    getConfigApprovalPolicy: NO_CHANGE_NUMBER,
  } as never;
  const status = { recoveryCodesRemaining: 8, breakGlassTokenRetired: false, tokenFallbackDisabled: false } as never;
  const root = renderRecoveryAccess(engineStub, status, true, () => {});
  markConnected(root);
  const retireBtn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "security-centre.button.retire#1");
  if (!retireBtn) throw new Error("(D2b) the retire control did not render");
  retireBtn.click();
  await clickModalButton("Retire token");
  ok("(D2e) an applied 200 STILL says the static token can no longer sign in", countOf("The static token can no longer sign in.") === retiredBefore + 1);
}

// D3. sources/account.ts, the account chooser (owner-action gate). The queued answer used to be cast to a
// DiscoveryStatus and the panel simply refreshed, repainting the OLD selection with nothing said.
const DISC_ACCOUNTS = { present: true, tokenPresent: true, accountsSeen: [{ id: "acc-1", name: "Prod" }, { id: "acc-2", name: "Staging" }], selected: ["acc-1"], engineAccountId: "acc-1" };
const FOUND_TOKEN_PRESENT = { bound: { kv: [], r2: [], d1: [], secrets: [] }, tokenPresent: true, engineAccountId: "acc-1", accounts: [], accountErrors: [] };

// openChooser renders the real accountTier, opens the chooser and returns handles onto its live controls.
async function openChooser(setDiscoveryAccounts: () => Promise<unknown>): Promise<{
  refreshes: () => number;
  calls: () => number;
  boxFor: (id: string) => { checked: boolean } | undefined;
  save: () => void;
}> {
  const { accountTier } = await import("../src/screens/sources/account.ts");
  let refreshes = 0;
  let calls = 0;
  const engineStub = {
    getDiscoveryStatus: () => Promise.resolve(DISC_ACCOUNTS),
    getConfigApprovalPolicy: NO_CHANGE_NUMBER,
    setDiscoveryAccounts: () => {
      calls++;
      return setDiscoveryAccounts();
    },
  } as never;
  const root = accountTier(engineStub, FOUND_TOKEN_PRESENT as never, new Set() as never, () => {
    refreshes++;
  }, true, { setWaitPoll: () => {}, stopWaitPoll: () => {}, setOpenAdd: () => {} } as never);
  markConnected(root);
  await flushAsync(); // the management row's getDiscoveryStatus resolves and mounts the chooser trigger
  const choose = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "sources.button.choose");
  if (!choose) throw new Error("(D3) the chooser trigger did not render");
  choose.click();
  return {
    refreshes: () => refreshes,
    calls: () => calls,
    // The browse checkbox carries id `disc-browse-<accountId>`; the radio beside it does not.
    boxFor: (id) => qsa(root, "input").find((n) => n.getAttribute("id") === `disc-browse-${id}`) as unknown as { checked: boolean } | undefined,
    save: () => {
      const btn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "sources.button.save#1");
      if (!btn) throw new Error("(D3) the chooser save did not render");
      btn.click();
    },
  };
}

{
  const queuedBefore = countOf("queued for a second owner to approve");
  const h2 = await openChooser(() => Promise.resolve(QUEUED_OWNER_RESULT));
  const staging = h2.boxFor("acc-2");
  if (!staging) throw new Error("(D3) the acc-2 browse checkbox did not render");
  staging.checked = true;
  h2.save();
  await flushAsync();
  ok("(D3a) the engine was called once", h2.calls() === 1);
  ok("(D3b) a queued account change raises the queued-for-a-second-owner toast", countOf("queued for a second owner to approve") === queuedBefore + 1);
  ok("(D3c) it names the account change, so the operator knows WHAT is queued", bodyText().includes("Changing the browsed accounts is queued"));
  ok("(D3d) no screen refresh on the queued path: it would close the chooser and leave the toast the only trace", h2.refreshes() === 0);
  // The consistency half. The engine stored nothing, so the ticks must go back to the stored selection,
  // exactly as the capture-mode select reverts one screen over (C1c).
  ok("(D3e) the newly ticked account is put BACK, because the stored selection has not moved", h2.boxFor("acc-2")?.checked !== true);
  ok("(D3f) the already-browsed account is still ticked, so the revert restores rather than clears", h2.boxFor("acc-1")?.checked === true);
}

{
  // The gate-off 200 still refreshes onto the newly stored selection.
  const h2 = await openChooser(() => Promise.resolve({ status: "result", value: { present: true } }));
  const staging = h2.boxFor("acc-2");
  if (!staging) throw new Error("(D3b) the acc-2 browse checkbox did not render");
  staging.checked = true;
  h2.save();
  await flushAsync();
  ok("(D3g) an applied 200 refreshes the screen onto the stored selection", h2.refreshes() === 1);
}

// D4. idp-connections/cert-rollover.ts, the SAML signing-certificate rollover (owner-action gate). The other
// four cases in this file are sites that decoded a 202 wrongly. This one is the site that did not exist: the
// engine has served POST /admin/idp/connections/cert for a while and no console code called it, so the only
// portal path through a rotation was remove-and-re-add, which ends every session signed in through the
// connection. Pinned AT THE SCREEN, not only at the client (B4), because a client that decodes the queue
// receipt correctly proves nothing about whether the operator is told: a false success here says the
// provider's new signing key is trusted while the pinned set is unchanged, and on the strength of it the old
// key gets retired at the IdP and every sign-in stops.
const SAML_CONN = { id: "c1", kind: "saml", label: "Okta", enabled: true, idpEntityId: "https://idp.example", emailVerifiedPolicy: "require-flag", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "" };
const ONE_PEM = "-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----";

// openRollover renders the REAL certRolloverSection and returns handles onto its live controls.
async function openRollover(rollover: () => Promise<unknown>): Promise<{
  reloads: () => number;
  calls: () => number;
  paste: (text: string) => void;
  mode: (v: string) => void;
  apply: () => void;
  errorText: () => string;
}> {
  const { certRolloverSection } = await import("../src/screens/idp-connections/cert-rollover.ts");
  let reloads = 0;
  let calls = 0;
  const engineStub = {
    getConfigApprovalPolicy: NO_CHANGE_NUMBER,
    rolloverIdpSigningCerts: () => {
      calls++;
      return rollover();
    },
  } as never;
  const root = certRolloverSection(engineStub, SAML_CONN as never, true, () => {
    reloads++;
  });
  markConnected(root);
  const box = qsa(root, "textarea").find((n) => n.getAttribute("id") === "saml-rollover-certs");
  if (!box) throw new Error("(D4) the rollover paste box did not render");
  const sel = qsa(root, "select").find((n) => n.getAttribute("id") === "saml-rollover-mode");
  if (!sel) throw new Error("(D4) the rollover mode picker did not render");
  return {
    reloads: () => reloads,
    calls: () => calls,
    paste: (text) => {
      (box as unknown as { value: string }).value = text;
    },
    mode: (v) => {
      (sel as unknown as { value: string }).value = v;
    },
    apply: () => {
      const btn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "idp-connections.button.cert-rollover");
      if (!btn) throw new Error("(D4) the rollover apply button did not render");
      btn.click();
    },
    errorText: () => textOf(root),
  };
}

{
  const queuedBefore = countOf("queued for a second owner to approve");
  const trustedBefore = countOf("now also trusts the certificate");
  const h4 = await openRollover(() => Promise.resolve(QUEUED_OWNER_RESULT));
  h4.paste(ONE_PEM);
  h4.apply();
  await flushAsync();
  ok("(D4a) the engine was called once", h4.calls() === 1);
  ok("(D4b) a queued rollover raises the queued-for-a-second-owner toast", countOf("queued for a second owner to approve") === queuedBefore + 1);
  ok("(D4c) it names the rollover and the connection, so the operator knows WHAT is queued", bodyText().includes("Rolling over the signing certificate on Okta is queued"));
  ok("(D4d) it does NOT claim the new certificate is trusted, because the pinned set has not moved", countOf("now also trusts the certificate") === trustedBefore);
  ok("(D4e) no card reload on the queued path (nothing was stored)", h4.reloads() === 0);
}

{
  // The gate-off 200 still confirms the rollover and reloads, so the queued branch is not swallowing the
  // real success path. The zero-downtime claim is part of the copy, because it is the reason this control
  // exists rather than remove-and-re-add.
  const trustedBefore = countOf("now also trusts the certificate");
  const h4 = await openRollover(() => Promise.resolve({ status: "result", value: { ok: true } }));
  h4.paste(ONE_PEM);
  h4.apply();
  await flushAsync();
  ok("(D4f) an applied 200 confirms the appended certificate", countOf("now also trusts the certificate") === trustedBefore + 1);
  ok("(D4g) and says nobody was signed out, which is the whole point of the in-place edit", bodyText().includes("Nobody was signed out."));
  ok("(D4h) the card reloads on the applied path", h4.reloads() === 1);
}

{
  // A real engine refusal still reaches the operator inline, carrying the engine's own reason.
  const h4 = await openRollover(() => Promise.resolve({ status: "result", value: { ok: false, reason: "connection not found" } }));
  h4.paste(ONE_PEM);
  h4.apply();
  await flushAsync();
  ok("(D4i) an ok:false refusal is shown inline with the engine's reason", h4.errorText().includes("Connection not found"));
  ok("(D4j) no reload on the refusal path", h4.reloads() === 0);
}

{
  // The mode picker decides which body goes on the wire, and the confirmation must match the step taken:
  // replace PRUNES every certificate not pasted, so telling an operator it was merely added would be wrong.
  const prunedBefore = countOf("now pins only the certificate");
  const h4 = await openRollover(() => Promise.resolve({ status: "result", value: { ok: true } }));
  h4.mode("replace");
  h4.paste(ONE_PEM);
  h4.apply();
  await flushAsync();
  ok("(D4k) replace confirms that the pinned set is now only what was pasted", countOf("now pins only the certificate") === prunedBefore + 1);
}

{
  // The console's own refusal, before any request: a paste whose END line an editor mangled yields zero
  // complete blocks, and submitting it would silently store nothing. Nothing must reach the engine.
  const h4 = await openRollover(() => Promise.reject(new Error("(D4) the engine must not be called")));
  h4.paste("-----BEGIN CERTIFICATE-----\nMIIBexample\n");
  h4.apply();
  await flushAsync();
  ok("(D4l) a paste with no complete PEM block never reaches the engine", h4.calls() === 0);
}

console.log(failures === 0 ? "\nGATED-202-DECODE PASS" : `\nGATED-202-DECODE: ${failures} FAILED`);
process.exit(failures === 0 && checks > 0 ? 0 : 1);
