// Validate data-loss cases the support pack must be able to show evidence of: a browser capability
// that fails during a key or recovery ceremony, a key-ceremony intent marker taken at the attempt (so a
// failed ceremony is distinguishable from one that never ran), a destination fan-out read failing before a
// batch silently loses its copies, and a live restore apply whose ending is always recorded (half-applied,
// applied-nothing and answered-wrong are distinct outcomes).
//
// Every assertion below drives the real fault site and then asserts the row that lands in the
// console-diagnostics ring, which is what the support screen POSTs into the pack the customer generates
// (screens/settings/support.ts -> api.getSupportBundle(packPayload())).
//
// No-custody is structural: the payload assertions re-check that no sentinel value (a file name, an error
// message, a record name) can be found anywhere in the JSON the console would send.
//
// Run with `node test/validate-support-dataloss-gaps.ts`.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { reset as resetRing, setActiveScreen, snapshot, packPayload } from "../src/lib/client-diag/ring.ts";
import { noteWindowError } from "../src/lib/client-diag/window-faults.ts";
import { copyToClipboard, deliverFile } from "../src/lib/file-delivery.ts";
import { renderPostureTab } from "../src/screens/keys/posture.ts";
import { renderRotationSection } from "../src/screens/keys/rotation.ts";
import { downloadCeremonyFiles, downloadText } from "../src/screens/onboarding/shared.ts";
import { downloadText as passkeyDownloadText } from "../src/screens/passkey/ceremony.ts";
import { recoveryCodesPanel } from "../src/components/recovery-codes-panel.ts";
import { OB_CARDS_CONNECT_KEYS } from "../src/screens/onboarding/carousel-cards-connect-keys.ts";
import type { CarouselNav } from "../src/screens/onboarding/shared.ts";
import { noteApplyNotSent, noteApplyOutcome } from "../src/screens/restore-flow/shared.ts";
import { attachedTier } from "../src/screens/sources/tiers.ts";
import { connect, setCaller, setCeremony, getCeremony } from "../src/lib/store.ts";
import type { CeremonyResult } from "../src/keygen.ts";
import type { EngineClient, SourceDiscovery, RestoreResult, RestorePlan } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// wirePayload is the exact JSON the console would POST at pack generation. Every no-custody assertion is
// made against THIS string, not against the ring's internals, so it is the wire that is proven clean.
function wirePayload(): string {
  return JSON.stringify({ clientDiagnostics: packPayload() });
}

// The delivery capability the node host does not have: URL.createObjectURL exists only in a browser, so a
// download in this suite is REFUSED by default, which is exactly the fault G077 is about. grantDownloads
// installs a stub so the accepted path can be driven too.
function grantDownloads(): void {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => "blob:stub";
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
}
// A browser that DECLINES the delivery: createObjectURL throws. That is the refusal, and it is what the real
// fault looks like (every browser that can run this console HAS createObjectURL; what it withholds is the use
// of it).
function refuseDownloads(): void {
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => {
    throw new DOMException("blocked by policy", "NotAllowedError");
  };
}

// A browser capability failure in a key or recovery ceremony must be TOLD to the operator and land in the
// pack as a row a support engineer can act on: it must be separated from an unrelated console defect, must
// never inflate the generic defect counter, and the discriminators must survive coalescing all the way onto
// the wire.
console.log("\n-- a refused browser capability is a row support can act on, not an anonymous fault --");
{
  resetRing();
  setActiveScreen("/keys");
  refuseDownloads();

  const delivered = deliverFile("identity.key", "downpipe-identity-v1 SENTINEL-KEY-MATERIAL", "text/plain", "key-ceremony");
  eq(delivered, false, "a refused delivery reports FALSE to its caller (it never claims the file arrived)");

  const rows = snapshot().records;
  eq(rows.length, 1, "the refusal reaches the ring as exactly one closed-class record");
  const cap = rows[0];
  eq(cap?.kind, "capability-fault", "it is a CAPABILITY FAULT, not `unhandled`: a browser that declines a download is not a console defect");
  eq(cap?.capability, "blob-download", "WHAT the browser would not do");
  eq(cap?.surface, "key-ceremony", "WHICH ceremony asked, so support knows the customer has no identity.key at all");
  eq(cap?.capabilityOutcome, "refused", "and that the capability was present and DECLINED, not absent");
  eq(cap?.screen, "keys", "attributed to the screen the ceremony runs on");
  eq(snapshot().records.filter((r) => r.kind === "unhandled").length, 0, "NOISE DISCIPLINE: it does not inflate the counter that means 'a console defect nobody caught'");

  const wire = wirePayload();
  ok("NO-CUSTODY: the key material never reaches the wire", !wire.includes("SENTINEL-KEY-MATERIAL"));
  ok("NO-CUSTODY: the file name never reaches the wire", !wire.includes("identity.key"));
  ok("NO-CUSTODY: no error text reaches the wire", !wire.toLowerCase().includes("error") && !wire.toLowerCase().includes("exception"));
  ok("the discriminators are IN the wire payload the pack carries", wire.includes("capability-fault") && wire.includes("blob-download") && wire.includes("key-ceremony"));
}

