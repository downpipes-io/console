// Validate what the in-browser key ceremony leaves on the operator's machine, and what it sends to the engine.
//
// SIGNER.KEY (finding ARCH-03). The ceremony used to download the signer private as signer.key, in the
// automatic burst, again as a "To engine" row on the onboarding card, and again from the Keys screen legend.
// Nothing in the console reads that file back: the install sends the signer private from memory in the
// POST /admin/keys/install body. So the only effect of the download was a forgery-capable signing key in the
// operator's Downloads folder, outside the account. The custody matrix says the customer holds no offline
// copy of the signer private. This suite holds the ceremony to that:
//   - the automatic burst delivers no signer.key, and no file carries the signer private;
//   - the setup surface's key files (the Saved question) offer no signer.key row, and its trust line says
//     the signing key goes to the engine at Apply;
//   - the Keys screen legend offers no signer.key download and carries the same plain label.
// Negative controls: the burst still delivers identity.key and signer.pub, and the Saved question still offers
// them, so a suite that found no files at all could not pass.
//
// THE CONFIGURATION KEYS (finding CRY-01). Only the terminal ceremony used to make CONFIG_RECIPIENT_* and
// CONFIG_WRAP_KEY, so a console-keyed engine sealed its configuration export to break-glass only and stored
// credentials on the plaintext floor. This suite holds the console half of the fix:
//   - runKeyCeremony returns a configuration recovery pair (the public derives from the private) and a 32-byte
//     wrap key, in BOTH postures;
//   - both install paths (the setup surface's Apply and the Keys screen install) send all three values;
//   - no download and no recovery sheet carries either private value;
//   - the Keys screen offers the targeted add for a keyed engine that lacks them, sends only the missing keys,
//     and offers nothing when the engine holds both.
//
// Run with `node test/validate-ceremony-custody.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { x25519 } from "@noble/curves/ed25519.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { b64urlDecode, b64urlEncode, concat } from "../src/bytes.ts";
import { isCeremonyResult, runKeyCeremony, type CeremonyResult } from "../src/keygen.ts";
import { recoverySheet, recoverySheetHTML } from "../src/recovery-sheet.ts";
import { connect, getCeremony, setCaller, setCeremony } from "../src/lib/store.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
import { downloadCeremonyFiles } from "../src/lib/setup-flow/ceremony-files.ts";
import { applyWithDeployToken, selfDeployPlan, setupModel } from "../src/lib/setup-flow/index.ts";
import { custody, savedKeys } from "../src/screens/setup/b/q-keys.ts";
import type { QCtx } from "../src/screens/setup/b/types.ts";
import type { EngineClient } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// captureDownloads records every file the console hands the browser: the anchor's download name and the
// Blob's text. deliverFile (lib/file-delivery.ts) builds a Blob, takes an object URL for it and clicks an
// anchor that carries the file name, so both halves are read at the two points the browser would see them.
interface Delivered { name: string; content: string }
function captureDownloads(): { delivered: Delivered[]; settle: () => Promise<void> } {
  const blobs: Blob[] = [];
  const names: string[] = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    blobs.push(b);
    return `blob:stub-${blobs.length}`;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  const body = document.body as unknown as { appendChild: (n: unknown) => unknown };
  const realAppend = body.appendChild.bind(body);
  body.appendChild = (n: unknown) => {
    const a = n as { download?: unknown };
    if (typeof a.download === "string" && a.download !== "") names.push(a.download);
    return realAppend(n);
  };
  const delivered: Delivered[] = [];
  return {
    delivered,
    settle: async () => {
      body.appendChild = realAppend;
      for (let i = 0; i < names.length; i++) {
        const blob = blobs[i];
        delivered.push({ name: names[i] ?? "", content: blob ? await blob.text() : "" });
      }
    },
  };
}

const SIGNER_PRIVATE_LABEL = "downpipe-signer-private-v1";

