// Validate the console side of the configuration recovery pair's partial-pair repair
// (POST /admin/keys/add-config-recovery), engine ef0d5398.
//
// A failed second PUT during the key ceremony can leave the configuration recovery pair half-bound: the
// engine holds CONFIG_RECIPIENT_PRIVATE but not its public. The targeted add then completes the pair from
// the half already held rather than writing the pair the console just generated, and its answer says
// configRecipient "repaired" (ConfigKeysAddResult). Before this fix the console read installed/rewrap only
// and said nothing about a repair, which would have read as an ordinary fresh install of the pair the
// operator just generated in this browser, when the engine actually kept its own half and threw the
// generated one away.
//
// Run with `node test/validate-config-keys-repair.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

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

interface Posted { path: string; body: Record<string, unknown> }

const KEYED_STATUS = {
  engineVersion: "test",
  ready: true,
  signerConfigured: true,
  breakGlassConfigured: true,
  operationalConfigured: { public: false, private: false },
  destConfigured: true,
  destKind: "r2",
  downpipeCount: 0,
};

// recordingFetch stands in for the engine: GET /admin/status answers the given status, and POST
// /admin/keys/add-config-recovery answers with the given body (the field under test).
function recordingFetch(status: Record<string, unknown>, addConfigRecoveryReply: Record<string, unknown>): { posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.pathname === "/admin/keys/add-config-recovery") {
        const status2 = typeof addConfigRecoveryReply.status === "number" ? (addConfigRecoveryReply.status as number) : 200;
        return new Response(JSON.stringify(addConfigRecoveryReply.body ?? addConfigRecoveryReply), { status: status2, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = realFetch; } };
}

async function applyToken(root: HTMLElement, tokenDp: string, buttonDp: string): Promise<void> {
  const input = root.querySelector(`[data-dp="${tokenDp}"]`) as unknown as HTMLInputElement | null;
  if (input) input.value = "cfat-one-shot-token";
  (root.querySelector(`[data-dp="${buttonDp}"]`) as unknown as HTMLElement | null)?.click();
  await flushAsync();
  await flushAsync();
}

async function renderTabForAdd(status: Record<string, unknown>, addConfigRecoveryReply: Record<string, unknown>): Promise<{ tab: HTMLElement; posted: Posted[]; restore: () => void }> {
  setCeremony(null);
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const rec = recordingFetch(status, addConfigRecoveryReply);
  const engine = connect("https://engine.example.com") as EngineClient;
  const tab = renderPostureTab(engine);
  document.body.appendChild(tab);
  await flushAsync();
  (tab.querySelector('[data-dp="keys.button.generate-config-keys"]') as unknown as HTMLElement | null)?.click();
  await flushAsync();
  await flushAsync();
  return { tab, posted: rec.posted, restore: rec.restore };
}

async function main(): Promise<void> {
  console.log("\n-- the engine's answer says the recovery pair was repaired, not installed fresh --");
  {
    const { tab, posted, restore } = await renderTabForAdd(
      { ...KEYED_STATUS, configKeysConfigured: { recipient: false, wrapKey: true } },
      { ok: true, installed: ["CONFIG_RECIPIENT_PUBLIC"], configRecipient: "repaired" },
    );
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    const add = posted.find((p) => p.path === "/admin/keys/add-config-recovery");
    ok("it POSTed the targeted add", add !== undefined);
    ok('"Configuration keys added" still reads', text.includes("Configuration keys added"));
    ok("it names the repair: the engine completed the pair from the half it held", text.includes("held half its configuration recovery key"));
    ok("it says the generated pair was not used", text.includes("did not use the pair you generated here"));
    tab.remove();
    restore();
  }

  console.log("\n-- CONTROL: the engine's answer says the pair was installed fresh: no repair note --");
  {
    const { tab, restore } = await renderTabForAdd(
      { ...KEYED_STATUS, configKeysConfigured: { recipient: false, wrapKey: true } },
      { ok: true, installed: ["CONFIG_RECIPIENT_PRIVATE", "CONFIG_RECIPIENT_PUBLIC"], configRecipient: "installed" },
    );
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok('"Configuration keys added" still reads', text.includes("Configuration keys added"));
    ok("no repair note appears", !text.includes("held half its configuration recovery key"));
    tab.remove();
    restore();
  }

  console.log("\n-- the engine's dashboard-step refusal for a lone public reaches the operator unwrapped --");
  {
    const refusalSentence = "this engine holds CONFIG_RECIPIENT_PUBLIC without its CONFIG_RECIPIENT_PRIVATE, so auto-heal cannot open the configuration exports sealed to it. This route does not overwrite a bound key, and the engine cannot make the private from the public. In the Cloudflare dashboard, delete the CONFIG_RECIPIENT_PUBLIC secret from this engine's Worker, then add the configuration keys again. The configuration exports already sealed to that public still open with your break-glass identity.key. Nothing was set.";
    const { tab, restore } = await renderTabForAdd(
      { ...KEYED_STATUS, configKeysConfigured: { recipient: false, wrapKey: true } },
      { status: 400, body: { error: refusalSentence } },
    );
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok("the engine's dashboard-step sentence reaches the page", text.includes("delete the CONFIG_RECIPIENT_PUBLIC secret from this engine's Worker"));
    ok("it names that break-glass still opens the sealed exports", text.includes("still open with your break-glass identity.key"));
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