// A refused identity.key download and an unrelated null dereference on the same screen must be two rows
// that no one could confuse, and the console bug must be the only thing in the defect bucket.
{
  resetRing();
  setActiveScreen("/keys");
  refuseDownloads();
  deliverFile("identity.key", "k", "text/plain", "key-ceremony");
  // The REAL window-fault seam, the one an uncaught console bug goes through. Not a re-implementation.
  noteWindowError(new TypeError("Cannot read properties of undefined (reading 'id')"));

  const rows = snapshot().records;
  eq(rows.length, 2, "a refused download and a console bug on the same screen are TWO rows, never one");
  const refusal = rows.find((r) => r.kind === "capability-fault");
  const defect = rows.find((r) => r.kind === "unhandled");
  ok("the refusal says a download was refused, and which ceremony", refusal?.capability === "blob-download" && refusal?.surface === "key-ceremony");
  ok("the console bug stays an unhandled defect and says nothing about a capability", defect?.faultClass === "other" && defect?.capability === undefined && defect?.surface === undefined);
  ok("the two rows are not confusable: only ONE of them is a console defect", rows.filter((r) => r.kind === "unhandled").length === 1);
}

// A field that discriminates two outcomes but is left out of the coalescing key discriminates nothing. On
// the access screen, a refused recovery-codes download, a dead clipboard and an unrelated console bug must not
// collapse into one row.
{
  resetRing();
  setActiveScreen("/access");
  refuseDownloads();
  const realNavigator = (globalThis as { navigator?: unknown }).navigator;
  (globalThis as { navigator?: unknown }).navigator = { clipboard: { writeText: async () => { throw new DOMException("NotAllowedError", "NotAllowedError"); } } };

  deliverFile("downpipes-recovery-codes.txt", "CODE-SENTINEL-AAAA", "text/plain", "recovery-codes");
  await copyToClipboard("CODE-SENTINEL-AAAA", "recovery-codes");
  noteWindowError(new TypeError("boom"));

  const rows = snapshot().records;
  eq(rows.length, 3, "three different outcomes on ONE screen are THREE rows: the discriminators are in the coalescing tuple");
  const caps = rows.filter((r) => r.kind === "capability-fault").map((r) => r.capability).sort();
  eq(caps.join(","), "blob-download,clipboard", "a refused download and a refused copy keep their own capability");
  eq(rows.filter((r) => r.kind === "unhandled").length, 1, "and the console bug is the only defect");
  (globalThis as { navigator?: unknown }).navigator = realNavigator;
}

// THE SURFACE IS THE ACTIONABLE FIELD, and no route id can stand in for it: the SAME capability refused on the
// SAME screen means different things in the first ceremony (there is no identity.key anywhere) and in a
// rotation (the old key still works). Two rows, or the pack cannot tell support what the customer has lost.
{
  resetRing();
  setActiveScreen("/keys");
  refuseDownloads();
  deliverFile("identity.key", "k", "text/plain", "key-ceremony");
  deliverFile("identity.key", "k", "text/plain", "break-glass-rotation");
  const surfaces = snapshot().records.map((r) => r.surface).sort();
  eq(surfaces.length, 2, "the same capability on the same screen, two ceremonies, is TWO rows");
  eq(surfaces.join(","), "break-glass-rotation,key-ceremony", "each keeps the ceremony that asked for it");
}