// recordingFetch stands in for the engine: GET /admin/status answers the given status, and every POST is
// recorded (path and parsed body) and answered with a success. Returns the record and a restore function.
interface Posted { path: string; body: Record<string, unknown> }
function recordingFetch(status: Record<string, unknown>): { posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const reply = url.pathname === "/admin/keys/install"
        ? { ok: true, signerPublic: "PUB", configured: { signer: true, breakGlass: true, operational: false, configRecipient: "installed", configWrapKey: "installed" } }
        : { ok: true, installed: [] };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = realFetch; } };
}

// applyToken types a token into the one visible token field under root and presses the button whose data-dp
// is given, then lets the apply settle.
async function applyToken(root: HTMLElement, tokenDp: string, buttonDp: string): Promise<void> {
  const input = root.querySelector(`[data-dp="${tokenDp}"]`) as unknown as HTMLInputElement | null;
  if (input) input.value = "cfat-one-shot-token";
  (root.querySelector(`[data-dp="${buttonDp}"]`) as unknown as HTMLElement | null)?.click();
  await flushAsync();
  await flushAsync();
}

// stubCtx is the smallest context a setup question renders against: the model's current snapshot, and no-op
// navigation (the question's controls are read, not driven).
function stubCtx(q: QCtx["q"]): QCtx {
  const noop = (): void => undefined;
  return { s: setupModel().get(), q, ret: null, next: noop, go: noop, answer: noop, flight: noop, refresh: noop, setPrimaryLabel: noop, setBusy: noop, rerender: noop };
}

// setupFetch stands in for a fresh engine the setup surface is applying to: setup-state says no keys yet,
// discovery names the engine's account (the install needs it), status reports the keys present (so the wait
// after the install ends at once), and every POST is recorded and answered with a success.
function setupFetch(): { posted: Posted[]; restore: () => void } {
  const posted: Posted[] = [];
  const realFetch = globalThis.fetch;
  const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return json(url.pathname === "/admin/keys/install" ? { ok: true, signerPublic: "PUB", configured: { signer: true, breakGlass: true, operational: false, configRecipient: "installed", configWrapKey: "installed" } } : { ok: true });
    }
    switch (url.pathname) {
      case "/admin/setup-state":
        return json({ keysReady: false, signerConfigured: false, breakGlassConfigured: false, emailConfigured: false, discoveryTokenPresent: true, accountsSelected: true, destination: { configured: true, verified: true, kind: "r2", source: "console" }, boundSourceCount: 0, downpipeCount: 0, anyRunCompleted: false, ready: false });
      case "/admin/sources/discover":
        return json({ tokenPresent: true, engineAccountId: "acct-1", accounts: [{ accountId: "acct-1", accountName: "Test account", kv: [], r2: [], d1: [], secrets: [], zones: [] }], bound: { kv: [], r2: [], d1: [], secrets: [] } });
      case "/admin/downpipes":
        return json([]);
      default:
        return json(KEYED_STATUS);
    }
  }) as typeof fetch;
  return { posted, restore: () => { globalThis.fetch = realFetch; } };
}

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

