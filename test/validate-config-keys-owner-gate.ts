// Validate that a non-Owner caller is refused the "Generate configuration keys" control on the Keys
// screen (src/screens/keys/config-keys.ts, renderAddConfigKeysEntry).
//
// The card only wires a click handler to runConfigKeysCeremony when canDo("owner") reads true. A caller
// below Owner must see the control refused in place (aria-disabled, with a reason) rather than offered,
// and clicking it must not reach the ceremony. The engine re-checks the same gate on its own route, so
// this is the console's half: the control itself must not invite an action the engine will refuse anyway.
//
// Run with `node test/validate-config-keys-owner-gate.ts`.

import { installDomShim, flushAsync } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
import { connect, setCaller, setCeremony } from "../src/lib/store.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const NEEDS_CONFIG_KEYS_STATUS = {
  engineVersion: "test",
  ready: true,
  signerConfigured: true,
  breakGlassConfigured: true,
  operationalConfigured: { public: false, private: false },
  destConfigured: true,
  destKind: "r2",
  downpipeCount: 0,
  configKeysConfigured: { recipient: false, wrapKey: false },
};

function recordingFetch(): { posted: string[]; restore: () => void } {
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      posted.push(url.pathname);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(NEEDS_CONFIG_KEYS_STATUS), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = realFetch; } };
}

async function renderTabAs(role: "owner" | "viewer"): Promise<{ tab: HTMLElement; posted: string[]; restore: () => void }> {
  setCeremony(null);
  setCaller({ method: "passkey", email: `${role}@example.com`, role, groups: [], isOnlyOwner: role === "owner" });
  const rec = recordingFetch();
  const engine = connect("https://engine.example.com") as EngineClient;
  const tab = renderPostureTab(engine);
  document.body.appendChild(tab);
  await flushAsync();
  await flushAsync();
  return { tab, posted: rec.posted, restore: rec.restore };
}

async function main(): Promise<void> {
  console.log("\n-- a Viewer caller does not get a working Generate configuration keys control --");
  {
    const { tab, posted, restore } = await renderTabAs("viewer");
    const btn = tab.querySelector('[data-dp="keys.button.generate-config-keys"]') as unknown as HTMLElement | null;
    ok("the button is present (shown, not hidden)", btn !== null);
    ok("it is marked aria-disabled", btn?.getAttribute("aria-disabled") === "true");
    ok("it carries a reason naming the Owner role", (btn?.getAttribute("title") ?? "").includes("Owner"));
    btn?.click();
    await flushAsync();
    await flushAsync();
    ok("clicking it never reached the engine", !posted.includes("/admin/keys/add-config-recovery"));
    tab.remove();
    restore();
  }

  console.log("\n-- CONTROL: an Owner caller gets a working control that reaches the engine on click --");
  {
    const { tab, posted, restore } = await renderTabAs("owner");
    const btn = tab.querySelector('[data-dp="keys.button.generate-config-keys"]') as unknown as HTMLElement | null;
    ok("the button is present", btn !== null);
    ok("it is not aria-disabled for an Owner", btn?.getAttribute("aria-disabled") !== "true");
    btn?.click();
    await flushAsync();
    await flushAsync();
    const tokenInput = tab.querySelector('[data-dp="keys.password.token"]') as unknown as HTMLInputElement | null;
    if (tokenInput) tokenInput.value = "cfat-one-shot-token";
    (tab.querySelector('[data-dp="keys.button.apply"]') as unknown as HTMLElement | null)?.click();
    await flushAsync();
    await flushAsync();
    ok("clicking it as Owner reaches the engine", posted.includes("/admin/keys/add-config-recovery"));
    tab.remove();
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