// THE CAPABILITY THAT IS SIMPLY NOT THERE. An absent navigator.clipboard is a plain-http self-host, which is a
// legitimate configuration and not a console defect. The previous build recorded it as `unhandled`, so every
// Copy press on such a host inflated the counter that is defined to mean "a defect that reached no catch site".
// It is now its own outcome, and it is nowhere near the defect bucket.
{
  const realNavigator = (globalThis as { navigator?: unknown }).navigator;
  resetRing();
  setActiveScreen("/integrations");
  (globalThis as { navigator?: unknown }).navigator = {};
  eq(await copyToClipboard("SENTINEL-ENDPOINT-VALUE", "integrations-copy"), false, "an ABSENT clipboard reports FALSE: the operator did not get their copy");
  const absent = snapshot().records[0];
  eq(absent?.kind, "capability-fault", "and it is recorded, because the operator still pressed a button that did nothing");
  eq(absent?.capabilityOutcome, "unavailable", "as UNAVAILABLE: the host cannot do it, which is a different remedy from a refusal");
  eq(snapshot().records.filter((r) => r.kind === "unhandled").length, 0, "NOISE DISCIPLINE: a legitimate configuration NEVER inflates the console-defect counter");

  // Present-and-refused is the other outcome, and the two must not coalesce: one is "fix your permissions
  // policy", the other is "serve the console over HTTPS".
  resetRing();
  (globalThis as { navigator?: unknown }).navigator = { clipboard: { writeText: async () => { throw new DOMException("NotAllowedError", "NotAllowedError"); } } };
  eq(await copyToClipboard("SENTINEL-ENDPOINT-VALUE", "integrations-copy"), false, "a REFUSED clipboard write reports FALSE, never a silent no-op");
  eq(snapshot().records[0]?.capabilityOutcome, "refused", "and it is a REFUSAL, not an absence");
  eq(snapshot().records[0]?.surface, "integrations-copy", "on the integrations surface, so it never coalesces with a dead clipboard on the recovery codes");
  ok("NO-CUSTODY: the copied value never reaches the wire", !wirePayload().includes("SENTINEL-ENDPOINT-VALUE"));

  // The accepted path, so the reporter is proven not to cry wolf on a clipboard that works.
  resetRing();
  const copied: string[] = [];
  (globalThis as { navigator?: unknown }).navigator = { clipboard: { writeText: async (t: string) => { copied.push(t); } } };
  eq(await copyToClipboard("SENTINEL-ENDPOINT-VALUE", "integrations-copy"), true, "an accepted copy reports TRUE");
  eq(copied[0], "SENTINEL-ENDPOINT-VALUE", "and the text is handed to the platform untouched (never read, classified or held)");
  eq(snapshot().records.length, 0, "NOISE DISCIPLINE: an accepted copy records NOTHING");
  (globalThis as { navigator?: unknown }).navigator = realNavigator;
}

