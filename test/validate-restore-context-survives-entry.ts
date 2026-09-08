// TC-restore-context-survives-entry: a restore begun by TYPING a run id on the runless /restore landing
// must plan against everything the operator typed. Run with:
//   node test/validate-restore-context-survives-entry.ts
//
// WHY THIS EXISTS. renderRestoreFlow's dry-run has an R2b step that, on the runless landing, navigates to
// /restore/:runId as soon as the FIRST plan comes back ok, and returns without painting it. The router
// re-resolves on every navigate, so /restore/:runId re-mounts the whole flow from empty fields and the
// prefillRun branch fires a SECOND dry-run. That second request is the one whose plan PAINTS, so anything
// the re-mount cannot rebuild is silently dropped from the plan the operator reviews, approves and applies.
//
// On this landing the re-mount rebuilds the run id and nothing else. The two edit tokens cannot be
// persisted (draft.ts forbids a secret in a draft and there is no secure browser store to put one in), the
// blast-radius target is deliberately never persisted, and the per-run scope draft is never WRITTEN here at
// all: flow.ts keys it on the run id known at mount time, and on the runless landing there is none.
//
// Four symptoms, each captured as both request bodies:
//   cfConfig  POST 1 carried the token and earned a 65-surface diff; POST 2 carried runId alone and painted
//             "This plan writes nothing, so there is nothing to apply".
//   media     the same, over a media edit token.
//   target    POST 1 carried target.binding; POST 2 carried runId alone, so the plan that painted writes
//             every record back over the LIVE ORIGINAL bindings, the opposite of the redirect chosen, and
//             the redirect's own type-to-confirm never fires because the held plan is not a redirect.
//   scope     POST 1 carried include/exclude/maxRecords; POST 2 carried runId alone, so a capped, prefixed
//             restore plans and applies UNCAPPED over every record.
//
// Entering at /restore/:runId directly skips the branch and works in every case, which is why the screen
// never looked wrong.
//
// This file captures the REQUEST BODIES the real screen sends rather than reading the screen, because the
// screen is exactly what lied: the second, stripped request is indistinguishable from an ordinary restore,
// and the engine is right about it.
//
// The invariant now gated: the request whose plan is PAINTED carries everything the operator supplied. The
// R2b bookmarkable URL is kept for a restore that really is just a run id, and dropped for one carrying
// anything the address bar cannot hold, because a shared link would land the recipient on a different plan.
//
// THREE MORE ENTRIES INTO THE SAME DEFECT, found by sweeping the console for the same shape, each
// captured the same way, by capturing request bodies through the real components:
//   picker    the runless landing's LEAD affordance, "Choose from recent runs", deep-linked to
//             /restore/:runId unconditionally. With include/max typed, a redirect chosen and an edit token
//             pasted, the only request that reached the engine was {"runId":"..."} and every field came back
//             empty. The break-glass panel's copy of this picker had always passed an onPick that keeps the
//             run in place; the standard flow had not.
//   calendar  "Browse by date" reaches the same navigation through its own time rows, so it dropped the same
//             context, and its "Browse recent runs instead" link hands to the picker above.
//   re-entry  "Restore just this" on a plan row re-mounts the pick form IN PLACE (no navigation at all) and
//             auto-runs its own dry-run. It carried runId + recordName and NOT the redirect target, so
//             narrowing a redirected restore to one record wrote that record back over its LIVE ORIGINAL
//             binding, with no type-to-confirm because the new plan was not a redirect. confirm.ts's
//             retry-subset re-entry had always carried the target; these two sites had not.

import { flushAsync, installDomShim, markConnected, qs, qsa } from "./dom-shim.ts";
import type { ShimEvent } from "./dom-shim-types.ts";

installDomShim();

import type { EngineClient, RestorePlan, RestoreRequest } from "../src/api.ts";
import { installNav } from "../src/lib/nav.ts";
import { renderRestoreFlow } from "../src/screens/restore-flow/flow.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const RUN_ID = "01J8Z3K9QW7B2RTESTRUN";
const CF_TOKEN = "cf-edit-token-value";
const CF_ACCOUNT = "0f2ac7c1b6e0470a8f3d1c2b4a5e6f70";
const CF_ZONE = "f1e2d3c4b5a6978869504132a1b2c3d4";
const BINDING = "KV_RESTORE_STAGING";
const INCLUDE = "session:, cart:";
const MAX = "100";

