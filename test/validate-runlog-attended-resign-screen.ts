// The Keys > Posture "Destination RUNLOG signature" section: the console-side half of three Owner-only,
// attended RUNLOG actions (re-sign, floor reset, relink). Before this, the console had no way to show a
// RUNLOG the engine refuses to write to on its own, or to let an Owner decide it; the engine routes existed
// with no caller.
//
// This drives the REAL renderRunlogResignSection over the shared dom-shim, through a REAL EngineClient
// (never a reimplementation), with a scripted fetch standing in for the engine. It checks:
//   1. A non-Owner sees that an Owner must act, and the section never calls the engine at all.
//   2. The destination picker offers only the destinations engine.listDestinations() already knows (plus
//      "Default destination"), never a free-text field: an Owner cannot name an unknown destination.
//   3. An Owner can read the signature evidence and the re-sign control appears only when canResign is true;
//      the re-sign goes through the real type-to-confirm (the destination's name) and the real step-up, and
//      the POST is never sent while the typed value does not match.
//   4. The floor-reset subsection: the evidence (bucket, floor, the bucket's own RUNLOG), the reset control
//      only when canReset is true, and the same typed-confirmation + step-up gating.
//   5. The relink subsection: a downpipe picker offering only known downpipes, the evidence (verifies,
//      digest, the anomaly, whether a relink would clear it), the relink control only when canRelink is
//      true, and a duplicate-index anomaly showing the engine's own refusal text (including its fresh-
//      destination remedy) verbatim with no relink control offered.
//
// Run with `node test/validate-runlog-attended-resign-screen.ts`.

import { flushAsync, installDomShim, qs, qsa, type ShimNode, textOf } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { connect, setCaller, setStepUpRunner } from "../src/lib/store.ts";
import { renderRunlogResignSection } from "../src/screens/keys/runlog-resign.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
import { click, findButtonByText, SN } from "./validate-stable-components-shared.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const DIGEST = "ab".repeat(48); // 96 hex chars, the SHA-384 shape the engine route requires

const DESTINATIONS = {
  destinations: [
    { present: true, id: "dest-a", label: "Acme offsite", isDefault: false },
    { present: true, id: "dest-b", label: "Acme backups", isDefault: true },
  ],
  defaultId: "dest-b",
};

const DOWNPIPES = [
  { config: { id: "dp-1", name: "Ledger", cadenceSeconds: 900, enabled: true, source: { kind: "kv", binding: "KV_a" } }, nextRunAt: 0, lastRunId: null, inFlight: false },
  { config: { id: "dp-2", name: "Mail archive", cadenceSeconds: 900, enabled: true, source: { kind: "kv", binding: "KV_b" } }, nextRunAt: 0, lastRunId: null, inFlight: false },
];

interface Call { path: string; method: string; body: Record<string, unknown> }