// A key ceremony that produces no keys is the single most consequential thing that can go wrong in the
// console. A locked-down browser that cannot generate a key pair must not produce zero pack evidence of it.
{
  resetRing();
  setActiveScreen("/keys");
  grantDownloads();
  setCeremony(null);
  // isOnlyOwner false: these cases do not model an owner COUNT and assert nothing about the
  // only-owner path, so the ordinary case (other owners exist) keeps that warning out of the way.
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ engineVersion: "test" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const engine = connect("https://engine.example.com") as EngineClient;
  // globalThis.crypto is a getter-only accessor in node, so the host's WebCrypto is swapped by redefining the
  // property rather than assigning it.
  const realCrypto = globalThis.crypto;
  const setCrypto = (value: unknown): void => {
    Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  };

  // A host with NO WebCrypto at all: the console served over plain http. The ceremony cannot run, and the
  // outcome is `unavailable`, because the operator's remedy is to serve the console over HTTPS.
  setCrypto(undefined);
  const tab = renderPostureTab(engine);
  document.body.appendChild(tab);
  await flushAsync();
  const gen = [...tab.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement) === "Generate keys");
  ok("the keys screen offers the ceremony button", gen !== undefined);
  (gen as unknown as HTMLElement | undefined)?.click();
  await flushAsync();

  eq(getCeremony(), null, "the ceremony produced NO KEYS: there is nothing to save and nothing could ever be recovered");
  ok("the operator is told, on screen", textOf(tab).includes("Key generation failed"));

  // The posture copy is read at the moment the customer DECIDES whether to remove the operational key, so
  // what it claims the strict posture costs is load-bearing rather than decorative. It used to say "every
  // proof is offline", which stopped being true when verify-at-seal and the canary moved onto the run's
  // own per-run key: a break-glass-only engine reaches the same keyed tier and runs the canary with no
  // skipped checks, both in-account. Overstating the cost pushes a customer away from the stricter posture
  // for a reason that no longer holds, which is the opposite of what this workstream set out to do.
  //
  // These assert the CLAIMS, not the exact sentences, so the copy can be improved without breaking them,
  // while a regression to the old overstatement fails.

  // The posture copy is read at the moment the customer DECIDES whether to remove the operational key, so
  // what it claims the strict posture costs is load-bearing rather than decorative. It used to say "every
  // proof is offline", which stopped being true when verify-at-seal and the canary moved onto the run's
  // own per-run key: a break-glass-only engine reaches the same keyed tier and runs the canary with no
  // skipped checks, both in-account. Overstating the cost pushes a customer away from the stricter posture
  // for a reason that no longer holds, which is the opposite of what this workstream set out to do.
  //
  // The meanings block only renders on a SUCCESSFUL status read, which is why this needs its own fixture
  // rather than riding the WebCrypto-absent one above: that one renders the engine-unreachable state and
  // the copy under test is never in the DOM, so the assertions would pass or fail for the wrong reason.
  {
    const status = {
      engineVersion: "test",
      ready: true,
      signerConfigured: true,
      breakGlassConfigured: true,
      operationalConfigured: { public: true, private: true },
      destConfigured: true,
      destKind: "r2",
      downpipeCount: 0,
      downpipes: [],
      ts: new Date(0).toISOString(),
    };
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const engine2 = connect("https://engine.example.com") as EngineClient;
    const tab2 = renderPostureTab(engine2);
    document.body.appendChild(tab2);
    await flushAsync();
    const postureText = textOf(tab2);
    ok("posture copy: the meanings block rendered (the fixture reached a successful status read)", postureText.includes("Operational key (private)"));
    ok("posture copy: the operational key is described as buying the UNATTENDED work", /unattended/i.test(postureText));
    ok("posture copy: it names scheduled restore tests as what moves", /scheduled restore test/i.test(postureText));
    ok("posture copy: it names retention pruning as what moves", /retention pruning/i.test(postureText));
    // The two claims that were wrong, asserted positively so the fix cannot silently revert.
    ok("posture copy: verify-at-seal and the canary are stated to still run without the key", /verify-at-seal and the canary still run/i.test(postureText));
    ok("posture copy: an in-console restore still works in the strict posture", /in-console restore still works/i.test(postureText));
    ok("posture copy: the retired 'every proof is offline' claim is gone", !/every proof is offline/i.test(postureText));
    tab2.remove();
    globalThis.fetch = priorFetch;
  }

  const keygen = snapshot().records.find((r) => r.kind === "capability-fault");
  eq(keygen?.capability, "webcrypto-keygen", "and the PACK now carries it: the capability the browser could not give");
  eq(keygen?.surface, "key-ceremony", "on the first key ceremony, which is what makes it the worst case there is");
  eq(keygen?.capabilityOutcome, "unavailable", "with the outcome read from the PLATFORM (no WebCrypto here), never from the error");
  // The keygen throw carries a real message ("Cannot read properties of undefined ...", "subtle is not
  // defined", whatever the host says). None of it may reach the wire: the reporter takes no error argument, so
  // there is structurally nothing of it to leak. `webcrypto-keygen` is a frozen product constant, not text.
  const keygenWire = wirePayload().toLowerCase();
  ok("NO-CUSTODY: no error text from the failed keygen reaches the wire", !keygenWire.includes("subtle") && !keygenWire.includes("undefined") && !keygenWire.includes("cannot"));

  // A ROTATION that cannot generate: the same capability, a different surface, and a different ticket (the old
  // break-glass key still works). It must not coalesce with the ceremony row above.
  resetRing();
  const rot = renderRotationSection(engine);
  document.body.appendChild(rot);
  await flushAsync();
  const rotBtn = [...rot.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).includes("Generate new break-glass key pair"));
  (rotBtn as unknown as HTMLElement | undefined)?.click();
  await flushAsync();
  const rotRow = snapshot().records.find((r) => r.kind === "capability-fault");
  eq(rotRow?.capability, "webcrypto-keygen", "a rotation that cannot keygen is recorded too");
  eq(rotRow?.surface, "break-glass-rotation", "on its OWN surface, because the old key still works and that is a different ticket");

  setCrypto(realCrypto);
  globalThis.fetch = realFetch;
}