// A plain object standing in for a real user event, matching what the shim's dispatchEvent expects. The
// radio and the binding input are raw inputs rather than field() controls, so the flow only learns about
// them through their change/input listeners; setting .value alone would leave targetChoice unaware.
const userEvent = (type: string): ShimEvent =>
  ({ type, target: null, currentTarget: null, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} }) as unknown as ShimEvent;

// planFor answers the way the engine really does: a cfConfig context earns a configChanges diff and the
// planned writes that go with it; a request without one is an honest data-only plan that writes nothing.
// The asymmetry is the whole defect, so the stub must reproduce it rather than answering the same plan twice.
function planFor(req: RestoreRequest): RestorePlan {
  const withCf = req.cfConfig !== undefined;
  const withMedia = req.mediaRestore !== undefined;
  return {
    ok: true,
    runId: req.runId,
    mode: "dry-run",
    recordsVerified: withCf ? 65 : 0,
    isLatest: true,
    plannedWrites: withCf ? 65 : 2,
    bytes: withCf ? 4096 : 512,
    // A non-empty sample so the plan renders its resolved-destinations table, which is where the per-row
    // "Restore just this" re-entry lives (case 12). Each row resolves to the request's own target, the way
    // the engine answers a redirect, so a plan that lost the redirect is visible in the sample too.
    sample: [
      { name: "session:42", sourceType: "kv", binding: req.target?.binding ?? "SRC_KV_uploads", plaintextSize: 128 },
      { name: "cart:7", sourceType: "kv", binding: req.target?.binding ?? "SRC_KV_uploads", plaintextSize: 96 },
    ],
    skipped: [],
    ...(withMedia ? { mediaPlanned: [{ name: "video:launch", type: "stream" as const }] } : {}),
    ...(withCf
      ? {
          configChanges: Array.from({ length: 65 }, (_, i) => ({ surface: `surface-${i}`, summary: "would apply", willApply: true })),
          cfConfigSurfaces: Array.from({ length: 65 }, (_, i) => `surface-${i}`),
        }
      : {}),
  } as unknown as RestorePlan;
}

// A capture of one dry-run: the request body as the real buildRequest produced it, and whether the flow
// went on to PAINT that request's plan (rather than navigating away from it).
interface Capture {
  req: RestoreRequest;
  painted: boolean;
}

/**
 * Drive the runless landing exactly as an operator does: land on /restore with no run id, type the run id
 * and the Cloudflare context into the real fields, and click the real "Build the restore plan" button.
 *
 * The nav bridge stands in for the router: a navigate to /restore/:runId re-resolves, and workspace.ts
 * answers that route by calling renderRestoreFlow(engine, runId), so the fake does the same into a second
 * host. That is the re-mount, and reproducing it here is the point: without it the second, context-free
 * request never happens and the defect is invisible.
 */
async function driveRunlessLanding(opts: { cf?: boolean; media?: boolean; redirect?: boolean; scope?: boolean }): Promise<{ captures: Capture[]; navigatedTo: string[] }> {
  const captures: Capture[] = [];
  const navigatedTo: string[] = [];

  // painted is set on the capture whose plan actually reaches renderPlan. The stub records the request on
  // the way in; the flow marks it painted only if it renders it, which is the property under test.
  const engine = {
    restore: async (req: RestoreRequest) => {
      captures.push({ req: JSON.parse(JSON.stringify(req)) as RestoreRequest, painted: false });
      return planFor(req);
    },
    listApprovals: async () => [],
    getRunHistory: async () => [],
  } as unknown as EngineClient;

  const host = document.createElement("div");
  document.body.appendChild(host);

  installNav({
    navigate: (to: string) => {
      navigatedTo.push(to);
      const m = /^\/restore\/(.+)$/.exec(to);
      if (!m) return;
      // The re-mount. workspace.ts renders the flow column for /restore/:runId this way.
      const remounted = renderRestoreFlow(engine, decodeURIComponent(m[1]!));
      host.replaceChildren(remounted);
      markConnected(remounted);
    },
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });

  const flow = renderRestoreFlow(engine, undefined);
  host.replaceChildren(flow);
  markConnected(flow);

  const setVal = (sel: string, v: string) => {
    const el = qs(host as unknown as never, sel) as unknown as { value: string } | null;
    if (el) el.value = v;
  };
  setVal("#rs-run", RUN_ID);
  if (opts.cf) {
    setVal("#rs-cf-token", CF_TOKEN);
    setVal("#rs-cf-account", CF_ACCOUNT);
    setVal("#rs-cf-zone", CF_ZONE);
  }
  if (opts.media) {
    setVal("#rs-media-token", CF_TOKEN);
    setVal("#rs-media-account", CF_ACCOUNT);
  }
  if (opts.scope) {
    setVal("#rs-include", INCLUDE);
    setVal("#rs-max", MAX);
  }
  if (opts.redirect) {
    // Choose the redirect option and type the binding the way an operator does, through the events the
    // radio group listens on, so targetChoice enables the binding input and reports the choice.
    const radio = (qsa(host as unknown as never, '[data-dp="restore-flow.radio.redirect-radio"]') as unknown as Array<{ checked: boolean; dispatchEvent: (e: ShimEvent) => void }>)[0];
    if (!radio) throw new Error("the redirect radio did not render");
    radio.checked = true;
    radio.dispatchEvent(userEvent("change"));
    const bindingInput = qs(host as unknown as never, '[data-dp="restore-flow.text.binding"]') as unknown as { value: string; dispatchEvent: (e: ShimEvent) => void } | null;
    if (!bindingInput) throw new Error("the redirect binding input did not render");
    bindingInput.value = BINDING;
    bindingInput.dispatchEvent(userEvent("input"));
  }

  const btn = qs(host as unknown as never, '[data-dp="restore-flow.button.dry-run"]') as unknown as { click: () => void } | null;
  if (!btn) throw new Error("the dry-run button did not render; the flow did not mount");
  btn.click();
  await flushAsync(20);

  // A plan panel in the host means the LAST request the flow issued is the one on screen. renderPlan writes
  // .restore-plan__heading; the loading skeleton does not. Mark the last capture painted when it is there.
  const heading = qs(host as unknown as never, ".restore-plan__heading");
  if (heading && captures.length > 0) captures[captures.length - 1]!.painted = true;

  host.remove();
  return { captures, navigatedTo };
}

