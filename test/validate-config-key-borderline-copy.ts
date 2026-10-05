// Validate four borderline copy fixes named alongside the configuration-key hazard fix: none of them is
// the hazard itself, but each one either implied a re-key changes the configuration keys, or pointed a
// returning owner at "Replace keys" without saying it never touches those keys.
//
//   B1 (screens/keys/posture.ts, rekeyContinuityWarning): the re-key warning named the signer and the
//      break-glass key but said nothing about the configuration keys, which do not change.
//   B2 (screens/keys/posture.ts, renderAddOperationalEntry): the "advanced: full re-key instead" escape
//      hatch's facts list said only that the signer would rotate, not that the configuration keys would not.
//   B4 (screens/setup/b/q-posture.ts, keysAlready): an already-keyed estate was told "Replacing keys" with
//      a button labelled "Replace keys", with no mention that only the signer and the break-glass key move.
//   B5 (lib/setup-flow/actions.ts, generateKeys and keysPrecheck): the same estate, from the actions layer,
//      was told to "replace them on the Keys screen" without saying what "them" is.
//
// Run with `node test/validate-config-key-borderline-copy.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import type { EngineClient } from "../src/api.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
import { connect, setCaller, setCeremony } from "../src/lib/store.ts";
import { posture } from "../src/screens/setup/b/q-posture.ts";
import { generateKeys } from "../src/lib/setup-flow/actions.ts";
import { setupModel } from "../src/lib/setup-flow/index.ts";
import type { QCtx } from "../src/screens/setup/b/types.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// stubCtx mirrors validate-ceremony-custody.ts's helper of the same name: the smallest context a setup
// question renders against.
function stubCtx(q: QCtx["q"]): QCtx {
  const noop = (): void => undefined;
  return { s: setupModel().get(), q, ret: null, next: noop, go: noop, answer: noop, flight: noop, refresh: noop, setPrimaryLabel: noop, setBusy: noop, rerender: noop };
}

function statusFetch(status: Record<string, unknown>): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

async function main(): Promise<void> {
  console.log("\n-- B1: the re-key continuity warning states the configuration keys do not change --");
  {
    const restore = statusFetch({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: true, private: true }, destConfigured: true, downpipeCount: 0 });
    setCeremony(null);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    await flushAsync();
    const text = textOf(tab);
    ok("the re-key continuity warning rendered (a two-recipient estate returning to Generate keys)", /will rotate the signer/.test(text));
    ok("it states the configuration keys do not change", text.includes("Your configuration recovery key and your configuration wrap key do not change. To get new configuration keys, deploy a new engine."));
    tab.remove();
    restore();
  }

  console.log("\n-- B2: the add-operational escape hatch's facts say the full re-key does not change configuration keys --");
  {
    const restore = statusFetch({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: false, private: false }, destConfigured: true, downpipeCount: 0 });
    setCeremony(null);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    await flushAsync();
    const text = textOf(tab);
    ok("the add-operational card rendered (break-glass-only, no operational key)", /Add an operational key/.test(text));
    ok("its facts state the full re-key stops verification and does not change configuration keys", text.includes("The full re-key rotates the signer and stops that verification. It does not change your configuration keys."));
    tab.remove();
    restore();
  }

  console.log("\n-- B4: the setup Keys view names what the Keys screen replaces, and the button says so --");
  {
    const c = stubCtx("posture");
    c.s = { ...c.s, facts: { ...c.s.facts, keysReady: true } };
    const view = posture(c);
    const bodyText = view.body.map((n) => textOf(n as unknown as HTMLElement)).join(" ");
    ok("the body names the signer and the break-glass key, and says configuration keys do not change", bodyText.includes("The Keys screen can replace your signer and your break-glass key. This makes new key files. The files that you saved before do not open new backups. Your configuration keys do not change."));
    const secondaryLabels = (view.secondary ?? []).map((n) => textOf(n as unknown as HTMLElement));
    ok('the button reads "Open the Keys screen"', secondaryLabels.includes("Open the Keys screen"));
    ok('no button is named exactly "Replace keys"', !secondaryLabels.includes("Replace keys"));
  }

  console.log("\n-- B5: generateKeys' already-keyed refusal says what replacing means, not just where --");
  {
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    // A route-aware stub: refresh() fans out to several engine reads at once (setup-state, downpipes,
    // discovery, destination, approval policy, status), and each needs its OWN shape, not one object
    // reused everywhere, or a later read throws and the whole refresh fails open with stale facts.
    const realFetch = globalThis.fetch;
    const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      switch (url.pathname) {
        case "/admin/setup-state":
          return json({ keysReady: true, signerConfigured: true, breakGlassConfigured: true, emailConfigured: false, discoveryTokenPresent: true, accountsSelected: true, destination: { configured: true, verified: true, kind: "r2", source: "console" }, boundSourceCount: 0, downpipeCount: 0, anyRunCompleted: false, ready: true });
        case "/admin/downpipes":
          return json([]);
        case "/admin/sources/discover":
          return json({ tokenPresent: true, engineAccountId: "acct-1", accounts: [], bound: { kv: [], r2: [], d1: [], secrets: [] } });
        default:
          return json({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: false, private: false }, destConfigured: true, downpipeCount: 0 });
      }
    }) as typeof fetch;
    connect("https://engine.example.com");
    const m = setupModel();
    await m.refresh();
    ok("CONTROL: the model read the engine's keysReady fact as true", m.get().facts.keysReady === true);
    const r = await generateKeys();
    ok("generateKeys refuses (the engine already holds keys)", !r.ok);
    ok("the refusal says what the Keys screen replaces, not just where", !r.ok && r.error.message === "Your engine already holds keys. Continue with them. To replace the signer and the break-glass key, use the Keys screen.");
    globalThis.fetch = realFetch;
    m.reset();
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
