// Cloudflare-wide Remove (Sources screen, cf-wide.ts): when the source type backs one or more
// downpipes, Remove must confirm BEFORE it calls the engine, name what already uses the type and the
// true consequence, and the result toast must not use the default success tone.
//
// Drives the REAL cfWideTier over the shared DOM shim (so the real confirmModal / toast render) with a
// fake EngineClient; it never re-implements the confirm or toast logic.
//
// Run with: node test/validate-cf-wide-remove.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qs, qsa, flushAsync, textOf, type ShimNode } from "./dom-shim.ts";
import { SN, findButtonByText, click } from "./validate-stable-components-shared.ts";
import { cfWideTier, type CfWideBacking } from "../src/screens/sources/cf-wide.ts";
import type { EngineClient, SourceDiscovery, DiscoveryStatus } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A discovery result with every token source supported and "cf-config" already added, so the Remove
// row renders for it.
function discovery(): SourceDiscovery {
  return {
    bound: { kv: [], r2: [], d1: [], secrets: [] },
    tokenPresent: true,
    engineAccountId: "a1",
    cfConfigSurfaces: [{ id: "dns_records", label: "DNS records", category: "DNS", scope: "zone" as const, restoreTier: "auto" }],
    workersSupported: true,
    streamSupported: true,
    imagesSupported: true,
    artifactsSupported: true,
    addedSources: ["cf-config"],
  } as SourceDiscovery;
}

function fakeEngine(calls: string[][]): EngineClient {
  return {
    setEnabledSources: async (sources: string[]) => {
      calls.push(sources);
      return { present: true, enabledSources: sources } as DiscoveryStatus;
    },
  } as unknown as EngineClient;
}

// answerModal waits for the next confirm dialog to render and clicks the button with the given label
// (the confirm or Cancel), then flushes so the click's own promise chain can continue.
async function answerModal(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) return;
  const btn = findButtonByText(surface, label);
  if (btn) click(btn);
  await flushAsync();
}

function removeButton(section: unknown): ShimNode {
  const btn = findButtonByText(section as unknown as ShimNode, "Remove");
  if (!btn) throw new Error("expected a Remove button on the cf-config row");
  return btn;
}

// lastToast: toasts auto-dismiss on a REAL timer (the shim never fakes it), so earlier blocks' toasts
// are still in the DOM when a later block runs. Always read the most recently appended one.
function lastToast(): ShimNode | null {
  const toasts = qsa(SN(document.body) as unknown as ShimNode, ".toast");
  return toasts.length > 0 ? (toasts[toasts.length - 1] as ShimNode) : null;
}