// The six-file ceremony burst: a refusal must not abandon the files after it, it must NAME the files that did
// not arrive (on screen, never in the pack), and the sheet must not be counted as lost key material.
{
  resetRing();
  setActiveScreen("/keys");
  refuseDownloads();
  const result: CeremonyResult = {
    breakGlass: { identityB64: "bg-secret", recipientPublicB64: "bg-pub", fingerprint: "fp-bg" },
    operational: { identityB64: "op-secret", recipientPublicB64: "op-pub", fingerprint: "fp-op" },
    signer: { publicB64: "s-pub", privateB64: "s-secret", fingerprint: "fp-s" } as CeremonyResult["signer"],
  };
  const refused = downloadCeremonyFiles(result);
  eq(refused.length, 6, "every file of the burst is attempted: a refusal does not abandon the ones after it");
  ok("the refused files are named for the OPERATOR", refused.includes("identity.key") && refused.includes("recovery-sheet.txt"));

  const rows = snapshot().records;
  eq(rows.length, 2, "the burst coalesces by SURFACE: the five key files are one row, the public sheet another");
  const keyRow = rows.find((r) => r.surface === "key-ceremony");
  const sheetRow = rows.find((r) => r.surface === "recovery-sheet");
  eq(keyRow?.count, 5, "five key-ceremony files did not arrive: the magnitude survives, the names do not");
  eq(sheetRow?.count, 1, "and the recovery sheet, which holds no secret, is not counted as lost key material");
  ok("NO-CUSTODY: no key material from the burst reaches the wire", !wirePayload().includes("secret"));

  grantDownloads();
  resetRing();
  eq(downloadCeremonyFiles(result).length, 0, "an accepted burst refuses nothing");
  eq(snapshot().records.length, 0, "NOISE DISCIPLINE: an accepted delivery records NOTHING");
  eq(downloadText("recovery-sheet.txt", "text", "recovery-sheet"), true, "a single accepted download reports TRUE");
}

// THE RECOVERY CODES, the site the gap is named after. The engine shows them ONCE, and on the regenerate path
// it has ALREADY invalidated the previous set. A browser that refuses the download used to take a silent early
// return or throw uncaught out of the click handler: the operator pressed the button, nothing arrived, the
// panel said nothing, and a later lost passkey locked them out permanently.
{
  resetRing();
  setActiveScreen("/passkey");
  refuseDownloads();
  eq(passkeyDownloadText("downpipes-recovery-codes.txt", "CODE-SENTINEL-AAAA"), false, "a refused recovery-codes download reports FALSE: it never claims the file arrived");
  const row = snapshot().records[0];
  eq(row?.kind, "capability-fault", "the refusal is a capability fault, not an anonymous unhandled row");
  eq(row?.surface, "recovery-codes", "and it names the artefact that is shown ONCE and never again");
  ok("NO-CUSTODY: the recovery codes themselves never reach the wire", !wirePayload().includes("CODE-SENTINEL-AAAA"));

  grantDownloads();
  resetRing();
  eq(passkeyDownloadText("downpipes-recovery-codes.txt", "CODE-SENTINEL-AAAA"), true, "an accepted download reports TRUE");
  eq(snapshot().records.length, 0, "NOISE DISCIPLINE: an accepted download records NOTHING");
}

// The panel the codes are shown in: the operator must be TOLD, not just have it recorded. A refusal that only
// reaches support is still a customer who walks away believing they have their codes.
{
  resetRing();
  refuseDownloads();
  const panel = recoveryCodesPanel({
    codes: ["CODE-SENTINEL-AAAA", "CODE-SENTINEL-BBBB"],
    context: "enrol",
    downloadText: passkeyDownloadText,
    onConfirm: () => undefined,
  });
  document.body.appendChild(panel);
  const dl = [...panel.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).includes("Download"));
  (dl as unknown as HTMLElement | undefined)?.click();
  await flushAsync();
  const shown = textOf(panel);
  ok("the panel SAYS the browser refused the download", shown.includes("refused the download"));
  ok("and names the way out that still works: the codes are on screen", shown.includes("Copy them by hand"));
  ok("the refusal is in the pack, as a recovery-codes capability fault", snapshot().records.some((r) => r.kind === "capability-fault" && r.surface === "recovery-codes"));
  grantDownloads();
}

