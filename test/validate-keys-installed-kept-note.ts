// Validate that "Keys installed" reports the engine's OWN answer about the configuration keys truthfully,
// for every outcome the engine can send (KeyInstallResult.configured.configRecipient / .configWrapKey).
//
// The engine's install answer already said "kept" when it left an existing configuration key in place
// rather than replacing it (engine src/admin/attach.ts). The console read the answer for other purposes
// but never showed it here: "Keys installed" read the same whether the engine wrote fresh configuration
// keys or kept the ones it held, and when only ONE of the two keys was kept the note claimed BOTH were.
//
// A failed second PUT can also leave the configuration recovery pair half-bound (engine ef0d5398): the
// engine's answer can then be "repaired" (it held a lone private and completed the pair from that half) or
// "kept-partial" (it holds only half a pair and could not complete it, so it is NOT a working recovery
// key). Reporting either of those the same as "kept" would tell the operator the engine holds a working
// recovery key when it may not.
//
// This suite holds the console side: each outcome gets its own truthful sentence, and a partial pair is
// never read as "the engine holds the key".
//
// Run with `node test/validate-keys-installed-kept-note.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import type { ConfigRecipientOutcome, EngineClient } from "../src/api.ts";
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

interface Posted { path: string; body: Record<string, unknown> }

// recordingFetch stands in for the engine, exactly as validate-ceremony-custody.ts's helper of the same
// name: GET /admin/status answers a fixed status, and POST /admin/keys/install answers with the given
// `configured` block (the field under test). configRecipient takes every outcome the engine's ceremony can
// answer, including the two partial-pair ones (ConfigRecipientOutcome), not just installed/kept.
function recordingFetch(configured: { configRecipient: ConfigRecipientOutcome; configWrapKey: "installed" | "kept" }): { posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const reply = url.pathname === "/admin/keys/install"
        ? { ok: true, signerPublic: "PUB", configured: { signer: true, breakGlass: true, operational: false, ...configured } }
        : { ok: true };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: false, private: false }, destConfigured: false, downpipeCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
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

async function renderTab(rekey: boolean): Promise<HTMLElement> {
  const result = fakeResult();
  setCeremony(result, rekey);
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const engine = connect("https://engine.example.com") as EngineClient;
  const tab = renderPostureTab(engine);
  document.body.appendChild(tab);
  await flushAsync();
  await flushAsync();
  return tab;
}

async function main(): Promise<void> {
  console.log("\n-- the engine's answer says it kept a configuration key: only the key it kept is named --");
  for (const [configured, expectNote] of [
    [{ configRecipient: "kept" as const, configWrapKey: "kept" as const }, "Your engine kept its configuration recovery key and its configuration wrap key."],
    [{ configRecipient: "kept" as const, configWrapKey: "installed" as const }, "Your engine kept its configuration recovery key."],
    [{ configRecipient: "installed" as const, configWrapKey: "kept" as const }, "It kept its configuration wrap key."],
  ] as const) {
    const rec = recordingFetch(configured);
    const tab = await renderTab(true);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok(`recipient=${configured.configRecipient} wrap=${configured.configWrapKey}: "Keys installed" still reads`, text.includes("Keys installed"));
    ok(`recipient=${configured.configRecipient} wrap=${configured.configWrapKey}: names only the key the engine actually kept`, text.includes(expectNote));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }
  // Neither single-key-kept combo above claims the OTHER key was kept too (the bug this note existed to
  // avoid repeating on the new partial-pair outcomes): checked as a pair, since each iteration above
  // already closed its own tab.
  {
    const rec = recordingFetch({ configRecipient: "kept", configWrapKey: "installed" });
    const tab = await renderTab(true);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    ok("recipient=kept wrap=installed: does not also claim the wrap key was kept", !textOf(tab).includes("kept its configuration wrap key"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }
  {
    const rec = recordingFetch({ configRecipient: "installed", configWrapKey: "kept" });
    const tab = await renderTab(true);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    ok("recipient=installed wrap=kept: does not also claim the recovery key was kept", !textOf(tab).includes("kept its configuration recovery key"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- the engine's answer says the recovery pair was repaired: the console says so, not that it was kept --");
  {
    const rec = recordingFetch({ configRecipient: "repaired", configWrapKey: "installed" });
    const tab = await renderTab(true);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok('"Keys installed" still reads', text.includes("Keys installed"));
    ok("names the repair: completed from the half already held", text.includes("held half its configuration recovery key and completed it from that half"));
    ok("never claims the pair was simply kept", !text.includes("kept its configuration recovery key"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- the engine's answer says the recovery pair is a kept-partial: never reported as the engine holding the key --");
  {
    const rec = recordingFetch({ configRecipient: "kept-partial", configWrapKey: "installed" });
    const tab = await renderTab(true);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok('"Keys installed" still reads', text.includes("Keys installed"));
    ok("names the gap: holds only half and could not complete it", text.includes("holds half its configuration recovery key and could not complete it"));
    ok("names the fix", text.includes("Add the configuration keys to finish it"));
    ok("never claims the engine holds the recovery key", !text.includes("kept its configuration recovery key"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- CONTROL: the engine's answer says both were installed fresh: no kept note --");
  {
    const rec = recordingFetch({ configRecipient: "installed", configWrapKey: "installed" });
    const tab = await renderTab(false);
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const text = textOf(tab);
    ok('"Keys installed" still reads', text.includes("Keys installed"));
    ok("no kept note appears", !text.includes("kept its configuration"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

void main();
