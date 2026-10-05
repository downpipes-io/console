// THE CREATE WIZARD AND THE EDITOR STATE A CREATE, AND THE WIZARD'S SECRETS BUNDLE CARRIES THE STORE'S OWN NAMES.
//
// Two fixes live in the wizard, and before this file only their other halves were pinned (the import loop,
// the Sources bulk protect and the client wire). Reverting either wizard half left every test green.
//   1. EVERY CREATE STATES `null`. addDownpipe(dp, null) is the claim that no downpipe with this id exists, so
//      an id already in use is refused with `already-exists` rather than overwritten. The wizard has two single
//      create calls (the radio path and the one-result checkbox path) and one bulk path. This drives the real
//      wizard through a single KV create and reads the base the engine client was handed.
//   2. THE SECRETS BUNDLE CARRIES THE DISCOVERED NAME AND STORE ID. The wizard must pass the discovery read's
//      secret refs to assembleBulkDownpipes, or each row falls back to a name derived from the binding and no
//      store id. This ticks two bound secrets whose names hold a hyphen (so the fallback would differ) and
//      reads each row the engine client was handed.
//   3. THE ADVANCED EDITOR'S CREATE STATES `null` TOO. Its id is the name's slug plus 8 random hex characters,
//      drawn again on each submit, so two creates with the same name never share an id and `null` refuses only
//      a real collision. An edit through the same editor states the revision it read, as the control.
// Each case also checks that the create call happened, so a wizard that never submits cannot pass.
//
// Run: node test/validate-wizard-create-precondition.ts

import { flushAsync, installDomShim, textOf } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { EngineClient } = await import("../src/api.ts");
const { openCreateWizard } = await import("../src/screens/sources-downpipes/editor-wizard.ts");
const { openEditor } = await import("../src/screens/sources-downpipes/editor-upsert.ts");
type Downpipe = import("../src/api.ts").Downpipe;

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

type El = { getAttribute: (n: string) => string | null; click?: () => void; textContent: string; value?: string };
const all = (sel: string): El[] => (document.body as unknown as { querySelectorAll: (s: string) => El[] }).querySelectorAll(sel);
const buttonNamed = (re: RegExp): El | undefined => all("button").find((b) => re.test(textOf(b as never)));

interface Captured {
  single: Array<{ dp: Downpipe; base: unknown; baseGiven: boolean }>;
  bulk: Downpipe[][];
}