// The ceremony intent marker is taken at the attempt, not on success.
console.log("\n-- a failed key ceremony is distinguishable from one that never ran --");
{
  resetRing();
  grantDownloads();
  setCeremony(null);
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });

  const posted: Array<{ url: string; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    posted.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const payload = url.includes("/status") ? { engineVersion: "test", breakGlassConfigured: false } : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  connect("https://engine.example.com");

  let advanced = 0;
  let passed = 0;
  const nav = { advance: () => { advanced++; }, back: () => undefined, markPassed: () => { passed++; } } as unknown as CarouselNav;
  const card = OB_CARDS_CONNECT_KEYS.find((c) => c.id === "generate");
  const host = document.createElement("div");
  if (card) card.mount(host, nav);

  const generate = [...host.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).includes("Generate my keys"));
  ok("the generate card offers the ceremony button", generate !== undefined);
  (generate as unknown as HTMLElement | undefined)?.click();
  await Promise.resolve();

  const intent = posted.find((p) => p.url.includes("/audit/intent"));
  ok("the intent marker is POSTed at the ATTEMPT", intent !== undefined);
  ok("it is the key-ceremony intent action the pack's audit section carries", intent?.body.includes("key-ceremony-intent") === true);
  eq(getCeremony(), null, "and it is taken BEFORE the ceremony has produced a result: a ceremony that fails still leaves the marker");

  await flushAsync();
  ok("the ceremony itself still completes and is stored", getCeremony() !== null);
  ok("the happy path advances", advanced > 0 && passed > 0);
  globalThis.fetch = realFetch;
}

