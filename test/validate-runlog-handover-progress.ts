// The Keys > Posture re-key flow shows the hand-over of each destination's backup RUNLOG from the old
// signer to the new one, and the hold on new runs while it is in progress, from whatever status the engine
// reports (KeyInstallResult.runlogHandover). Before this, the console ignored that field entirely: a
// deliberate re-key could leave a destination pending the attended re-sign with no sign of it in the
// console at all.
//
// This suite drives the real renderPostureTab over the shared dom-shim, exactly as
// validate-keys-installed-kept-note.ts does, with a scripted POST /admin/keys/install reply that carries
// runlogHandover. It never re-implements the screen or the client.
//
// Run with `node test/validate-runlog-handover-progress.ts`.

import { flushAsync, installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

import type { EngineClient, RunlogHandoverSummary } from "../src/api.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import { connect, setCaller, setCeremony } from "../src/lib/store.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
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

function recordingFetch(runlogHandover: RunlogHandoverSummary | undefined): { restore: () => void } {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      const reply = url.pathname === "/admin/keys/install"
        ? {
            ok: true,
            signerPublic: "PUB",
            configured: { signer: true, breakGlass: true, operational: false, configRecipient: "installed", configWrapKey: "installed" },
            ...(runlogHandover ? { runlogHandover } : {}),
          }
        : { ok: true };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: false, private: false }, destConfigured: false, downpipeCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; } };
}

async function applyToken(root: HTMLElement): Promise<void> {
  const input = root.querySelector('[data-dp="keys.password.token"]') as unknown as HTMLInputElement | null;
  if (input) input.value = "cfat-one-shot-token";
  (root.querySelector('[data-dp="keys.button.apply"]') as unknown as HTMLElement | null)?.click();
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
  console.log("\n-- a re-key names the hold on new runs before the install --");
  {
    const rec = recordingFetch(undefined);
    const tab = await renderTab(true);
    ok("states the RUNLOG hand-over and the hold on new runs", textOf(tab).includes("hands it to the new signer") && textOf(tab).includes("New runs are held until this finishes"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- a first install (no re-key) says nothing about a hand-over: there is no prior signer --");
  {
    const rec = recordingFetch(undefined);
    const tab = await renderTab(false);
    ok("no hand-over copy on a first install", !textOf(tab).includes("hands it to the new signer"));
    await applyToken(tab);
    ok("no hand-over note after a plain install with no runlogHandover field", !textOf(tab).includes("Destination RUNLOGs:"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- a re-key hand-over that resigned some and left others pending --");
  {
    const summary: RunlogHandoverSummary = {
      outcomes: [
        { id: "dest-a", outcome: "re-signed" },
        { id: "dest-b", outcome: "re-signed" },
        { id: "dest-c", outcome: "already-current" },
      ],
      pending: ["dest-d"],
      heldKeyDiscarded: false,
    };
    const rec = recordingFetch(summary);
    const tab = await renderTab(true);
    await applyToken(tab);
    const text = textOf(tab);
    ok("names the number handed over", text.includes("handed 2 over to the new signer"));
    ok("names the number already current", text.includes("1 already signed under it"));
    ok("names the pending destination and the attended re-sign", text.includes("1 did not verify under either signer and wait for the attended re-sign"));
    ok("states new runs to the pending destination are held", text.includes("New runs to them are held until then"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- a re-key over a signer that could not be read: no hand-over attempted --");
  {
    const summary: RunlogHandoverSummary = { outcomes: [], pending: [], heldKeyDiscarded: false, skipped: "outgoing-signer-unreadable" };
    const rec = recordingFetch(summary);
    const tab = await renderTab(true);
    await applyToken(tab);
    const text = textOf(tab);
    ok("states no hand-over ran", text.includes("no destination RUNLOG was handed over"));
    ok("points at the attended re-sign", text.includes("attended re-sign"));
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- CONTROL: every destination already handed over, nothing pending --");
  {
    const summary: RunlogHandoverSummary = { outcomes: [{ id: "dest-a", outcome: "re-signed" }], pending: [], heldKeyDiscarded: true };
    const rec = recordingFetch(summary);
    const tab = await renderTab(true);
    await applyToken(tab);
    const text = textOf(tab);
    ok("names the hand-over", text.includes("handed 1 over to the new signer"));
    ok("says nothing is pending", !text.includes("wait for the attended re-sign"));
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