function scriptedFetch(opts: {
  view?: Record<string, unknown>;
  floorView?: Record<string, unknown>;
  chainView?: Record<string, unknown>;
  resignFirst?: { status: number; body: unknown };
  resignSecond?: { status: number; body: unknown };
  floorResetFirst?: { status: number; body: unknown };
  floorResetSecond?: { status: number; body: unknown };
  relinkFirst?: { status: number; body: unknown };
  relinkSecond?: { status: number; body: unknown };
}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  let resignAttempt = 0;
  let floorResetAttempt = 0;
  let relinkAttempt = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname + url.search, method, body });
    if (url.pathname === "/admin/destinations") {
      return new Response(JSON.stringify(DESTINATIONS), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/downpipes") {
      return new Response(JSON.stringify(DOWNPIPES), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/signature") {
      return new Response(JSON.stringify(opts.view ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/resign") {
      resignAttempt++;
      const canned = resignAttempt === 1 ? opts.resignFirst : (opts.resignSecond ?? opts.resignFirst);
      const c = canned ?? { status: 200, body: { ok: true, outcome: "re-signed", destinationId: "" } };
      return new Response(JSON.stringify(c.body), { status: c.status, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/floor") {
      return new Response(JSON.stringify(opts.floorView ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/floor/reset") {
      floorResetAttempt++;
      const canned = floorResetAttempt === 1 ? opts.floorResetFirst : (opts.floorResetSecond ?? opts.floorResetFirst);
      const c = canned ?? { status: 200, body: { ok: true, outcome: "reset", destinationId: "" } };
      return new Response(JSON.stringify(c.body), { status: c.status, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/chain") {
      return new Response(JSON.stringify(opts.chainView ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/admin/runlog/relink") {
      relinkAttempt++;
      const canned = relinkAttempt === 1 ? opts.relinkFirst : (opts.relinkSecond ?? opts.relinkFirst);
      const c = canned ?? { status: 200, body: { ok: true, outcome: "relinked", destinationId: "" } };
      return new Response(JSON.stringify(c.body), { status: c.status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unscripted fetch: ${method} ${url.pathname}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

function destinationSelect(el: HTMLElement): HTMLSelectElement {
  return qs(SN(el) as unknown as ShimNode, '[data-dp="keys.select.runlog-resign-section"]') as unknown as HTMLSelectElement;
}

function downpipeSelect(el: HTMLElement): HTMLSelectElement {
  return qs(SN(el) as unknown as ShimNode, '[data-dp="keys.select.runlog-relink-section"]') as unknown as HTMLSelectElement;
}

function optionValues(select: HTMLSelectElement): string[] {
  return qsa(SN(select) as unknown as ShimNode, "option").map((o) => (o as unknown as HTMLOptionElement).value);
}

function chooseOption(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent({ type: "change", target: select, currentTarget: select, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as unknown as Event);
}

// typeInConfirm types a value into the open type-to-confirm dialog's field and dispatches the real
// `input` event typeToConfirm listens on, exactly as validate-stable-components-dialogs.ts does.
function typeInConfirm(value: string): void {
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) throw new Error("expected the type-to-confirm dialog to be open");
  const input = qs(surface, "input") as unknown as HTMLInputElement;
  input.value = value;
  input.dispatchEvent({ type: "input", target: input, currentTarget: input, defaultPrevented: false, bubbles: true, preventDefault() {}, stopPropagation() {} } as unknown as Event);
}

async function clickConfirm(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) throw new Error(`expected a confirm dialog for "${label}"`);
  const btn = findButtonByText(surface, label);
  if (!btn) throw new Error(`no "${label}" button in the confirm dialog`);
  click(btn);
  await flushAsync();
  await flushAsync();
}

function lastToastText(): string {
  const toasts = qsa(SN(document.body) as unknown as ShimNode, ".toast");
  const el = toasts[toasts.length - 1];
  return el ? textOf(qs(el, ".toast__msg") ?? el) : "";
}

const VERIFIED_VIEW = {
  destinationId: "dest-a", object: "_RECOVERY/RUNLOG", signatureObject: "_RECOVERY/RUNLOG.sig",
  present: true, sigPresent: true, pendingPresent: false, state: "verified", verifiesUnderHeldOld: false,
  digest: DIGEST, parses: true, entryCount: 12, maxIndex: 11, currentSigner: "edmldsa1:current",
  lastGoodIndex: 11, canResign: false, refusal: "the RUNLOG already verifies under the current signer",
};

const RESIGNABLE_VIEW = {
  destinationId: "dest-b", object: "_RECOVERY/RUNLOG", signatureObject: "_RECOVERY/RUNLOG.sig (absent)",
  present: true, sigPresent: false, pendingPresent: false, state: "sig-invalid", verifiesUnderHeldOld: false,
  digest: DIGEST, parses: true, entryCount: 9, maxIndex: 8, currentSigner: "edmldsa1:current",
  lastGoodIndex: 8, canResign: true,
};

// FLOOR_BLOCKED_VIEW mirrors engine router-runlog.ts's floorView for a redeployed env destination: the
// bucket now holds an older RUNLOG than the confirmed floor, so the writers refuse it (below-floor).
const FLOOR_BLOCKED_VIEW = {
  destinationId: "dest-a", bucket: "r2.example.com/new-bucket", floor: 40, runlogPresent: true,
  runlogState: "verified", digest: DIGEST, maxIndex: 12,
  refusal: "the RUNLOG's highest index (12) is below the 40 confirmed at this destination, so the writers read it as a rollback",
  canReset: true, resetTo: 12,
};

const FLOOR_CLEAR_VIEW = {
  destinationId: "dest-a", bucket: "r2.example.com/bucket", floor: 12, runlogPresent: true,
  runlogState: "verified", digest: DIGEST, maxIndex: 12, canReset: false,
};

// CHAIN_RELINKABLE_VIEW mirrors engine router-runlog.ts's /runlog/chain view: a RUNLOG that verifies but
// holds a stray-ancestor anomaly for one downpipe, which a relink clears.
const CHAIN_RELINKABLE_VIEW = {
  destinationId: "dest-a", downpipeId: "dp-1", bucket: "r2.example.com/bucket",
  present: true, verifies: true, digest: DIGEST, maxIndex: 20, chainEntries: 6,
  anomaly: { kind: "stray-ancestor", reason: "an entry's prevRunId does not match the chain", indexA: 4, indexB: 5 },
  relinkClears: true, lastGoodIndex: 20, canRelink: true,
};

// CHAIN_DUPLICATE_INDEX_VIEW: a relink cannot clear a duplicate-index anomaly (relinking does not change an
// index), so the engine's refusal (router-runlog.ts relinkRefusal) names the fresh-destination remedy and
// canRelink is false. This exact string, from the engine at 5aa945f8, is asserted on verbatim below.
const DUPLICATE_INDEX_REFUSAL = "a relink does not clear this anomaly (duplicate-index): two entries hold one index, and relinking does not change an index. Attach this downpipe to a fresh destination to keep backing up";
const CHAIN_DUPLICATE_INDEX_VIEW = {
  destinationId: "dest-a", downpipeId: "dp-2", bucket: "r2.example.com/bucket",
  present: true, verifies: true, digest: DIGEST, maxIndex: 20, chainEntries: 6,
  anomaly: { kind: "duplicate-index", reason: "two entries hold index 7", indexA: 7, indexB: 7 },
  relinkClears: false, lastGoodIndex: 20, canRelink: false, refusal: DUPLICATE_INDEX_REFUSAL,
};

async function main(): Promise<void> {
  console.log("\n-- a non-Owner sees that an Owner must act, and the engine is never called --");
  {
    setCaller({ method: "passkey", email: "viewer@example.com", role: "viewer", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({ view: VERIFIED_VIEW });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    ok("names that an Owner must act", textOf(el).includes("an Owner must review it and decide"));
    ok("offers no destination picker to a non-Owner", destinationSelect(el) === null);
    ok("calls the engine zero times", calls.length === 0);
    el.remove();
    restore();
  }

  console.log("\n-- the destination picker offers only known destinations, never free text --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({ view: VERIFIED_VIEW });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    ok("there is no free-text destination field", qs(SN(el) as unknown as ShimNode, 'input[type="text"]') === null);
    const values = optionValues(destinationSelect(el));
    ok("offers Default destination plus every known destination, nothing else", JSON.stringify(values) === JSON.stringify(["", "dest-a", "dest-b"]));
    ok("labels the default destination among the picker's own destinations", textOf(destinationSelect(el)).includes("Acme backups (default)"));
    el.remove();
    restore();
  }

  console.log("\n-- an Owner reads a verified RUNLOG: no re-sign control, the refusal explains why --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({ view: VERIFIED_VIEW });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-a");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#3"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("shows the signer fingerprint", text.includes("edmldsa1:current"));
    ok("shows the digest", text.includes(DIGEST));
    ok("shows the highest index against the last good index", text.includes("Highest index 11") && text.includes("last good index 11"));
    ok("names the refusal", text.includes("already verifies under the current signer"));
    ok("offers no re-sign button", qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.resign"]') === null);
    ok("asked the engine for the chosen destination", calls.some((c) => c.path === "/admin/runlog/signature?destinationId=dest-a"));
    el.remove();
    restore();
  }

  console.log("\n-- an Owner re-signs a RUNLOG that does not verify: typed confirmation, step-up, result --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    let ceremonyRuns = 0;
    setStepUpRunner(async () => { ceremonyRuns++; return "stepup-token-abc"; });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({
      view: RESIGNABLE_VIEW,
      resignFirst: { status: 401, body: { stepUpRequired: true } },
      resignSecond: { status: 200, body: { ok: true, outcome: "re-signed", destinationId: "dest-b", state: "sig-invalid", maxIndex: 8, lastGoodIndex: 8 } },
    });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-b");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#3"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const resignBtn = qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.resign"]');
    ok("offers the re-sign control when canResign is true", resignBtn !== null);
    (resignBtn as unknown as HTMLElement).click();
    await flushAsync();

    // The evidence is shown before the typed field, and Re-sign stays disabled on no input and on a wrong
    // destination name: the engine is never called while the typed value does not match.
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal")!;
    ok("shows the digest above the typed-confirmation field", textOf(surface).includes(DIGEST));
    const applyBefore = findButtonByText(surface, "Re-sign")!;
    ok("Re-sign is disabled before any input", applyBefore.getAttribute("disabled") === "");
    click(applyBefore);
    await flushAsync();
    ok("clicking a disabled Re-sign sends nothing", calls.every((c) => c.path !== "/admin/runlog/resign"));
    typeInConfirm("Acme offsite"); // another destination's name: still not the match
    ok("a non-matching destination name keeps Re-sign disabled", findButtonByText(surface, "Re-sign")!.disabled === true);
    typeInConfirm("Acme backups"); // dest-b's own name
    ok("the exact destination name enables Re-sign", findButtonByText(surface, "Re-sign")!.disabled === false);

    await clickConfirm("Re-sign");
    ok("the step-up ceremony ran once", ceremonyRuns === 1);
    const resignCalls = calls.filter((c) => c.path === "/admin/runlog/resign");
    ok("retried the resign exactly once after step-up, only once the name matched", resignCalls.length === 2);
    ok("the confirmed digest rode on the resign call", resignCalls.every((c) => c.body.digest === DIGEST));
    ok("the resign named the chosen destination", resignCalls.every((c) => c.body.destinationId === "dest-b"));
    ok("the result names the re-sign and points at the audit log and the alert", lastToastText().includes("Re-signed") && lastToastText().includes("audit log") && lastToastText().includes("alert"));
    el.remove();
    restore();
    setStepUpRunner(async () => null);
  }

  console.log("\n-- CONTROL: a destination with no RUNLOG yet says so, with no re-sign control --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({ view: { destinationId: "", present: false, sigPresent: false, pendingPresent: false, state: "absent", verifiesUnderHeldOld: false, parses: false, lastGoodIndex: null, canResign: false } });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#3"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("names there is no RUNLOG yet", text.includes("no RUNLOG at this destination yet"));
    ok("offers no re-sign control", qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.resign"]') === null);
    el.remove();
    restore();
  }

  console.log("\n-- the picker pre-selects a destination the caller already knows is failing --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({ view: VERIFIED_VIEW });
    const el = renderRunlogResignSection(engine, "dest-a");
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    ok("pre-selects the named failing destination", destinationSelect(el).value === "dest-a");
    el.remove();
    restore();
  }
  {
    // An unknown initial destination id (not in the console's own list) is never selected: the picker
    // still offers only known destinations.
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({ view: VERIFIED_VIEW });
    const el = renderRunlogResignSection(engine, "dest-unknown");
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    ok("CONTROL: an unknown initial destination id is ignored, default destination stays selected", destinationSelect(el).value === "");
    el.remove();
    restore();
  }

  console.log("\n-- the floor-reset subsection: evidence, no control when the writers do not refuse on the floor --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({ floorView: FLOOR_CLEAR_VIEW });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-a");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#1"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("shows the bucket", text.includes("r2.example.com/bucket"));
    ok("shows the confirmed floor", text.includes("Confirmed floor: 12"));
    ok("offers no reset control when the writers do not refuse on the floor", qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.reset"]') === null);
    ok("asked the engine for the chosen destination", calls.some((c) => c.path === "/admin/runlog/floor?destinationId=dest-a"));
    el.remove();
    restore();
  }

  console.log("\n-- the floor-reset subsection: a blocked destination, typed confirmation, step-up, result --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    let ceremonyRuns = 0;
    setStepUpRunner(async () => { ceremonyRuns++; return "stepup-token-abc"; });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({
      floorView: FLOOR_BLOCKED_VIEW,
      floorResetFirst: { status: 401, body: { stepUpRequired: true } },
      floorResetSecond: { status: 200, body: { ok: true, outcome: "reset", destinationId: "dest-a", oldFloor: 40, newFloor: 12, reason: "below-floor" } },
    });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-a");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#1"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("shows the engine's refusal in plain words", text.includes("is below the 40 confirmed at this destination"));
    const resetBtn = qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.reset"]');
    ok("offers the reset control when canReset is true", resetBtn !== null);
    (resetBtn as unknown as HTMLElement).click();
    await flushAsync();
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal")!;
    const applyBefore = findButtonByText(surface, "Reset floor")!;
    ok("Reset floor is disabled before any input", applyBefore.getAttribute("disabled") === "");
    click(applyBefore);
    await flushAsync();
    ok("clicking a disabled Reset floor sends nothing", calls.every((c) => c.path !== "/admin/runlog/floor/reset"));
    typeInConfirm("Acme backups"); // another destination's name: still not the match
    ok("a non-matching destination name keeps Reset floor disabled", findButtonByText(surface, "Reset floor")!.disabled === true);
    typeInConfirm("Acme offsite"); // dest-a's own name
    ok("the exact destination name enables Reset floor", findButtonByText(surface, "Reset floor")!.disabled === false);
    await clickConfirm("Reset floor");
    ok("the step-up ceremony ran once", ceremonyRuns === 1);
    const resetCalls = calls.filter((c) => c.path === "/admin/runlog/floor/reset");
    ok("retried the reset exactly once after step-up, only once the name matched", resetCalls.length === 2);
    ok("the expected floor and destination rode on the reset call", resetCalls.every((c) => c.body.expectFloor === 40 && c.body.destinationId === "dest-a"));
    ok("the result names the reset and points at the audit log and the alert", lastToastText().includes("Floor reset from 40 to 12") && lastToastText().includes("audit log") && lastToastText().includes("alert"));
    el.remove();
    restore();
    setStepUpRunner(async () => null);
  }

  console.log("\n-- the relink subsection: the downpipe picker offers only known downpipes, never free text --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({});
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    ok("there is no free-text downpipe field", qs(SN(el) as unknown as ShimNode, 'input[type="text"]') === null);
    const values = optionValues(downpipeSelect(el));
    ok("offers Choose a downpipe plus every known downpipe, nothing else", JSON.stringify(values) === JSON.stringify(["", "dp-1", "dp-2"]));
    el.remove();
    restore();
  }

  console.log("\n-- the relink subsection: a clear anomaly, typed confirmation (the downpipe's name), step-up, result --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    let ceremonyRuns = 0;
    setStepUpRunner(async () => { ceremonyRuns++; return "stepup-token-abc"; });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { calls, restore } = scriptedFetch({
      chainView: CHAIN_RELINKABLE_VIEW,
      relinkFirst: { status: 401, body: { stepUpRequired: true } },
      relinkSecond: { status: 200, body: { ok: true, outcome: "relinked", destinationId: "dest-a", downpipeId: "dp-1", acknowledged: "stray-ancestor" } },
    });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-a");
    chooseOption(downpipeSelect(el), "dp-1");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#2"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("shows the RUNLOG verifies", text.includes("The RUNLOG verifies under the current signer"));
    ok("names the anomaly", text.includes("stray-ancestor") && text.includes("an entry's prevRunId does not match the chain"));
    ok("says relinking clears it", text.includes("Relinking this chain clears the anomaly"));
    ok("asked the engine for the chosen destination and downpipe", calls.some((c) => c.path === "/admin/runlog/chain?downpipeId=dp-1&destinationId=dest-a"));
    const relinkBtn = qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.relink"]');
    ok("offers the relink control when canRelink is true", relinkBtn !== null);
    (relinkBtn as unknown as HTMLElement).click();
    await flushAsync();
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal")!;
    const applyBefore = findButtonByText(surface, "Acknowledge and relink")!;
    ok("Acknowledge and relink is disabled before any input", applyBefore.getAttribute("disabled") === "");
    click(applyBefore);
    await flushAsync();
    ok("clicking a disabled Acknowledge and relink sends nothing", calls.every((c) => c.path !== "/admin/runlog/relink"));
    typeInConfirm("Mail archive"); // another downpipe's name: still not the match
    ok("a non-matching downpipe name keeps the control disabled", findButtonByText(surface, "Acknowledge and relink")!.disabled === true);
    typeInConfirm("Ledger"); // dp-1's own name
    ok("the exact downpipe name enables the control", findButtonByText(surface, "Acknowledge and relink")!.disabled === false);
    await clickConfirm("Acknowledge and relink");
    ok("the step-up ceremony ran once", ceremonyRuns === 1);
    const relinkCalls = calls.filter((c) => c.path === "/admin/runlog/relink");
    ok("retried the relink exactly once after step-up, only once the name matched", relinkCalls.length === 2);
    ok("the destination, downpipe, digest and anomaly kind rode on the relink call", relinkCalls.every((c) => c.body.destinationId === "dest-a" && c.body.downpipeId === "dp-1" && c.body.digest === DIGEST && c.body.anomalyKind === "stray-ancestor"));
    ok("the result points at the audit log and the alert", lastToastText().includes("Relinked") && lastToastText().includes("audit log") && lastToastText().includes("alert"));
    el.remove();
    restore();
    setStepUpRunner(async () => null);
  }

  console.log("\n-- the relink subsection: a duplicate-index anomaly shows the engine's exact refusal, no relink control --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const { restore } = scriptedFetch({ chainView: CHAIN_DUPLICATE_INDEX_VIEW });
    const el = renderRunlogResignSection(engine);
    document.body.appendChild(el);
    await flushAsync();
    await flushAsync();
    chooseOption(destinationSelect(el), "dest-a");
    chooseOption(downpipeSelect(el), "dp-2");
    (qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.check#2"]') as unknown as HTMLElement).click();
    await flushAsync();
    await flushAsync();
    const text = textOf(el);
    ok("names the duplicate-index anomaly", text.includes("duplicate-index"));
    ok("shows the engine's exact refusal, including the fresh-destination remedy, verbatim", text.includes(DUPLICATE_INDEX_REFUSAL));
    ok("offers no relink control for a duplicate-index anomaly", qs(SN(el) as unknown as ShimNode, '[data-dp="keys.button.relink"]') === null);
    el.remove();
    restore();
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