/**
 * The other direction: entry at /restore/:runId, the route that has always worked. The flow mounts with the
 * run id already in hand, so its prefillRun branch fires a dry-run immediately; the operator then opens the
 * Cloudflare disclosure, types the token and account, and builds again. Nothing may navigate on that second
 * build, and the plan that paints must be the one carrying the token.
 *
 * It is here so a future change cannot fix the runless landing by breaking this: an over-eager suppression
 * that also stopped the deep-link path from planning, or a re-introduced navigate that re-mounted it, would
 * fail these assertions and pass every one above.
 */
async function driveRunIdEntry(): Promise<{ captures: Capture[]; navigatedTo: string[] }> {
  const captures: Capture[] = [];
  const navigatedTo: string[] = [];

  const engine = {
    restore: async (req: RestoreRequest) => {
      captures.push({ req: JSON.parse(JSON.stringify(req)) as RestoreRequest, painted: false });
      return planFor(req);
    },
    listApprovals: async () => [],
    getRunHistory: async () => [],
  } as unknown as EngineClient;

  const host = document.createElement("div");
  document.body.appendChild(host);
  installNav({
    navigate: (to: string) => { navigatedTo.push(to); },
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });

  const flow = renderRestoreFlow(engine, RUN_ID);
  host.replaceChildren(flow);
  markConnected(flow);
  await flushAsync(20); // the prefillRun branch's automatic first dry-run

  const setVal = (sel: string, v: string) => {
    const el = qs(host as unknown as never, sel) as unknown as { value: string } | null;
    if (el) el.value = v;
  };
  setVal("#rs-cf-token", CF_TOKEN);
  setVal("#rs-cf-account", CF_ACCOUNT);
  setVal("#rs-cf-zone", CF_ZONE);

  const btn = qs(host as unknown as never, '[data-dp="restore-flow.button.dry-run"]') as unknown as { click: () => void } | null;
  if (!btn) throw new Error("the dry-run button did not render; the flow did not mount");
  btn.click();
  await flushAsync(20);

  const heading = qs(host as unknown as never, ".restore-plan__heading");
  if (heading && captures.length > 0) captures[captures.length - 1]!.painted = true;

  host.remove();
  return { captures, navigatedTo };
}

/**
 * Seed the per-run scope draft the way the product does, by typing a scope on a /restore/:runId mount, then
 * drive the runless landing with the run id ALONE. flow.ts keys the draft on the run id known at mount time,
 * so only the deep-link mount can write it and only the re-mount can read it back.
 */