// The same card with the browser REFUSING the downloads: the keys exist, so this must not be reported as a
// failed ceremony (it used to throw into the ceremony's catch and say the keys could not be generated).
{
  resetRing();
  refuseDownloads();
  setCeremony(null);
  setCaller({ method: "passkey", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  connect("https://engine.example.com");

  let advanced = 0;
  const nav = { advance: () => { advanced++; }, back: () => undefined, markPassed: () => undefined } as unknown as CarouselNav;
  const card = OB_CARDS_CONNECT_KEYS.find((c) => c.id === "generate");
  const host = document.createElement("div");
  if (card) card.mount(host, nav);
  const generate = [...host.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).includes("Generate my keys"));
  (generate as unknown as HTMLElement | undefined)?.click();
  await flushAsync();

  const shown = textOf(host as unknown as HTMLElement);
  ok("the keys exist in this tab", getCeremony() !== null);
  ok("the refusal is NOT reported as a failed ceremony", !shown.includes("Could not generate keys"));
  ok("it names the files the browser did not save", shown.includes("identity.key") && shown.includes("did not save"));
  eq(advanced, 0, "the operator is held on the card rather than advanced past files that never arrived");
  ok("a continue to the per-file re-download controls is offered", shown.includes("Continue to your files"));
  ok("the refusals are in the pack, as key-ceremony capability faults", snapshot().records.some((r) => r.kind === "capability-fault" && r.capability === "blob-download" && r.surface === "key-ceremony"));
  globalThis.fetch = realFetch;
  grantDownloads();
}

// An unreadable destination list must never silently cost the operator their copies.
console.log("\n-- a failed destination read cannot silently degrade a batch to one copy --");
{
  resetRing();
  setActiveScreen("/sources");
  // The REAL EngineClient over a stubbed fetch, not a hand-rolled stub: the point of the assertion below is
  // that the failed read reaches the ring THROUGH THE ONE ENGINE SEAM, which a stub that resolves its own
  // promise would bypass (the dead-evidence trap, in reverse).
  let bulkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/destinations")) return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    if (url.includes("/downpipes/bulk")) {
      bulkCalls++;
      return new Response(JSON.stringify({ results: [{ status: "applied" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const engine = connect("https://engine.example.com") as EngineClient;

  const el = attachedTier(
    engine,
    [{ name: "KV_ONE", type: "kv" }],
    { tokenPresent: true, bindings: [], accounts: [] } as unknown as SourceDiscovery,
    { refresh: () => undefined, opGate: true, ownerGate: true },
  );
  document.body.appendChild(el);
  await flushAsync();
  ok("the failed read is SAID, next to the control it degrades", textOf(el).includes("could not be read"));
  ok("and it states exactly what a create would cost: no extra copies", textOf(el).includes("no extra copies"));

  const box = [...el.querySelectorAll("input")][0] as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void } | undefined;
  if (box) {
    box.checked = true;
    box.dispatchEvent({
      type: "change",
      target: null,
      currentTarget: null,
      defaultPrevented: false,
      preventDefault() { /* the shim's minimal event surface */ },
      stopPropagation() { /* the shim's minimal event surface */ },
    });
  }
  const protect = [...el.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).startsWith("Protect"));
  (protect as unknown as HTMLElement | undefined)?.click();
  await flushAsync();
  eq(bulkCalls, 0, "the first press does NOT create: a batch is never built against destinations we could not read");
  ok("the operator is told what a second press will do", textOf(el).includes("Press Protect again"));

  (protect as unknown as HTMLElement | undefined)?.click();
  await flushAsync();
  ok("a second, informed press proceeds (a single-destination estate is never blocked)", bulkCalls > 0);
  ok("the failed read itself is in the pack, on the sources screen", snapshot().records.some((r) => r.kind === "engine-call" && r.screen === "sources"));
  ok("NO-CUSTODY: the binding name never reaches the wire", !wirePayload().includes("KV_ONE"));

  // The generic engine-call row alone does not answer the question: it says a read on the sources screen
  // failed, which is also what a discovery blip says, and it cannot say whether the operator then went ahead
  // and created the batch anyway.
  const degraded = snapshot().records.filter((r) => r.kind === "fanout-degraded");
  eq(degraded.length, 1, "the silently-skipped fan-out is its OWN row: destListReadFailed AND fellBackToDefault");
  eq(degraded[0]?.screen, "sources", "attributed to the sources screen");
  eq(degraded[0]?.count, 1, "the count is how many downpipes landed WITHOUT their replicas: the size of the redundancy lost");
  ok("the fan-out row is in the wire payload the pack carries", wirePayload().includes("fanout-degraded"));

  // TUPLE COLLISION, the second half of the refutation: a 500 from discoverSources on the SAME screen must not
  // coalesce into the same row as a lost fan-out. Different kinds, so different tuples, so two rows.
  const sourcesRows = snapshot().records.filter((r) => r.screen === "sources");
  ok("a discovery fault and a lost fan-out are different rows, never one coalesced row", sourcesRows.some((r) => r.kind === "engine-call") && sourcesRows.some((r) => r.kind === "fanout-degraded"));
  globalThis.fetch = realFetch;
}

// The negative case, which is what makes the row above MEAN anything: an operator who READS their
// destinations and simply leaves the default selected has NOT lost redundancy, and must produce NO row. If
// both states recorded the same evidence the discriminator would be worthless, which is precisely what the
// reviewer found the first time.
{
  resetRing();
  setActiveScreen("/sources");
  let bulkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/destinations")) {
      return new Response(JSON.stringify({ destinations: [{ id: "d1", name: "one" }, { id: "d2", name: "two" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/downpipes/bulk")) {
      bulkCalls++;
      return new Response(JSON.stringify({ results: [{ status: "applied" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const engine = connect("https://engine.example.com") as EngineClient;

  const el = attachedTier(
    engine,
    [{ name: "KV_TWO", type: "kv" }],
    { tokenPresent: true, bindings: [], accounts: [] } as unknown as SourceDiscovery,
    { refresh: () => undefined, opGate: true, ownerGate: true },
  );
  document.body.appendChild(el);
  await flushAsync();
  ok("a destination list that READS shows no degrade warning", !textOf(el).includes("could not be read"));

  const box = [...el.querySelectorAll("input")][0] as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void } | undefined;
  if (box) {
    box.checked = true;
    box.dispatchEvent({
      type: "change",
      target: null,
      currentTarget: null,
      defaultPrevented: false,
      preventDefault() { /* the shim's minimal event surface */ },
      stopPropagation() { /* the shim's minimal event surface */ },
    });
  }
  const protect = [...el.querySelectorAll("button")].find((b) => textOf(b as unknown as HTMLElement).startsWith("Protect"));
  (protect as unknown as HTMLElement | undefined)?.click();
  await flushAsync();
  ok("the batch is created on the FIRST press (nothing was lost, so nothing is refused)", bulkCalls > 0);
  eq(snapshot().records.filter((r) => r.kind === "fanout-degraded").length, 0, "an operator who CHOSE the default records NO degrade row: the two states are no longer identical in the pack");
  globalThis.fetch = realFetch;
}

// A live apply must be correlatable with what the engine actually did.
console.log("\n-- every apply ending is recorded, and silence does not mean clean --");
{
  resetRing();
  setActiveScreen("/restore");
  const applied = (recordsRestored: number, failed: number): RestoreResult => ({
    ok: failed === 0,
    runId: "run-SENTINEL",
    mode: "applied",
    recordsVerified: recordsRestored + failed,
    recordsRestored,
    bytesRestored: 1,
    isLatest: true,
    failures: Array.from({ length: failed }, (_, i) => ({ name: `CUSTOMER-RECORD-${i}`, reason: "destination refused the write" })),
  });
  const applyClassOf = (): string | undefined => snapshot().records.find((r) => r.kind === "apply-outcome")?.applyClass;

  // THE FOURTH ENDING. This is the refutation the first build earned: an apply with no failures recorded
  // NOTHING, and nothing was also what a restore that never ran left behind. The pack could not tell a
  // restore that worked from a restore that reported success and moved no data.
  noteApplyOutcome(applied(9, 0));
  eq(applyClassOf(), "wrote-all", "a CLEAN apply is recorded EXPLICITLY: an apply ran, and it wrote records");

  resetRing();
  noteApplyOutcome(applied(0, 0));
  eq(applyClassOf(), "wrote-none", "SUCCESS REPORTED, NOTHING WRITTEN is its own row: the ticket the gap names");
  eq(snapshot().records.filter((r) => r.kind === "bulk-outcome").length, 0, "and it is NOT a bulk failure: the engine reported no failure at all");

  resetRing();
  noteApplyOutcome(applied(7, 3));
  eq(applyClassOf(), "wrote-some", "an apply that wrote some and lost some is HALF-APPLIED: a retry must be scoped");
  const half = snapshot().records.find((r) => r.kind === "bulk-outcome");
  eq(half?.reasonClass, "partial", "the magnitude row survives alongside the class");
  eq(half?.count, 3, "the count is how many records did not come back");
  eq(half?.screen, "restore", "attributed to the restore screen");

  resetRing();
  noteApplyOutcome(applied(0, 5));
  eq(applyClassOf(), "wrote-none-all-failed", "wrote nothing because EVERYTHING FAILED is a different ticket from wrote nothing quietly");

  resetRing();
  noteApplyOutcome({ mode: "dry-run", ok: true, runId: "r", recordsVerified: 1, isLatest: true, plannedWrites: 1, bytes: 1, sample: [], skipped: [] } as unknown as RestorePlan);
  eq(applyClassOf(), "unknown-shape", "a 2xx that is not an apply result: the console does not guess what was written");
  eq(snapshot().records.find((r) => r.kind === "contract-drift")?.driftClass, "unknown-enum", "and it is still contract drift, not a restore failure");

  resetRing();
  noteApplyNotSent();
  eq(applyClassOf(), "not-sent", "an apply POST that never came back is its own class, not the generic engine-call row");

  // THE TUPLE MUST DISCRIMINATE. A field that separates two outcomes but is left out of the coalescing key
  // separates nothing: the rows merge and the first class written wins, which is a row that LOOKS specific
  // and lies. Two different endings in one session must be two rows.
  resetRing();
  noteApplyOutcome(applied(4, 0));
  noteApplyOutcome(applied(0, 0));
  const classes = snapshot().records.filter((r) => r.kind === "apply-outcome").map((r) => r.applyClass).sort();
  eq(classes.length, 2, "two different endings are TWO rows: applyClass is in the coalescing tuple");
  eq(classes.join(","), "wrote-all,wrote-none", "and each keeps its own class");

  // The retry count: the operator who pressed Apply three times against the same silent ending.
  resetRing();
  noteApplyOutcome(applied(0, 0));
  noteApplyOutcome(applied(0, 0));
  noteApplyOutcome(applied(0, 0));
  const repeats = snapshot().records.filter((r) => r.kind === "apply-outcome");
  eq(repeats.length, 1, "the same ending three times coalesces to one row");
  eq(repeats[0]?.count, 3, "with a count of 3: how many applies ended that way, to line up against the engine's audit events");

  resetRing();
  noteApplyOutcome(applied(7, 3));
  const wire = wirePayload();
  ok("the apply class is IN the wire payload the pack carries", wire.includes("apply-outcome") && wire.includes("wrote-some"));
  ok("NO-CUSTODY: no record name reaches the wire", !wire.includes("CUSTOMER-RECORD-0"));
  ok("NO-CUSTODY: no engine reason reaches the wire", !wire.includes("destination refused"));
  ok("NO-CUSTODY: no run id reaches the wire", !wire.includes("run-SENTINEL"));
}

console.log(failures === 0 ? "\nsupport data-loss gaps: all checks passed" : `\nsupport data-loss gaps: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
