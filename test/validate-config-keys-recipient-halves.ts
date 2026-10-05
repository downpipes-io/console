// Validate that the "Add configuration keys" entry card reads GET /admin/status's recipientHalves
// (engine ef0d5398 status.ts) to tell a lone public apart from a lone private or no key at all, rather than
// offering an add the engine always refuses.
//
// Before recipientHalves existed, the console read only the coarse `recipient` boolean (true only when
// BOTH halves are bound), so a lone public and a lone private both read as "not installed" and the entry
// card offered the same "Generate configuration keys" add for either. The engine refuses that add on a
// lone public (attach.ts lonePublicFault: it cannot derive the private from the public, and never overwrites
// a bound key), so the offered add always failed with the dashboard-step refusal. This suite holds the
// console side of the fix: a lone public gets the dashboard-step fact and no add button for the recovery
// key; a lone private (completable) and no key at all keep the ordinary add.
//
// Run with `node test/validate-config-keys-recipient-halves.ts`.

import { installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

import type { EngineClient, StatusReport } from "../src/api.ts";
import { needsConfigKeys, renderAddConfigKeysEntry } from "../src/screens/keys/config-keys.ts";
import { connect, setCaller } from "../src/lib/store.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const BASE: StatusReport = {
  service: "downpipe-engine",
  engineVersion: "test",
  signerConfigured: true,
  breakGlassConfigured: true,
  operationalConfigured: { public: false, private: false },
  configKeysConfigured: { recipient: false, wrapKey: true },
  destConfigured: true,
  destKind: "r2",
  updateChannelConfigured: true,
  licenceConfigured: true,
  downpipeCount: 0,
  ready: true,
};

function statusWith(recipientHalves: { public: boolean; private: boolean } | undefined): StatusReport {
  return { ...BASE, configKeysConfigured: { recipient: false, wrapKey: true, ...(recipientHalves !== undefined ? { recipientHalves } : {}) } };
}

function main(): void {
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const engine = connect("https://engine.example.com") as EngineClient;

  console.log("\n-- a lone public: the dashboard step is named, and no add is offered --");
  {
    const s = statusWith({ public: true, private: false });
    ok("needsConfigKeys still true (the engine holds no working recovery key)", needsConfigKeys(s));
    const card = renderAddConfigKeysEntry(engine, s);
    const text = textOf(card);
    ok("names the dashboard step", text.includes("delete the CONFIG_RECIPIENT_PUBLIC secret from this engine's Worker"));
    ok("says break-glass still opens sealed exports", text.includes("still open with your break-glass identity.key"));
    ok("offers no generate-keys button (the engine would refuse it)", card.querySelector('[data-dp="keys.button.generate-config-keys"]') === null);
  }

  console.log("\n-- a lone private: the ordinary add is offered (the engine completes it) --");
  {
    const s = statusWith({ public: false, private: true });
    const card = renderAddConfigKeysEntry(engine, s);
    const text = textOf(card);
    ok("does not show the dashboard step", !text.includes("delete the CONFIG_RECIPIENT_PUBLIC secret"));
    ok("offers the generate-keys button", card.querySelector('[data-dp="keys.button.generate-config-keys"]') !== null);
  }

  console.log("\n-- no recovery key at all: the ordinary add is offered --");
  {
    const s = statusWith({ public: false, private: false });
    const card = renderAddConfigKeysEntry(engine, s);
    ok("offers the generate-keys button", card.querySelector('[data-dp="keys.button.generate-config-keys"]') !== null);
  }

  console.log("\n-- an engine on a version before recipientHalves existed: falls back to the ordinary add --");
  {
    const s = statusWith(undefined);
    const card = renderAddConfigKeysEntry(engine, s);
    ok("recipientHalves honestly absent does not crash the read", card !== null);
    ok("falls back to offering the ordinary add (cannot tell a lone public apart without the field)", card.querySelector('[data-dp="keys.button.generate-config-keys"]') !== null);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
  verdictReached(failures);
  if (failures > 0) process.exit(1);
}

main();