async function driveRunlessLandingAfterSeedingADraft(): Promise<{ captures: Capture[]; navigatedTo: string[] }> {
  const captures: Capture[] = [];
  const navigatedTo: string[] = [];

  const engine = {
    restore: async (req: RestoreRequest) => {
      captures.push({ req: JSON.parse(JSON.stringify(req)) as RestoreRequest, painted: false });
      return planFor(req);
    },
    listApprovals: async () => [],
    getRunHistory: async () => [],
  } as unknown as EngineClient;

  const host = document.createElement("div");
  document.body.appendChild(host);
  installNav({
    navigate: (to: string) => {
      navigatedTo.push(to);
      const m = /^\/restore\/(.+)$/.exec(to);
      if (!m) return;
      const remounted = renderRestoreFlow(engine, decodeURIComponent(m[1]!));
      host.replaceChildren(remounted);
      markConnected(remounted);
    },
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });

  // The seeding visit: a deep-link mount, a scope typed into it, which persists the draft on input.
  const seeding = renderRestoreFlow(engine, RUN_ID);
  host.replaceChildren(seeding);
  markConnected(seeding);
  await flushAsync(20);
  const include = qs(host as unknown as never, "#rs-include") as unknown as { value: string; dispatchEvent: (e: ShimEvent) => void } | null;
  if (!include) throw new Error("the include field did not render");
  include.value = "session:";
  include.dispatchEvent(userEvent("input"));
  await flushAsync(5);

  // Now the landing, run id only. Everything before this point is setup, so the captures are reset.
  captures.length = 0;
  navigatedTo.length = 0;
  const flow = renderRestoreFlow(engine, undefined);
  host.replaceChildren(flow);
  markConnected(flow);
  const runEl = qs(host as unknown as never, "#rs-run") as unknown as { value: string } | null;
  if (runEl) runEl.value = RUN_ID;
  const btn = qs(host as unknown as never, '[data-dp="restore-flow.button.dry-run"]') as unknown as { click: () => void } | null;
  if (!btn) throw new Error("the dry-run button did not render; the flow did not mount");
  btn.click();
  await flushAsync(20);

  const heading = qs(host as unknown as never, ".restore-plan__heading");
  if (heading && captures.length > 0) captures[captures.length - 1]!.painted = true;

  host.remove();
  // The draft lives in sessionStorage, which is shared for the whole run, so leaving it behind would make
  // every case after this one depend on running before it. Cleared so the arms stay order-independent.
  sessionStorage.clear();
  return { captures, navigatedTo };
}

/**
 * A rig for the arms below: the same request-capturing engine, plus the reads the run picker and the date
 * browser perform, and the same nav bridge that re-mounts the flow on a /restore/:runId navigation.
 */
function pickerRig(): { engine: EngineClient; host: HTMLElement; captures: Capture[]; navigatedTo: string[] } {
  const captures: Capture[] = [];
  const navigatedTo: string[] = [];
  const startedAt = new Date().toISOString();
  const engine = {
    restore: async (req: RestoreRequest) => {
      captures.push({ req: JSON.parse(JSON.stringify(req)) as RestoreRequest, painted: false });
      return planFor(req);
    },
    listApprovals: async () => [],
    getRunHistory: async () => [],
    // The run picker's own reads (the fleet-wide ring plus the id -> name map).
    listAllHistory: async () => ({ byDownpipe: { "dp-uploads": [{ runId: RUN_ID, status: "ok", startedAt, index: 1 }] } }),
    listDownpipes: async () => [{ config: { id: "dp-uploads", name: "User uploads" } }],
    // The date browser's own reads (one downpipe's ring, and the authoritative retention floor).
    listHistory: async () => [{ runId: RUN_ID, status: "ok", startedAt, index: 1 }],
    runsAt: async () => ({ retainedFrom: new Date(Date.parse(startedAt) - 30 * 86400000).toISOString() }),
  } as unknown as EngineClient;

  const host = document.createElement("div");
  document.body.appendChild(host);
  installNav({
    navigate: (to: string) => {
      navigatedTo.push(to);
      const m = /^\/restore\/(.+)$/.exec(to);
      if (!m) return;
      const remounted = renderRestoreFlow(engine, decodeURIComponent(m[1]!));
      host.replaceChildren(remounted);
      markConnected(remounted);
    },
    onUnauthorised: () => {},
    refreshIdentity: async () => {},
    onAuthenticated: async () => {},
    signOut: () => {},
  });
  return { engine, host, captures, navigatedTo };
}

