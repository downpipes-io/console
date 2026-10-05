// Validate the Wrangler fallback on the Keys screen never carries the configuration keys on a re-key.
//
// renderWiring (screens/keys/posture.ts) always renders the collapsed Wrangler fallback section, on every
// path, including a re-key of an estate whose engine already holds CONFIG_RECIPIENT_PRIVATE,
// CONFIG_RECIPIENT_PUBLIC and CONFIG_WRAP_KEY. The engine refuses to replace a configuration key over its
// own route (POST /admin/keys/add-config-recovery) because a new configuration recovery key cannot open the
// configuration exports the engine sealed to the old one, and a new configuration wrap key makes every
// stored credential unreadable. Wrangler has no such refusal: an operator who runs the three commands the
// fallback used to print, with the NEW values it used to show, gets past the engine's own guard and loses
// its configuration exports and every stored credential.
//
// This suite holds the console side of the fix: on a re-key render, none of the three CONFIG_ commands and
// none of the three new values (revealed or not) appear anywhere on the page, and the page states the reason
// instead. On a first-install render (no prior signer), the three commands still appear, guarded by one
// condition line.
//
// Run with `node test/validate-rekey-wrangler-fallback.ts`.

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

// A fabricated ceremony result: posture.ts never validates the cryptography, only renders the fields, so
// distinct, recognisable placeholder strings are enough to prove which values the page does or does not show.
function fakeResult(): CeremonyResult {
  return {
    breakGlass: { identityB64: "BREAKGLASS-PRIVATE-VALUE", recipientPublicB64: "BREAKGLASS-PUBLIC-VALUE", fingerprint: "dpr1:breakglass" },
    operational: null,
    signer: { privateB64: "SIGNER-PRIVATE-VALUE", publicB64: "SIGNER-PUBLIC-VALUE", fingerprint: "edmldsa1:signer" },
    configRecipient: { identityB64: "CONFIG-RECIPIENT-PRIVATE-VALUE", recipientPublicB64: "CONFIG-RECIPIENT-PUBLIC-VALUE", fingerprint: "dpr1:configrecipient" },
    configWrapKeyB64: "CONFIG-WRAP-KEY-VALUE",
  };
}

// A minimal GET /admin/status stub: renderPosture and renderPostureAcknowledgement each read it once. Its
// exact shape does not matter to the section under test (the ceremony result card renders from the in-memory
// ceremony, not from this read), so long as it resolves without throwing.
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

// revealAllAndText clicks every keyField reveal toggle under root, then returns the text: a value hidden
// behind a reveal toggle (dots by default) is absent from textOf either way, so the only way to prove a
// value cannot be reached AT ALL is to reveal everything there is to reveal and check again.
function revealAllAndText(root: HTMLElement): string {
  for (const btn of [...root.querySelectorAll('[data-dp="components-code-block.toggle.reveal"]')]) {
    (btn as unknown as HTMLElement).click();
  }
  return textOf(root);
}

async function main(): Promise<void> {
  console.log("\n-- a re-key render carries none of the three CONFIG_ commands and none of the new values --");
  {
    const tab = await renderTab(true);
    const text = textOf(tab);
    ok("the ceremony result card rendered (the wiring section is on screen)", /Install your keys to your engine/.test(text));
    ok("no CONFIG_WRAP_KEY secret-put command", !text.includes("secret put CONFIG_WRAP_KEY"));
    ok("no CONFIG_RECIPIENT_PRIVATE secret-put command", !text.includes("secret put CONFIG_RECIPIENT_PRIVATE"));
    ok("no CONFIG_RECIPIENT_PUBLIC secret-put command", !text.includes("secret put CONFIG_RECIPIENT_PUBLIC"));
    // Structural absence, not merely un-revealed: no reveal control for either concealed configuration
    // value exists on this path at all.
    ok("no reveal control for the configuration recovery private value", tab.querySelectorAll('[aria-label="Reveal CONFIG_RECIPIENT_PRIVATE value"]').length === 0);
    ok("no reveal control for the configuration wrap key value", tab.querySelectorAll('[aria-label="Reveal CONFIG_WRAP_KEY value"]').length === 0);
    const revealed = revealAllAndText(tab);
    ok("the new configuration recovery private value is nowhere on the page, even revealed", !revealed.includes("CONFIG-RECIPIENT-PRIVATE-VALUE"));
    ok("the new configuration wrap key value is nowhere on the page, even revealed", !revealed.includes("CONFIG-WRAP-KEY-VALUE"));
    ok("the page states the reason instead of the commands", /deploy a new engine/.test(text) && /unreadable/.test(text));
    // Negative control: the signer command (which the re-key DOES legitimately carry, warned, with
    // confirmRekey) still appears, so a suite that stripped the whole fallback section could not pass.
    ok("CONTROL: the signer command is still present", text.includes("secret put SIGNER_PRIVATE"));
    tab.remove();
  }

  console.log("\n-- a first-install render keeps the three CONFIG_ commands, guarded by the one-line condition --");
  {
    const tab = await renderTab(false);
    const text = textOf(tab);
    ok("the ceremony result card rendered (the wiring section is on screen)", /Install your keys to your engine/.test(text));
    ok("the CONFIG_WRAP_KEY secret-put command is present", text.includes("secret put CONFIG_WRAP_KEY"));
    ok("the CONFIG_RECIPIENT_PRIVATE secret-put command is present", text.includes("secret put CONFIG_RECIPIENT_PRIVATE"));
    ok("the CONFIG_RECIPIENT_PUBLIC secret-put command is present", text.includes("secret put CONFIG_RECIPIENT_PUBLIC"));
    ok("the one-line condition guards the three commands", /only on an engine that does not hold them/.test(text));
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