// dismissToastNow clicks the toast's own close button, which cancels its real auto-dismiss timer (the
// component never fakes it). Without this the process would sit waiting on that timer before it exits.
function dismissToastNow(toastEl: ShimNode | null): void {
  if (!toastEl) return;
  const btn = qs(toastEl, ".toast__close");
  if (btn) click(btn);
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------------
  console.log("\n-- Remove on a type backed by downpipes: confirms first, names the downpipes and the true consequence --");
  // ------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const engine = fakeEngine(calls);
    const backing: CfWideBacking = {
      byType: new Map([["cf-config", [{ id: "dp1", name: "Zone A config" }, { id: "dp2", name: "Zone B config" }]]]),
      known: true,
    };
    const section = cfWideTier(engine, discovery(), () => {}, true, backing);
    if (!section) throw new Error("expected the cf-wide tier to render");
    const btn = removeButton(section);
    click(btn);
    await flushAsync();

    ok("clicking Remove does NOT call the engine yet", calls.length === 0);
    ok("the row button is not left mid-action while the confirm is open", (btn as unknown as HTMLButtonElement).textContent === "Remove");

    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
    ok("a confirm dialog is shown", surface !== null);
    const bodyText = surface ? textOf(surface) : "";
    ok("the confirm names both backing downpipes", bodyText.includes("Zone A config") && bodyText.includes("Zone B config"));
    ok("the confirm states the true engine consequence", bodyText.includes("Removing hides Cloudflare config from New downpipe") && bodyText.includes("keep running unchanged"));

    // Cancel: nothing is sent to the engine.
    await answerModal("Cancel");
    ok("Cancel calls nothing", calls.length === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Accepting the confirm calls the engine once, and the result toast is not the success tone --");
  // ------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const engine = fakeEngine(calls);
    const backing: CfWideBacking = { byType: new Map([["cf-config", [{ id: "dp1", name: "Zone A config" }]]]), known: true };
    const section = cfWideTier(engine, discovery(), () => {}, true, backing);
    if (!section) throw new Error("expected the cf-wide tier to render");
    click(removeButton(section));
    await answerModal("Remove");

    ok("accepting the confirm calls the engine exactly once", calls.length === 1);
    ok("the engine call carries the desired set with cf-config removed", (calls[0] ?? []).includes("cf-config") === false);

    const toastEl = lastToast();
    ok("a toast is shown", toastEl !== null);
    ok("the toast is NOT the default success tone", toastEl !== null && !SN(toastEl).classList.contains("toast--success"));
    ok("the toast uses the info tone", toastEl !== null && SN(toastEl).classList.contains("toast--info"));
    const toastText = toastEl ? textOf(toastEl) : "";
    ok("the toast does not claim the downpipe was touched", !toastText.includes("removed") || toastText.includes("Cloudflare config removed as a source"));
    ok("the toast says the downpipe keeps running", toastText.includes("keep running"));
    dismissToastNow(toastEl); // cancel its real timer so the process is not left waiting on it
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Remove on a type with no backing downpipe: still confirms (matches this screen's other Remove/Detach actions), says so honestly --");
  // ------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const engine = fakeEngine(calls);
    const backing: CfWideBacking = { byType: new Map(), known: true };
    const section = cfWideTier(engine, discovery(), () => {}, true, backing);
    if (!section) throw new Error("expected the cf-wide tier to render");
    click(removeButton(section));
    await flushAsync();
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
    ok("a confirm dialog is shown even with zero backing downpipes", surface !== null);
    const bodyText = surface ? textOf(surface) : "";
    ok("the confirm says honestly that nothing uses it yet", bodyText.includes("No downpipe uses Cloudflare config yet"));
    ok("no engine call before the confirm is accepted", calls.length === 0);
    await answerModal("Remove");
    ok("accepting still calls the engine", calls.length === 1);
    dismissToastNow(lastToast()); // cancel its real timer so the process is not left waiting on it
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Downpipe coverage unknown (list load failed): Remove still confirms, says it could not check --");
  // ------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const engine = fakeEngine(calls);
    const backing: CfWideBacking = { byType: new Map(), known: false };
    const section = cfWideTier(engine, discovery(), () => {}, true, backing);
    if (!section) throw new Error("expected the cf-wide tier to render");
    click(removeButton(section));
    await flushAsync();
    const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
    const bodyText = surface ? textOf(surface) : "";
    ok("the confirm admits it could not check downpipe use", bodyText.includes("could not be checked"));
    ok("no engine call before the confirm is accepted", calls.length === 0);
    await answerModal("Cancel");
    ok("Cancel calls nothing even in the unknown case", calls.length === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n-- Add stays one click: no confirm, and keeps the default success tone --");
  // ------------------------------------------------------------------------
  {
    const calls: string[][] = [];
    const engine = fakeEngine(calls);
    const found = { ...discovery(), addedSources: [] } as SourceDiscovery;
    const backing: CfWideBacking = { byType: new Map(), known: true };
    const section = cfWideTier(engine, found, () => {}, true, backing);
    if (!section) throw new Error("expected the cf-wide tier to render");
    const addBtn = findButtonByText(section as unknown as ShimNode, "Add");
    if (!addBtn) throw new Error("expected an Add button on the cf-config row");
    click(addBtn);
    await flushAsync();
    ok("Add calls the engine with no confirm", calls.length === 1);
    const toastEl = lastToast();
    ok("Add's toast keeps the default success tone", toastEl !== null && SN(toastEl).classList.contains("toast--success"));
    dismissToastNow(toastEl); // cancel its real timer so the process is not left waiting on it
  }

  console.log(failures === 0 ? "\nCF-WIDE-REMOVE VECTORS PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exit(1);
}

void main();