async function main(): Promise<void> {
  for (const operational of [false, true]) {
    const posture = operational ? "two-recipient" : "break-glass-only";
    console.log(`\n-- the automatic download burst (${posture}) leaves no signer private on this machine --`);
    const result: CeremonyResult = await runKeyCeremony({ operational });
    const cap = captureDownloads();
    const refused = downloadCeremonyFiles(result);
    await cap.settle();
    const names = cap.delivered.map((d) => d.name);
    ok(`${posture}: the burst was accepted in full (the capture saw every file)`, refused.length === 0 && names.length > 0);
    ok(`${posture}: no file named signer.key is delivered`, !names.includes("signer.key"));
    ok(`${posture}: no delivered file carries the signer-private label`, cap.delivered.every((d) => !d.content.includes(SIGNER_PRIVATE_LABEL)));
    ok(`${posture}: no delivered file carries the signer private itself`, cap.delivered.every((d) => !d.content.includes(result.signer.privateB64)));
    // Optional reads throughout the configuration sections: a ceremony without the keys must FAIL these
    // assertions by name, not crash the suite before it can say which property is missing.
    const cfgPriv = result.configRecipient?.identityB64;
    const wrap = result.configWrapKeyB64 as string | undefined;
    ok(`${posture}: the ceremony produced the configuration keys`, typeof cfgPriv === "string" && typeof wrap === "string");
    ok(`${posture}: no delivered file carries the configuration recovery private`, typeof cfgPriv === "string" && cap.delivered.every((d) => !d.content.includes(cfgPriv)));
    ok(`${posture}: no delivered file carries the configuration wrap key`, typeof wrap === "string" && cap.delivered.every((d) => !d.content.includes(wrap)));
    // Negative control: the recovery files the operator must keep still arrive.
    ok(`${posture}: CONTROL, identity.key is still delivered`, names.includes("identity.key"));
    ok(`${posture}: CONTROL, signer.pub is still delivered`, names.includes("signer.pub"));
    ok(`${posture}: CONTROL, the operational public arrives only in the two-recipient posture`, names.includes("operational.pub") === operational);
  }

  console.log("\n-- the setup surface's key files offer no signer.key row --");
  {
    const result = await runKeyCeremony({ operational: false });
    setCeremony(result);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const m = setupModel();
    m.update({ posture: "break-glass-only", postureAcknowledged: true, custody: "password-manager", keysGenerated: true, refusedFiles: [] });
    const host = document.createElement("div");
    for (const n of savedKeys(stubCtx("saved")).body) host.appendChild(n as HTMLElement);
    const rows = [...host.querySelectorAll(".fb-file__name")].map((n) => textOf(n as unknown as HTMLElement));
    ok("the Saved question rendered its file list", rows.length > 0);
    ok("no row is named signer.key", !rows.includes("signer.key"));
    ok("no Download-again control names signer.key", ![...host.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") ?? "").includes("signer.key")));
    ok("CONTROL: identity.key and signer.pub rows are still offered", rows.includes("identity.key") && rows.includes("signer.pub"));
    // Before the keys exist, the Custody question (which makes them) says what reaches the engine at Apply.
    setCeremony(null);
    m.update({ keysGenerated: false });
    const pre = document.createElement("div");
    for (const n of custody(stubCtx("custody")).body) pre.appendChild(n as HTMLElement);
    ok("the Custody question says what goes to the engine at Apply and that identity.key never leaves", /identity\.key never leaves this device\. At Apply, your engine gets the signing key, the configuration keys and the public keys\./.test(textOf(pre)));
    m.reset();
  }

  console.log("\n-- the Keys screen legend offers no signer.key download --");
  {
    const result = await runKeyCeremony({ operational: true });
    setCeremony(result);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ engineVersion: "test" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    const text = textOf(tab);
    ok("the ceremony result card rendered (the legend is on screen)", /Goes to your engine/.test(text));
    ok("the legend offers no signer.key", !text.includes("signer.key"));
    ok("the legend says SIGNER_PRIVATE installs straight to the engine", /SIGNER_PRIVATE, installs straight to your engine/.test(text));
    ok("CONTROL: the legend still offers identity.key and signer.pub", text.includes("identity.key") && text.includes("signer.pub"));
    tab.remove();
    globalThis.fetch = realFetch;
    setCeremony(null);
  }

  console.log("\n-- the ceremony makes the configuration keys in BOTH postures --");
  {
    const seen = new Set<string>();
    for (const operational of [false, true]) {
      const posture = operational ? "two-recipient" : "break-glass-only";
      const r = await runKeyCeremony({ operational });
      ok(`${posture}: runKeyCeremony returns a configuration recovery key and a wrap key`, r.configRecipient !== undefined && typeof r.configWrapKeyB64 === "string");
      if (r.configRecipient === undefined || typeof r.configWrapKeyB64 !== "string") continue;
      const id = b64urlDecode(r.configRecipient.identityB64);
      const pub = b64urlDecode(r.configRecipient.recipientPublicB64);
      ok(`${posture}: the configuration recovery private is a 96-byte identity`, id.length === 96);
      ok(`${posture}: the configuration recovery public is 1600 bytes`, pub.length === 1600);
      const derived = concat(x25519.getPublicKey(id.subarray(0, 32)), ml_kem1024.keygen(id.subarray(32, 96)).publicKey);
      ok(`${posture}: the public derives from the private (the pair the engine checks)`, b64urlEncode(derived) === r.configRecipient.recipientPublicB64);
      ok(`${posture}: the fingerprint is a dpr1 recipient fingerprint`, r.configRecipient.fingerprint.startsWith("dpr1:"));
      ok(`${posture}: the configuration wrap key is 32 bytes (AES-256)`, b64urlDecode(r.configWrapKeyB64).length === 32);
      ok(`${posture}: the configuration keys are distinct from the break-glass and operational keys`, r.configRecipient.recipientPublicB64 !== r.breakGlass.recipientPublicB64 && r.configRecipient.recipientPublicB64 !== r.operational?.recipientPublicB64);
      seen.add(r.configWrapKeyB64);
    }
    ok("two ceremonies make two different wrap keys", seen.size === 2 && !seen.has(undefined as unknown as string));
    const r = await runKeyCeremony({ operational: false });
    const { configRecipient: _dropped, ...withoutConfig } = r;
    ok("a stored ceremony without the configuration keys is rejected as misshapen", !isCeremonyResult(withoutConfig));
    ok("CONTROL: a whole ceremony is accepted", isCeremonyResult(r));
  }

  console.log("\n-- the recovery sheet carries no configuration private and says where the keys went --");
  {
    const r = await runKeyCeremony({ operational: true });
    const params = { downpipeAccount: "acct", createdAt: "2026-09-23", posture: "two-recipient" as const };
    for (const [kind, text] of [["text", recoverySheet(r, params)], ["printable", recoverySheetHTML(r, params)]] as const) {
      ok(`${kind} sheet: no configuration recovery private`, r.configRecipient !== undefined && !text.includes(r.configRecipient.identityB64));
      ok(`${kind} sheet: no configuration wrap key`, typeof r.configWrapKeyB64 === "string" && !text.includes(r.configWrapKeyB64));
      ok(`${kind} sheet: it states the wrap key installs straight to the engine`, /install straight to\s+your engine/.test(text) && text.includes("CONFIG_WRAP_KEY"));
      ok(`${kind} sheet: the retired "keep a copy" instruction is gone`, !/keep a copy of it too/i.test(text));
    }
  }

  console.log("\n-- the setup surface's Apply sends the configuration keys --");
  {
    const result = await runKeyCeremony({ operational: false });
    setCeremony(result);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const rec = setupFetch();
    connect("https://engine.example.com");
    const m = setupModel();
    m.update({ posture: "break-glass-only", postureAcknowledged: true, custody: "password-manager", keysGenerated: true, keysSaved: true });
    await m.refresh();
    const r = await applyWithDeployToken("cfat-one-shot-token");
    const install = rec.posted.find((p) => p.path === "/admin/keys/install");
    ok("Apply finished", r.ok);
    ok("Apply POSTed /admin/keys/install", install !== undefined);
    ok("it sent the configuration recovery public", typeof install?.body.configRecipientPublic === "string" && install.body.configRecipientPublic === result.configRecipient?.recipientPublicB64);
    ok("it sent the configuration recovery private", typeof install?.body.configRecipientPrivate === "string" && install.body.configRecipientPrivate === result.configRecipient?.identityB64);
    ok("it sent the configuration wrap key", typeof install?.body.configWrapKey === "string" && install.body.configWrapKey === result.configWrapKeyB64);
    ok("it never sent the break-glass private", install !== undefined && !JSON.stringify(install.body).includes(result.breakGlass.identityB64));
    ok("the tab dropped the key material once the engine had it", !isCeremonyResult(getCeremony()));
    rec.restore();
    m.reset();
  }

  console.log("\n-- the Keys screen install sends the configuration keys --");
  {
    const result = await runKeyCeremony({ operational: true });
    setCeremony(result);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const rec = recordingFetch({ ...KEYED_STATUS, configKeysConfigured: { recipient: true, wrapKey: true } });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    ok("the legend names CONFIG_WRAP_KEY and its real install condition", textOf(tab).includes("CONFIG_WRAP_KEY. It installs to your engine only if your engine does not hold one."));
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const install = rec.posted.find((p) => p.path === "/admin/keys/install");
    ok("the Keys install POSTed /admin/keys/install", install !== undefined);
    ok("it sent the configuration recovery pair and the wrap key", typeof install?.body.configWrapKey === "string" && install.body.configRecipientPublic === result.configRecipient?.recipientPublicB64 && install.body.configRecipientPrivate === result.configRecipient?.identityB64 && install.body.configWrapKey === result.configWrapKeyB64);
    tab.remove();
    rec.restore();
    setCeremony(null);
  }

  console.log("\n-- a keyed engine without its configuration keys is offered the targeted add --");
  for (const held of [{ recipient: false, wrapKey: false }, { recipient: true, wrapKey: false }, { recipient: false, wrapKey: true }]) {
    const label = `holds recovery=${held.recipient} wrap=${held.wrapKey}`;
    setCeremony(null);
    setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
    const rec = recordingFetch({ ...KEYED_STATUS, configKeysConfigured: held });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    ok(`${label}: the add card is offered`, /Add configuration keys/.test(textOf(tab)));
    (tab.querySelector('[data-dp="keys.button.generate-config-keys"]') as unknown as HTMLElement | null)?.click();
    await flushAsync();
    await flushAsync();
    await applyToken(tab, "keys.password.token", "keys.button.apply");
    const add = rec.posted.find((p) => p.path === "/admin/keys/add-config-recovery");
    ok(`${label}: it POSTed /admin/keys/add-config-recovery`, add !== undefined);
    ok(`${label}: it sends the recovery pair only when the engine lacks it`, (typeof add?.body.configRecipientPublic === "string" && typeof add?.body.configRecipientPrivate === "string") === !held.recipient);
    ok(`${label}: it sends the wrap key only when the engine lacks it`, (typeof add?.body.configWrapKey === "string") === !held.wrapKey);
    ok(`${label}: it never sends a signer, break-glass or operational value`, add !== undefined && !("signerPrivate" in add.body) && !("breakGlassPublic" in add.body) && !("operationalPrivate" in add.body));
    ok(`${label}: the full install route was not called`, !rec.posted.some((p) => p.path === "/admin/keys/install"));
    tab.remove();
    rec.restore();
  }
  {
    setCeremony(null);
    const rec = recordingFetch({ ...KEYED_STATUS, configKeysConfigured: { recipient: true, wrapKey: true } });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    ok("CONTROL: an engine that holds both configuration keys is offered no add card", !/Add configuration keys/.test(textOf(tab)) && /Add an operational key|Key ceremony/.test(textOf(tab)));
    tab.remove();
    rec.restore();
  }

  console.log("\n-- the Keys screen says what the engine did with credentials saved before the wrap key --");
  {
    const { rewrapSentence } = await import("../src/screens/keys/config-keys.ts");
    ok("an answer with no re-wrap report is not read as success", /did not report encrypting/.test(rewrapSentence(undefined)));
    ok("a clean report counts what was encrypted", rewrapSentence({ ok: true, wrapped: 3, alreadyWrapped: 0, leftPlaintext: 0, failedClasses: [] }) === "Your engine encrypted 3 saved credentials.");
    ok("a report that left one names its class and says to save it again", rewrapSentence({ ok: false, wrapped: 2, alreadyWrapped: 0, leftPlaintext: 1, failedClasses: ["destination"] }) === "1 saved credential is not encrypted (destination). Save it again.");
    ok("a pass that could not run says so", /could not encrypt/.test(rewrapSentence({ ok: false, wrapped: 0, alreadyWrapped: 0, leftPlaintext: 0, failedClasses: [], fault: "census-failed" })));
  }

  console.log("\n-- the self-deploy route does not call the signer the engine's only private value --");
  // The engine holds up to four private values: SIGNER_PRIVATE, OPERATIONAL_PRIVATE (operational posture),
  // CONFIG_RECIPIENT_PRIVATE and CONFIG_WRAP_KEY. The own-wrangler list's signer label once said "the one private
  // value the engine holds", which the same list then contradicted by listing the others. Checked in both
  // postures, because the configuration keys make it false even with no operational key. (Console main made the
  // same fix to the retired deck's wrangler fallback; this is its successor.)
  for (const operational of [true, false]) {
    setCeremony(await runKeyCeremony({ operational }));
    const plan = selfDeployPlan();
    const posture = operational ? "operational" : "offline-key";
    const text = plan.secrets.map((x) => `${x.command}\n${x.label}`).join("\n");
    ok(`${posture}: the secret labels were read`, plan.secrets.some((x) => x.label.includes("The signer private")));
    ok(`${posture}: no label calls one value the engine's only private value`, !/\b(one|only|single|sole) private value\b/i.test(text));
    ok(`${posture}: the list names every private value it installs`, ["SIGNER_PRIVATE", "CONFIG_RECIPIENT_PRIVATE", "CONFIG_WRAP_KEY", ...(operational ? ["OPERATIONAL_PRIVATE"] : [])].every((k) => text.includes(`npx wrangler secret put ${k}`)));
    ok(`${posture}: every command carries its value while the tab holds the keys`, plan.secrets.every((x) => typeof x.value === "string" && x.value.length > 0));
  }
  setCeremony(null);

  console.log("\n-- Q2: the posture choice sits outside the disclosure and starts at the estate's current posture --");
  {
    // A first install: no keys yet. The posture choice keeps today's default (ticked): the public docs
    // name strict custody as the default for a first install.
    setCeremony(null);
    const rec = recordingFetch({ engineVersion: "test", ready: false, signerConfigured: false, breakGlassConfigured: false, operationalConfigured: { public: false, private: false }, destConfigured: false, destKind: null, downpipeCount: 0 });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    const check = tab.querySelector("#ceremony-strict") as unknown as HTMLInputElement | null;
    ok("first install: the posture checkbox is rendered", check !== null);
    ok("first install: it is visible, not inside a closed disclosure", check !== null && check.closest("details") === null);
    ok("first install: it starts ticked (today's default)", check?.checked === true);
    tab.remove();
    rec.restore();
  }

  {
    // A two-recipient estate: an operational key is already present. Pressing "Generate keys" on a box
    // ticked by default, unseen inside a closed disclosure, would silently drop that key. The control must
    // be visible with no click, and it must start UNTICKED, so a re-key nobody touches the checkbox for
    // keeps the key the estate already has.
    setCeremony(null);
    const rec = recordingFetch({ engineVersion: "test", ready: true, signerConfigured: true, breakGlassConfigured: true, operationalConfigured: { public: true, private: true }, destConfigured: true, destKind: "r2", downpipeCount: 3 });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    const check = tab.querySelector("#ceremony-strict") as unknown as HTMLInputElement | null;
    ok("two-recipient: the posture checkbox is rendered", check !== null);
    ok("two-recipient: it is visible, not inside a closed disclosure", check !== null && check.closest("details") === null);
    ok("two-recipient: it starts UNTICKED (a re-key keeps the operational key by default)", check?.checked === false);
    tab.remove();
    rec.restore();
  }

  {
    // A strict estate that already has a signer but not the break-glass key (a half-keyed estate; the
    // dom shim cannot drive "Run the full re-key ceremony instead", which uses card.replaceWith, so this
    // exercises pickReturningOwnerCard's other route straight to the ceremony card). The posture choice
    // starts ticked, matching the estate's current (non-operational) posture.
    setCeremony(null);
    const rec = recordingFetch({ engineVersion: "test", ready: false, signerConfigured: true, breakGlassConfigured: false, operationalConfigured: { public: false, private: false }, destConfigured: true, destKind: "r2", downpipeCount: 1 });
    const engine = connect("https://engine.example.com") as EngineClient;
    const tab = renderPostureTab(engine);
    document.body.appendChild(tab);
    await flushAsync();
    const check = tab.querySelector("#ceremony-strict") as unknown as HTMLInputElement | null;
    ok("strict estate: the posture checkbox is rendered", check !== null);
    ok("strict estate: it is visible, not inside a closed disclosure", check !== null && check.closest("details") === null);
    ok("strict estate: it starts ticked (matches the current posture)", check?.checked === true);
    tab.remove();
    rec.restore();
  }

  verdictReached(failures);
  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nCEREMONY CUSTODY PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