// typeTheContext fills the fields an operator would have filled before reaching for a run: the scope, the
// Cloudflare edit context, and the redirect. Driven through the same events the real controls listen on.
function typeTheContext(host: HTMLElement, opts: { scope?: boolean; cf?: boolean; redirect?: boolean }): void {
  const setVal = (sel: string, v: string) => {
    const el = qs(host as unknown as never, sel) as unknown as { value: string } | null;
    if (!el) throw new Error(`the ${sel} field did not render`);
    el.value = v;
  };
  if (opts.scope) {
    setVal("#rs-include", INCLUDE);
    setVal("#rs-max", MAX);
  }
  if (opts.cf) {
    setVal("#rs-cf-token", CF_TOKEN);
    setVal("#rs-cf-account", CF_ACCOUNT);
  }
  if (opts.redirect) {
    const radio = (qsa(host as unknown as never, '[data-dp="restore-flow.radio.redirect-radio"]') as unknown as Array<{ checked: boolean; dispatchEvent: (e: ShimEvent) => void }>)[0];
    if (!radio) throw new Error("the redirect radio did not render");
    radio.checked = true;
    radio.dispatchEvent(userEvent("change"));
    const bindingInput = qs(host as unknown as never, '[data-dp="restore-flow.text.binding"]') as unknown as { value: string; dispatchEvent: (e: ShimEvent) => void } | null;
    if (!bindingInput) throw new Error("the redirect binding input did not render");
    bindingInput.value = BINDING;
    bindingInput.dispatchEvent(userEvent("input"));
  }
}

/**
 * The RUN PICKER arm. Land runless, type the context, then reach for the picker (the lead affordance on a
 * cold entry) and choose a run. Nothing may be planned from the choice alone, and nothing the operator typed
 * may be discarded by it.
 *
 * `via` selects which discovery surface is driven: the flat picker, or the calendar's time row, which is a
 * second entry onto the identical navigation and so a second way to lose the same context.
 */
async function drivePickARun(via: "picker" | "calendar", opts: { scope?: boolean; cf?: boolean; redirect?: boolean }): Promise<{ captures: Capture[]; navigatedTo: string[]; fields: { include: string; max: string; cfToken: string; binding: string } }> {
  const { engine, host, captures, navigatedTo } = pickerRig();
  const flow = renderRestoreFlow(engine, undefined);
  host.replaceChildren(flow);
  markConnected(flow);
  typeTheContext(host, opts);

  const open = qs(host as unknown as never, `[data-dp="restore-flow.button.${via === "picker" ? "browse-runs" : "browse-by-date"}"]`) as unknown as { click: () => void } | null;
  if (!open) throw new Error(`the ${via} affordance did not render`);
  open.click();
  await flushAsync(40);

  // Both surfaces mount their modal on document.body, not inside the flow's host.
  const rowSelector = via === "picker" ? '[data-dp="restore-flow.button.pick"]' : '[data-dp="restore-flow.button.select-run"]';
  let rows = qsa(document.body as unknown as never, rowSelector) as unknown as Array<{ click: () => void }>;
  if (via === "calendar" && rows.length === 0) {
    // The calendar opens on the latest restorable day; if it did not expand one, select the last day cell.
    const days = qsa(document.body as unknown as never, '[data-dp="restore-flow.button.select-day"]') as unknown as Array<{ click: () => void }>;
    if (days.length > 0) days[days.length - 1]!.click();
    await flushAsync(20);
    rows = qsa(document.body as unknown as never, rowSelector) as unknown as Array<{ click: () => void }>;
  }
  if (rows.length === 0) throw new Error(`the ${via} listed no run to choose; the arm proved nothing`);
  rows[0]!.click();
  await flushAsync(30);

  const heading = qs(host as unknown as never, ".restore-plan__heading");
  if (heading && captures.length > 0) captures[captures.length - 1]!.painted = true;

  const read = (sel: string): string => {
    const el = qs(host as unknown as never, sel) as unknown as { value: string } | null;
    return el ? el.value : "";
  };
  const bindingEl = qs(host as unknown as never, '[data-dp="restore-flow.text.binding"]') as unknown as { value: string } | null;
  const fields = { include: read("#rs-include"), max: read("#rs-max"), cfToken: read("#rs-cf-token"), binding: bindingEl ? bindingEl.value : "" };
  host.remove();
  sessionStorage.clear();
  return { captures, navigatedTo, fields };
}

/**
 * The RUN PICKER arm with a stale per-run scope draft already written by an earlier /restore/:runId visit.
 * The operator types nothing here, so the run id alone IS the request a fresh mount would rebuild, and only
 * the draft makes the re-mount disagree. Nothing may be planned that the operator did not build.
 */
