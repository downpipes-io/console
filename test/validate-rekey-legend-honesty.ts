// Validate the "Keys generated" legend never claims the configuration keys install when the engine keeps
// the ones it already holds.
//
// custodyLegend (screens/keys/posture.ts) said, on every render, that CONFIG_RECIPIENT_PRIVATE and
// CONFIG_WRAP_KEY "install straight to your engine". That is false on a re-key: the engine keeps a
// configuration key it already holds (engine src/admin/attach.ts), so the legend contradicted the
// "Install your keys to your engine" paragraph on the very same card, which already said an engine that
// holds a configuration key keeps it.
//
// This suite holds the console side of the fix: a first-install legend states the real condition on each
// configuration line; a re-key legend drops those two lines from "Goes to your engine" and states, in a
// "Not changed" column, that the engine keeps the keys it holds.
//
// Run with `node test/validate-rekey-legend-honesty.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
import { connect, setCaller, setCeremony } from "../src/lib/store.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function fakeResult(): CeremonyResult {
  return {
    breakGlass: { identityB64: "BREAKGLASS-PRIVATE-VALUE", recipientPublicB64: "BREAKGLASS-PUBLIC-VALUE", fingerprint: "dpr1:breakglass" },
    operational: null,
    signer: { privateB64: "SIGNER-PRIVATE-VALUE", publicB64: "SIGNER-PUBLIC-VALUE", fingerprint: "edmldsa1:signer" },
    configRecipient: { identityB64: "CONFIG-RECIPIENT-PRIVATE-VALUE", recipientPublicB64: "CONFIG-RECIPIENT-PUBLIC-VALUE", fingerprint: "dpr1:configrecipient" },
    configWrapKeyB64: "CONFIG-WRAP-KEY-VALUE",
  };
}

function stubFetch(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: false, private: false }, destConfigured: false, downpipeCount: 0 }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

async function renderTab(rekey: boolean): Promise<HTMLElement> {
  const result = fakeResult();
  setCeremony(result, rekey);
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const restore = stubFetch();
  const engine = connect("https://engine.example.com") as EngineClient;
  const tab = renderPostureTab(engine);
  document.body.appendChild(tab);
  await flushAsync();
  await flushAsync();
  restore();
  setCeremony(null);
  return tab;
}

async function main(): Promise<void> {
  console.log("\n-- a first-install legend states the real condition on each configuration line --");
  {
    const tab = await renderTab(false);
    const text = textOf(tab);
    ok("the legend no longer claims an unconditional install of CONFIG_RECIPIENT_PRIVATE", !/CONFIG_RECIPIENT_PRIVATE, installs straight to your engine/.test(text));
    ok("the legend no longer claims an unconditional install of CONFIG_WRAP_KEY", !/CONFIG_WRAP_KEY, installs straight to your engine/.test(text));
    ok("the legend states the recovery key's real condition", text.includes("CONFIG_RECIPIENT_PRIVATE. It installs to your engine only if your engine does not hold one."));
    ok("the legend states the wrap key's real condition", text.includes("CONFIG_WRAP_KEY. It installs to your engine only if your engine does not hold one."));
    tab.remove();
  }

  console.log("\n-- a re-key legend states the engine keeps its configuration keys, not that they install --");
  {
    const tab = await renderTab(true);
    const text = textOf(tab);
    ok("no claim that CONFIG_RECIPIENT_PRIVATE installs to the engine", !text.includes("CONFIG_RECIPIENT_PRIVATE, installs straight to your engine") && !text.includes("CONFIG_RECIPIENT_PRIVATE. It installs to your engine"));
    ok("no claim that CONFIG_WRAP_KEY installs to the engine", !text.includes("CONFIG_WRAP_KEY, installs straight to your engine") && !text.includes("CONFIG_WRAP_KEY. It installs to your engine"));
    ok("the legend has a Not changed column", /Not changed/.test(text));
    ok("the Not changed row names both configuration keys and says the engine keeps them", text.includes("Your configuration recovery key and your configuration wrap key. Your engine keeps the keys that it holds. To get new configuration keys, deploy a new engine."));
    // Consistency control: this must not contradict the same card's wiring paragraph, which already says
    // an engine that already holds a configuration key keeps it.
    ok("CONTROL: consistent with the wiring paragraph on the same card", /An engine that already holds a configuration key keeps it\./.test(text));
    tab.remove();
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