// openWith opens the real wizard over an engine whose reads are stubbed and whose two create calls record what
// they were handed. The base argument is recorded with whether it was passed at all, because `undefined` (states
// nothing) and `null` (states a create) are two different claims on the wire.
async function openWith(discovery: unknown): Promise<Captured> {
  (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
  const captured: Captured = { single: [], bulk: [] };
  const engine = new EngineClient("https://engine.test");
  const stub = engine as unknown as Record<string, unknown>;
  stub.discoverSources = async () => discovery;
  stub.listDestinations = async () => ({ destinations: [{ id: "d1", label: "Primary" }], defaultId: "d1" });
  stub.getDestination = async () => ({ configured: true, kind: "r2" });
  stub.listDownpipes = async () => [];
  stub.addDownpipe = async (...args: unknown[]) => {
    captured.single.push({ dp: args[0] as Downpipe, base: args[1], baseGiven: args.length >= 2 });
    return { status: "applied", value: {} };
  };
  stub.bulkAddDownpipes = async (dps: Downpipe[]) => {
    captured.bulk.push(dps);
    return { results: dps.map(() => ({ status: "applied" })) };
  };
  openCreateWizard(engine, null, new Set<string>(), () => {}, () => {});
  await flushAsync(20);
  return captured;
}

// tickAndCreate ticks every checkbox whose row names one of the wanted bindings, then walks the steps to Create.
async function tickAndCreate(bindings: string[]): Promise<void> {
  for (const box of all("input")) {
    if (box.getAttribute("type") !== "checkbox" || !box.click) continue;
    const row = (box as unknown as { parentNode?: unknown; closest?: (s: string) => unknown }).closest?.("label, li, tr, div") ?? (box as unknown as { parentNode?: unknown }).parentNode;
    const rowText = row ? textOf(row as never) : "";
    if (!bindings.some((b) => rowText.includes(b)) && !bindings.includes(box.getAttribute("value") ?? "")) continue;
    // The shim's click() dispatches only a click, and the source rows listen for change, as a browser fires it.
    const input = box as unknown as { checked: boolean; dispatchEvent: (e: unknown) => boolean };
    input.checked = true;
    input.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
  }
  await flushAsync(10);
  for (let i = 0; i < 4; i++) {
    const create = buttonNamed(/^Create/);
    if (create?.click) {
      create.click();
      await flushAsync(20);
      return;
    }
    buttonNamed(/^Continue/)?.click?.();
    await flushAsync(20);
  }
}

async function main(): Promise<void> {
  console.log("\n-- 1. a single create from the wizard states null --");
  {
    const cap = await openWith({ bound: { kv: ["KV_uploads"], r2: [], d1: [], secrets: [] }, tokenPresent: false });
    await tickAndCreate(["KV_uploads"]);
    ok("the wizard reached its create call", cap.single.length + cap.bulk.length === 1);
    const call = cap.single[0];
    ok("the single create passed a base argument", call?.baseGiven === true);
    ok("and that base is null, the create precondition", call?.base === null);
    ok("the created downpipe is the ticked KV binding", (call?.dp.source as { binding?: string } | undefined)?.binding === "KV_uploads");
  }

  console.log("\n-- 2. a secrets bundle from the wizard carries the discovered name and store id --");
  {
    const cap = await openWith({
      bound: { kv: [], r2: [], d1: [], secrets: ["SRC_SEC_api_key", "SRC_SEC_webhook_token"] },
      tokenPresent: true,
      engineAccountId: "acct-1",
      accounts: [
        { accountId: "acct-1", accountName: "A", kv: [], r2: [], d1: [], zones: [], errors: [], secrets: [{ storeId: "store-1", name: "api-key" }, { storeId: "store-1", name: "webhook_token" }] },
      ],
    });
    await tickAndCreate(["SRC_SEC_api_key", "SRC_SEC_webhook_token"]);
    const sent = cap.single[0]?.dp ?? cap.bulk[0]?.[0];
    ok("the wizard reached its create call", sent !== undefined);
    ok("the bundle's create (one result, so the single-create path) states null", cap.single[0]?.base === null);
    const rows = ((sent?.source as { secrets?: Array<{ name: string; binding: string; storeId?: string }> } | undefined)?.secrets) ?? [];
    ok("both ticked secrets are in the one bundle", rows.length === 2);
    const api = rows.find((r) => r.binding === "SRC_SEC_api_key");
    const hook = rows.find((r) => r.binding === "SRC_SEC_webhook_token");
    ok("the hyphenated secret carries its discovered name, not the binding-derived api_key", api?.name === "api-key");
    ok("each row carries the discovered store id", api?.storeId === "store-1" && hook?.storeId === "store-1");
  }

  console.log("\n-- 3. the advanced editor's create states null, and its edit states the revision --");
  {
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    const engine = new EngineClient("https://engine.test");
    const stub = engine as unknown as Record<string, unknown>;
    stub.discoverSources = async () => ({ bound: { kv: ["KV_uploads"], r2: [], d1: [], secrets: [] }, tokenPresent: false });
    stub.listDestinations = async () => ({ destinations: [{ id: "d1", label: "Primary" }], defaultId: "d1" });
    stub.getDestination = async () => ({ configured: true, kind: "r2" });
    const calls: Array<{ dp: Downpipe; base: unknown; baseGiven: boolean }> = [];
    stub.addDownpipe = async (...args: unknown[]) => {
      calls.push({ dp: args[0] as Downpipe, base: args[1], baseGiven: args.length >= 2 });
      return { status: "applied", value: {} };
    };
    const saveEditor = async (name: string): Promise<void> => {
      const nameInput = all("input").find((i) => i.getAttribute("id") === "dp-name");
      if (nameInput) (nameInput as unknown as { value: string }).value = name;
      buttonNamed(/^(Create downpipe|Save changes)$/)?.click?.();
      await flushAsync(20);
    };
    openEditor(engine, null, null, () => {}, () => {}, { type: "kv", binding: "KV_uploads" });
    await flushAsync(20);
    await saveEditor("Editor create");
    ok("the editor reached its create call", calls.length === 1);
    ok("the editor's create passed a base argument", calls[0]?.baseGiven === true);
    ok("and that base is null, the create precondition", calls[0]?.base === null);
    ok("the created id is the name's slug with a random suffix", /^editor-create-[0-9a-f]{8}$/.test(calls[0]?.dp.id ?? ""));

    // The control: an edit states the revision it read, so the create check above is not a constant.
    (document.body as unknown as { replaceChildren: () => void }).replaceChildren();
    const existing = { id: "dp-1", name: "Existing", cadenceSeconds: 3600, enabled: true, source: { type: "kv", binding: "KV_uploads", include: [], exclude: [] } } as Downpipe;
    openEditor(engine, existing, null, () => {}, () => {}, undefined, 7);
    await flushAsync(20);
    await saveEditor("Existing");
    ok("control: an edit states the revision it read", calls[1]?.base === 7 && calls[1]?.dp.id === "dp-1");
  }

  console.log(failures === 0 ? "\nPASS validate-wizard-create-precondition" : `\nFAIL validate-wizard-create-precondition (${failures})`);
  verdictReached(failures, checks);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