async function drivePickARunWithASeededDraft(): Promise<{ captures: Capture[]; navigatedTo: string[] }> {
  const { engine, host, captures, navigatedTo } = pickerRig();
  const seeding = renderRestoreFlow(engine, RUN_ID);
  host.replaceChildren(seeding);
  markConnected(seeding);
  await flushAsync(20);
  const include = qs(host as unknown as never, "#rs-include") as unknown as { value: string; dispatchEvent: (e: ShimEvent) => void } | null;
  if (!include) throw new Error("the include field did not render");
  include.value = "session:";
  include.dispatchEvent(userEvent("input"));
  await flushAsync(5);

  captures.length = 0;
  navigatedTo.length = 0;
  const flow = renderRestoreFlow(engine, undefined);
  host.replaceChildren(flow);
  markConnected(flow);
  const open = qs(host as unknown as never, '[data-dp="restore-flow.button.browse-runs"]') as unknown as { click: () => void } | null;
  if (!open) throw new Error("the picker affordance did not render");
  open.click();
  await flushAsync(30);
  const rows = qsa(document.body as unknown as never, '[data-dp="restore-flow.button.pick"]') as unknown as Array<{ click: () => void }>;
  if (rows.length === 0) throw new Error("the picker listed no run to choose; the arm proved nothing");
  rows[0]!.click();
  await flushAsync(30);
  host.remove();
  sessionStorage.clear();
  return { captures, navigatedTo };
}

/**
 * The RE-ENTRY arm. Build a redirected plan at /restore/:runId, then narrow it with a plan row's "Restore
 * just this". No navigation happens at all: reenter re-renders the pick form in place and the prefill branch
 * auto-runs a fresh dry-run, so the second request is the one that paints and the one an approval arms
 * against. It must still be a redirect.
 */
async function driveRestoreJustThis(): Promise<{ first: RestoreRequest | null; second: RestoreRequest | null; navigatedTo: string[]; binding: string }> {
  const { engine, host, captures, navigatedTo } = pickerRig();
  const flow = renderRestoreFlow(engine, RUN_ID);
  host.replaceChildren(flow);
  markConnected(flow);
  await flushAsync(20);
  captures.length = 0; // the arrival dry-run is setup, not the measurement
  typeTheContext(host, { scope: true, redirect: true });
  const btn = qs(host as unknown as never, '[data-dp="restore-flow.button.dry-run"]') as unknown as { click: () => void } | null;
  if (!btn) throw new Error("the dry-run button did not render");
  btn.click();
  await flushAsync(30);
  const first = captures.length > 0 ? captures[captures.length - 1]!.req : null;

  const one = qs(host as unknown as never, '[data-dp="restore-flow.button.restore-one"]') as unknown as { click: () => void } | null;
  if (!one) throw new Error("the plan rows carried no Restore just this affordance; the arm proved nothing");
  captures.length = 0;
  one.click();
  await flushAsync(40);
  const second = captures.length > 0 ? captures[captures.length - 1]!.req : null;
  const bindingEl = qs(host as unknown as never, '[data-dp="restore-flow.text.binding"]') as unknown as { value: string } | null;
  const binding = bindingEl ? bindingEl.value : "";
  host.remove();
  sessionStorage.clear();
  return { first, second, navigatedTo, binding };
}

async function main(): Promise<void> {
  console.log("-- restore context survives the runless entry (real renderRestoreFlow, captured request bodies) --");

  // Case 1: the defect. A cf-config restore typed on the runless landing.
  const cf = await driveRunlessLanding({ cf: true });
  const paintedCf = cf.captures.find((c) => c.painted) ?? null;

  ok("a cf-config dry-run from the runless landing issues exactly one request", cf.captures.length === 1);
  ok("some request was painted", paintedCf !== null);
  ok(
    "the PAINTED request carries the Cloudflare context the operator typed",
    paintedCf?.req.cfConfig?.token === CF_TOKEN &&
      paintedCf?.req.cfConfig?.accountId === CF_ACCOUNT &&
      paintedCf?.req.cfConfig?.zoneId === CF_ZONE,
  );
  ok(
    "no request the flow issued dropped the context that an earlier one carried",
    cf.captures.every((c) => c.req.cfConfig !== undefined),
  );
  // The honest URL consequence: a restore holding a one-time edit token is not a shareable session, so the
  // flow must NOT rewrite the address bar into a link that cannot reproduce it.
  ok("a cf-config restore does not claim a bookmarkable /restore/:runId URL", cf.navigatedTo.length === 0);

  // Case 2: the MEDIA restore, the second one-time context. It is a separate arm rather than a variation
  // of case 1 because carriesOneTimeContext tests two independent clauses, and a single cf arm leaves the
  // media clause free to be deleted with every assertion still green. A media restore loses its token to
  // the same re-mount and lands on the same writes-nothing plan.
  const media = await driveRunlessLanding({ media: true });
  const paintedMedia = media.captures.find((c) => c.painted) ?? null;
  ok("the PAINTED request carries the media context the operator typed", paintedMedia?.req.mediaRestore?.token === CF_TOKEN);
  ok("a media restore does not claim a bookmarkable /restore/:runId URL either", media.navigatedTo.length === 0);

  // Case 3: the REDIRECT target, the highest-consequence field on this screen and the reason a list of
  // known contexts was the wrong shape of guard. It is not a secret and not a draft field: it is simply
  // never persisted, on purpose, so the re-mount resets it to the calm original-bindings default. The plan
  // that painted therefore wrote every record back over the LIVE ORIGINAL bindings while the operator had
  // asked for the opposite, and the redirect's type-to-confirm never fired because the plan the screen
  // held was not a redirect.
  const redirect = await driveRunlessLanding({ redirect: true });
  const paintedRedirect = redirect.captures.find((c) => c.painted) ?? null;
  ok("the PAINTED request carries the redirect target the operator chose", paintedRedirect?.req.target?.binding === BINDING);
  ok("no request the flow issued fell back to the original bindings", redirect.captures.every((c) => c.req.target?.binding === BINDING));
  ok("a redirected restore does not claim a bookmarkable /restore/:runId URL", redirect.navigatedTo.length === 0);

  // Case 4: the SCOPE fields. flow.ts keys its per-run scope draft on the run id known at MOUNT time, and
  // the runless landing has none, so the draft is never written and the re-mount has nothing to read back.
  // A capped, prefixed restore therefore planned and applied uncapped over every record.
  const scope = await driveRunlessLanding({ scope: true });
  const paintedScope = scope.captures.find((c) => c.painted) ?? null;
  ok("the PAINTED request carries the include prefixes the operator typed", JSON.stringify(paintedScope?.req.include) === JSON.stringify(["session:", "cart:"]));
  ok("the PAINTED request carries the record cap the operator typed", paintedScope?.req.maxRecords === Number(MAX));
  ok("no request the flow issued planned the run uncapped", scope.captures.every((c) => c.req.maxRecords === Number(MAX)));
  ok("a scoped restore does not claim a bookmarkable /restore/:runId URL", scope.navigatedTo.length === 0);

  // Case 5: the R2b convenience is untouched for a restore that really is just a run id, the only request a
  // fresh mount at /restore/:runId can rebuild. This is the guard against over-fixing: deleting the navigate
  // outright would pass every assertion above and silently remove a shipped feature, so this case fails if
  // the fix is a deletion.
  const plain = await driveRunlessLanding({ cf: false });
  ok("a plain data restore still earns its bookmarkable URL", plain.navigatedTo.includes(`/restore/${encodeURIComponent(RUN_ID)}`));
  // Asserted as the WHOLE request rather than as its runId. A runId-only check is passed by a request
  // that has been stripped of everything else, which is precisely the failure this file exists to catch,
  // so it would agree with the bug it is meant to refuse.
  ok("a plain data restore re-mounts and plans the run", plain.captures.length >= 1 && plain.captures.every((c) => JSON.stringify(c.req) === JSON.stringify({ runId: RUN_ID })));

  // Case 6: the stored draft, the same question pointing the other way. This landing never writes the
  // per-run scope draft, but an earlier visit to /restore/:runId for the same run does, and the re-mount
  // reads it back and ADDS a scope the operator did not type here. Without the fix, a landing request of
  // {"runId":"..."} re-mounts into {"runId":"...","include":["session:"]}, and the narrowed plan is the
  // one that paints. Narrower is the less destructive direction, but it is still a plan the operator did
  // not build, so it must not claim a URL either.
  const seeded = await driveRunlessLandingAfterSeedingADraft();
  ok("a run whose scope draft would change the re-mounted request does not claim a URL", seeded.navigatedTo.length === 0);
  ok("the PAINTED request is the one the operator actually built", JSON.stringify(seeded.captures.find((c) => c.painted)?.req) === JSON.stringify({ runId: RUN_ID }));

  // Case 7: the route that has always worked, asserted so a future change cannot fix the landing by
  // breaking the deep link.
  const deep = await driveRunIdEntry();
  const paintedDeep = deep.captures.find((c) => c.painted) ?? null;
  ok("a /restore/:runId entry plans the run on arrival", deep.captures.length >= 1 && deep.captures[0]!.req.runId === RUN_ID);
  ok(
    "a /restore/:runId entry paints the plan for the Cloudflare context typed after arrival",
    paintedDeep?.req.cfConfig?.token === CF_TOKEN && paintedDeep?.req.cfConfig?.accountId === CF_ACCOUNT && paintedDeep?.req.cfConfig?.zoneId === CF_ZONE,
  );
  ok("a /restore/:runId entry never navigates away from itself", deep.navigatedTo.length === 0);

  // Case 8: the RUN PICKER, the runless landing's lead affordance on a cold entry. It deep-linked to
  // /restore/:runId unconditionally, which is the same re-mount as the R2b navigation and cost the same
  // three things at once. Without the fix, one request, {"runId":"..."}, paints, with every field on the
  // re-mounted screen empty.
  const picked = await drivePickARun("picker", { scope: true, cf: true, redirect: true });
  ok("choosing a run does not plan anything by itself", picked.captures.length === 0);
  ok("choosing a run does not claim a URL that cannot reproduce the form", picked.navigatedTo.length === 0);
  ok("the redirect target survives choosing a run", picked.fields.binding === BINDING);
  ok("the scope survives choosing a run", picked.fields.include === INCLUDE && picked.fields.max === MAX);
  ok("the Cloudflare edit token survives choosing a run", picked.fields.cfToken === CF_TOKEN);

  // Case 9: the CALENDAR, a second discovery path onto the identical navigation, so it lost the identical
  // context. Its own "Browse recent runs instead" link hands to the picker above, which is why the two are
  // one fix and two arms.
  const calendared = await drivePickARun("calendar", { scope: true, redirect: true });
  ok("choosing a run by date does not plan anything by itself", calendared.captures.length === 0);
  ok("choosing a run by date does not claim a URL either", calendared.navigatedTo.length === 0);
  ok("the redirect target survives choosing a run by date", calendared.fields.binding === BINDING);
  ok("the scope survives choosing a run by date", calendared.fields.include === INCLUDE && calendared.fields.max === MAX);

  // Case 10: the picker's own over-fix control. A run chosen with NOTHING else typed is exactly the request a
  // fresh mount can rebuild, so it must still earn its bookmarkable URL and still plan the run. Without this,
  // making chooseRun never navigate would pass cases 8 and 9 and quietly delete the shipped feature.
  const pickedBare = await drivePickARun("picker", {});
  ok("a bare run chosen from the picker still earns its bookmarkable URL", pickedBare.navigatedTo.includes(`/restore/${encodeURIComponent(RUN_ID)}`));
  ok("a bare run chosen from the picker plans the run it names", pickedBare.captures.length >= 1 && pickedBare.captures.every((c) => JSON.stringify(c.req) === JSON.stringify({ runId: RUN_ID })));

  // Case 11: the picker against a stale per-run scope draft, the ADD direction. Nothing is typed here, so the
  // run id alone is what a fresh mount would rebuild and only the draft makes it disagree. Without the fix,
  // the re-mount produces {"runId":"...","include":["session:"]}, a scope the operator never typed on this
  // screen.
  const pickedSeeded = await drivePickARunWithASeededDraft();
  ok("a run whose stale draft would change the re-mount does not claim a URL from the picker", pickedSeeded.navigatedTo.length === 0);
  ok("a run whose stale draft would change the re-mount plans nothing from the picker", pickedSeeded.captures.length === 0);

  // Case 12: the RE-ENTRY, the same defect with no navigation in it at all. "Restore just this" re-renders
  // the pick form in place and the prefill branch auto-runs the dry-run whose plan paints, so a dropped
  // field is absent from the plan the approver arms against. Without the fix, POST 1 carries target.binding
  // and POST 2 is {"runId":"...","recordName":"session:42"}, so one record goes back over its live original
  // binding moments after the operator reviewed a plan showing the redirect on every row.
  const justThis = await driveRestoreJustThis();
  ok("the plan the operator reviewed was a redirect", justThis.first?.target?.binding === BINDING);
  ok("narrowing to one record still narrows to one record", justThis.second?.recordName === "session:42");
  ok("narrowing to one record keeps the redirect target", justThis.second?.target?.binding === BINDING);
  ok("the re-entered form shows the redirect it is planning", justThis.binding === BINDING);
  ok("narrowing to one record navigates nowhere", justThis.navigatedTo.length === 0);

  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

await main();
