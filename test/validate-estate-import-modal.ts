// Drives the REAL estate-import modal (src/components/estate-import-modal.ts) under the shared DOM
// shim: the UNCHANGED plaintext path, and the NEW sealed path end to end -- pasting a sealed artefact
// reveals the break-glass-key panel, uploading identity.key (entirely in this browser, never uploaded)
// unseals it, and the recovered plaintext is relayed to engine.controlPlaneImportSealed alongside the
// still-sealed original for the engine's own re-verify. Also proves the field-level refusals (missing
// sig/pub/key, a wrong key, an engine 400) and that both exits (Cancel and Esc-dismiss) wipe the held
// private key.
//
// Run with `node test/validate-estate-import-modal.ts`.

import { installDomShim, qs, qsa, textOf, flushAsync, dispatchDocKey, keydown } from "./dom-shim.ts";
import { makeEvent, type ShimNode } from "./dom-shim-core.ts";
installDomShim();

// waitFor drains until the OUTCOME holds rather than for a fixed number of rounds, instead of a fixed
// number of flushAsync rounds: the ShimFileReader macrotask that reads identity.key and the unseal chain
// that follows it can take more turns than a fixed budget allows on a loaded machine, so a round-count
// drain can return before the work it was draining has finished, and ok() is not fatal, so a failed count
// assertion can fall straight through into an index of an array the wait never filled.
//
// Each site below waits for the specific thing it is about to assert, and is bounded so a genuinely
// broken modal still fails fast rather than hanging. A timeout is counted as a named failure rather than
// a silent return, so a caller that is about to index can decline to.
async function waitFor(done: () => boolean, what: string, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (done()) return true;
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  ok(`waited up to ${timeoutMs}ms for ${what}`, false);
  return false;
}

// FileReader + File: the same minimal, faithful pair test/validate-break-glass-restore.ts installs (the
// shared shim does not provide them). readAsText resolves on a macrotask, exactly like the browser.
class ShimFile {
  _text: string;
  name: string;
  type = "text/plain";
  constructor(parts: string[], name: string) {
    this._text = parts.join("");
    this.name = name;
  }
}
class ShimFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | null = null;
  readAsText(file: ShimFile): void {
    this.result = file._text;
    setTimeout(() => this.onload?.(), 0);
  }
}
const g = globalThis as unknown as { FileReader: unknown; File: unknown; location: unknown; MutationObserver: unknown };
g.FileReader = ShimFileReader;
g.File = ShimFile;
g.location = g.location ?? { origin: "https://console.test" };
g.MutationObserver = class {
  observe(): void {}
  disconnect(): void {}
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openEstateImportModal } from "../src/components/estate-import-modal.ts";
import type { SealedControlPlaneExport } from "../src/lib/sealed-export-unseal.ts";
import type { EngineClient, EstateImportResult } from "../src/api.ts";

interface Vector {
  identityFile: string;
  otherIdentityFile: string;
  signerPublic: string;
  sealed: SealedControlPlaneExport;
  sealedSignature: string;
  innerExport: unknown;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/sealed-export-vector.json"), "utf8")) as Vector;
const SEALED_TEXT = JSON.stringify(V.sealed);

const VALID_EXPORT = {
  v: 1,
  exportedAt: "2026-07-05T00:00:00.000Z",
  configContentHash: "sha384:x",
  downpipes: [],
  destinations: [],
  roles: [],
  priorAuditHead: { headSeq: 0, headHash: "sha384:0" },
};
const VALID_EXPORT_TEXT = JSON.stringify(VALID_EXPORT);
const RESULT: EstateImportResult = { ok: true, downpipes: 2, destinations: 1, downpipesDisabled: false, authorityImported: false, bridgedFrom: { headSeq: 5, headHash: "sha384:h" } };

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

function surface(): ShimNode | null {
  return qs(document.body, ".dialog--modal");
}
function setValue(root: ShimNode, id: string, text: string): void {
  const el = qs(root, `#${id}`);
  if (!el) throw new Error(`no #${id} in the modal`);
  el.value = text;
  el.dispatchEvent(makeEvent({ type: "input", bubbles: true }));
}
function findButtonByText(root: ShimNode, text: string): ShimNode {
  const btn = qsa(root, "button").find((b) => textOf(b).includes(text));
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn;
}
function sealedSection(root: ShimNode): ShimNode {
  const s = qs(root, "section");
  if (!s) throw new Error("no <section> (the sealed panel) in the modal");
  return s;
}
function uploadIdentity(root: ShimNode, text: string): void {
  const input = qs(root, "#cp-import-sealed-identity");
  if (!input) throw new Error("no identity file input");
  (input as unknown as { files: unknown }).files = [new ShimFile([text], "identity.key")];
  input.dispatchEvent(makeEvent({ type: "change", bubbles: true }));
}
function errorText(root: ShimNode): string {
  // Two [role="alert"] nodes exist (the sealed panel's own keyErr, then the form-wide formError last in
  // document order); the form-wide one is what runImport's showFormError writes to, so take the LAST match.
  const all = qsa(root, '[role="alert"]');
  const p = all[all.length - 1];
  return p ? textOf(p) : "";
}
// closeModal: every block opens its OWN modal, so each must close it (Cancel) and flush before the next
// block opens another -- otherwise an unclosed modal from an earlier block outlives it (dialog stacking
// means it is still in the document) and surface()'s first-match query silently aliases onto it instead
// of the new one, so a later block ends up driving the WRONG modal's fields entirely.
async function closeModal(): Promise<void> {
  const s = surface();
  if (!s) return;
  const cancel = qsa(s, "button").find((b) => textOf(b).includes("Cancel"));
  if (cancel) cancel.click();
  await flushAsync();
}
function stubEngine(overrides: Partial<EngineClient> = {}): { engine: EngineClient; calls: { plain: unknown[]; sealed: unknown[] } } {
  const calls: { plain: unknown[]; sealed: unknown[] } = { plain: [], sealed: [] };
  const engine = {
    controlPlaneImport: async (...args: unknown[]): Promise<EstateImportResult> => {
      calls.plain.push(args);
      return RESULT;
    },
    controlPlaneImportSealed: async (...args: unknown[]): Promise<EstateImportResult> => {
      calls.sealed.push(args);
      return RESULT;
    },
    ...overrides,
  } as unknown as EngineClient;
  return { engine, calls };
}

async function main(): Promise<void> {
  console.log("estate-import-modal: the plaintext path is UNCHANGED");
  {
    const { engine, calls } = stubEngine();
    const imported: EstateImportResult[] = [];
    openEstateImportModal(engine, (r) => imported.push(r));
    const s = surface();
    ok("the modal opened", s !== null);
    if (!s) return;
    ok("the sealed panel starts hidden", sealedSection(s).hidden === true);
    setValue(s, "cp-import-export", VALID_EXPORT_TEXT);
    ok("a plaintext export keeps the sealed panel hidden", sealedSection(s).hidden === true);
    setValue(s, "cp-import-sig", "the-sig");
    setValue(s, "cp-import-pub", "downpipe-signer-public-v1 AAAA");
    findButtonByText(s, "Import").click();
    const plainArrived = await waitFor(() => calls.plain.length >= 1 && imported.length >= 1, "the plaintext import call and the onImported callback");
    ok("controlPlaneImport was called once, controlPlaneImportSealed never", calls.plain.length === 1 && calls.sealed.length === 0);
    // Indexed with ?. rather than !, and gated on the wait having arrived. ok() is not fatal, so without
    // this a failed count assertion falls through into an index of an empty array and throws, which the
    // completion guard then reports as a run that never reached its tally.
    ok("onImported fired with the engine's result", plainArrived && imported.length === 1 && imported[0]?.downpipes === 2);
    ok("the modal closed on success", surface() === null);
  }

  console.log("estate-import-modal: an empty export is refused without reaching the engine");
  {
    const { engine, calls } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("an empty export shows an inline error", errorText(s).length > 0);
    ok("neither engine call was made", calls.plain.length === 0 && calls.sealed.length === 0);
    ok("the modal stayed open", surface() !== null);
    findButtonByText(s, "Cancel").click();
    await flushAsync();
    ok("Cancel closes it", surface() === null);
  }

  console.log("estate-import-modal: non-JSON paste and a shape that is neither export are both refused");
  {
    const { engine } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", "{not json");
    setValue(s, "cp-import-sig", "s");
    setValue(s, "cp-import-pub", "p");
    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("non-JSON is refused inline", errorText(s).length > 0);
    ok("the modal stayed open (non-JSON)", surface() !== null);
    setValue(s, "cp-import-export", JSON.stringify({ v: 99, nothingRecognisable: true }));
    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("JSON matching neither shape is refused inline", errorText(s).length > 0);
    dispatchDocKey(keydown({ key: "Escape" }));
    await flushAsync();
    ok("Esc dismiss closes it", surface() === null);
  }

  console.log("estate-import-modal: pasting a SEALED export reveals the break-glass-key panel");
  {
    const { engine } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    ok("the sealed panel is now visible", sealedSection(s).hidden === false);
    ok("no key supplied yet", textOf(s).includes("No key supplied yet"));
    await closeModal();
  }

  console.log("estate-import-modal: the sealed path's own required-field refusals, each distinct");
  {
    const { engine, calls } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);

    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("missing signature is refused, naming the .sealed.json.sig file", /signature/i.test(errorText(s)));

    setValue(s, "cp-import-sig", V.sealedSignature);
    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("missing signer.pub is refused, naming the kit", /signer\.pub/i.test(errorText(s)));

    setValue(s, "cp-import-pub", V.signerPublic);
    findButtonByText(s, "Import").click();
    await flushAsync();
    ok("missing the break-glass key is refused before any unseal is attempted", /break-glass identity\.key/i.test(errorText(s)));
    ok("no engine call was made across any of the three refusals", calls.plain.length === 0 && calls.sealed.length === 0);
    await closeModal();
  }

  console.log("estate-import-modal: the key is read in THIS browser, never uploaded, then a WRONG key degrades honestly");
  {
    const { engine, calls } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    setValue(s, "cp-import-sig", V.sealedSignature);
    setValue(s, "cp-import-pub", V.signerPublic);
    uploadIdentity(s, V.otherIdentityFile);
    await waitFor(() => textOf(s).includes("It was not uploaded"), "the notice that the export was not uploaded");
    ok("the key-read status confirms it was not uploaded", textOf(s).includes("It was not uploaded"));

    findButtonByText(s, "Import").click();
    await waitFor(() => errorText(s).length > 0, "an error message to appear");
    ok("a real identity that is not this artefact's recipient is refused honestly, not thrown", errorText(s).length > 0);
    ok("still no engine call: the wrong key never reaches unseal's caller", calls.plain.length === 0 && calls.sealed.length === 0);
    await closeModal();
  }

  console.log("estate-import-modal: toggling back to plaintext WIPES the held key (never carried across a shape change)");
  {
    const { engine } = stubEngine();
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    uploadIdentity(s, V.identityFile);
    await waitFor(() => textOf(s).includes("Key read in this browser"), "the identity key to be read in this browser");
    ok("the key was read", textOf(s).includes("Key read in this browser"));
    setValue(s, "cp-import-export", VALID_EXPORT_TEXT); // shape flips to plaintext: wipePrivate() fires
    setValue(s, "cp-import-export", SEALED_TEXT); // and back to sealed, but the key is gone
    setValue(s, "cp-import-sig", V.sealedSignature);
    setValue(s, "cp-import-pub", V.signerPublic);
    findButtonByText(s, "Import").click();
    await waitFor(() => errorText(s).length > 0, "an error message to appear");
    ok("the key must be re-supplied: it did not survive the plaintext detour", /break-glass identity\.key/i.test(errorText(s)));
    await closeModal();
  }

  console.log("estate-import-modal: the sealed path's happy path -- unseal in the browser, relay BOTH artefacts to import-sealed");
  {
    const { engine, calls } = stubEngine();
    const imported: EstateImportResult[] = [];
    openEstateImportModal(engine, (r) => imported.push(r));
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    setValue(s, "cp-import-sig", V.sealedSignature);
    setValue(s, "cp-import-pub", V.signerPublic);
    uploadIdentity(s, V.identityFile);
    // Wait for the KEY TO HAVE BEEN READ, not merely for the status node to exist. The node exists from the
    // moment the sealed panel is revealed and says "No key supplied yet", so waiting on its presence returns
    // on the first turn, before ShimFile's readAsText macrotask has fired, and the Import click below then
    // happens with no key held and no sealed call is ever made. That was tried first here and it turned an
    // intermittent failure into a reliable one, which is the useful kind of mistake: it says out loud that
    // the ten-round drain this replaces was doing real work and not just idling.
    await waitFor(() => textOf(s).includes("Key read in this browser"), "the identity key to be read in this browser");

    const keyStatusOnSuccess = qsa(s, '[role="status"]')[0];
    findButtonByText(s, "Import").click();
    // The waits are `>=` while the assertions stay `===`. A wait that asked for the exact count would go on
    // draining past a duplicate call until it timed out and then report the duplicate as an absence, so the
    // wait names the moment the outcome has arrived and the assertion still owns the count.
    const sealedArrived = await waitFor(() => calls.sealed.length >= 1 && imported.length >= 1, "the sealed import call and the onImported callback");
    ok("controlPlaneImportSealed was called once, controlPlaneImport never", calls.sealed.length === 1 && calls.plain.length === 0);
    // This is the exact line that threw in 86 of the 95 failing runs at width 256. `?? []` rather than an
    // index of an array the wait may not have filled, so every assertion below REPORTS rather than
    // throwing, which is the difference between a named failure and a run with no tally at all.
    const args = (calls.sealed[0] ?? []) as [unknown, string, string, unknown] | [];
    ok("the sealed signature forwarded matches the pasted one", sealedArrived && args[1] === V.sealedSignature);
    ok("the signer.pub forwarded matches the pasted one", sealedArrived && args[2] === V.signerPublic);
    ok("the fourth argument is the RECOVERED plaintext (has the inner export's configVersion)", sealedArrived && (args[3] as { configVersion?: number } | undefined)?.configVersion === 3);
    ok("onImported fired with the engine's result", imported.length === 1 && imported[0]?.downpipes === 2);
    ok("the modal closed on success", surface() === null);
    // A successful import is an exit path too. wipeAllKeyMaterial() runs before the modal closes, so
    // the reassembly card's onInvalidated cascade must have reset this status line, exactly as Cancel/Esc do.
    ok("a successful import also tears down the reassembly card", keyStatusOnSuccess !== undefined && textOf(keyStatusOnSuccess).includes("No key supplied yet"));
  }

  console.log("estate-import-modal: Cancel and Esc both tear down the mounted reassembly card, not just this modal's own key");
  {
    // wipePrivate() (this modal's own closure) never touches the key-status line; the ONLY code path that
    // resets it back to "No key supplied yet." after a key was read is reassembly.ts's onInvalidated
    // cascade, fired by reassembly.teardown(). Before this fix, teardown() was never called on Cancel/Esc/
    // dismiss, so a reconstructed break-glass private survived, unzeroed, in the reassembly card's own
    // closure for the rest of the page's life -- silently, since nothing on screen showed it. This is
    // exactly the kind of regression that needs a standing assertion rather than a one-off manual check.
    const { engine } = stubEngine();
    openEstateImportModal(engine);
    let s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    uploadIdentity(s, V.identityFile);
    await waitFor(() => textOf(s).includes("Key read in this browser"), "the identity key to be read in this browser");
    let keyStatus = qsa(s, '[role="status"]')[0];
    ok("key-read status shows before Cancel", keyStatus !== undefined && textOf(keyStatus).includes("Key read in this browser"));
    findButtonByText(s, "Cancel").click();
    await flushAsync();
    ok("Cancel resets the key-read status via the reassembly teardown cascade", keyStatus !== undefined && textOf(keyStatus).includes("No key supplied yet"));

    openEstateImportModal(engine);
    s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    uploadIdentity(s, V.identityFile);
    await waitFor(() => textOf(s).includes("Key read in this browser"), "the identity key to be read in this browser");
    keyStatus = qsa(s, '[role="status"]')[0];
    ok("key-read status shows before Esc-dismiss", keyStatus !== undefined && textOf(keyStatus).includes("Key read in this browser"));
    dispatchDocKey(keydown({ key: "Escape" }));
    await flushAsync();
    ok("Esc-dismiss resets the key-read status via the reassembly teardown cascade", keyStatus !== undefined && textOf(keyStatus).includes("No key supplied yet"));
  }

  console.log("estate-import-modal: an engine refusal on the sealed path is shown inline, modal stays open");
  {
    const { engine } = stubEngine({
      controlPlaneImportSealed: async () => {
        throw new Error("only an Owner can import an estate");
      },
    });
    openEstateImportModal(engine);
    const s = surface();
    if (!s) throw new Error("no modal");
    setValue(s, "cp-import-export", SEALED_TEXT);
    setValue(s, "cp-import-sig", V.sealedSignature);
    setValue(s, "cp-import-pub", V.signerPublic);
    uploadIdentity(s, V.identityFile);
    await waitFor(() => textOf(s).includes("Key read in this browser"), "the identity key to be read in this browser");
    findButtonByText(s, "Import").click();
    await waitFor(() => errorText(s).length > 0, "an error message to appear");
    ok("the engine's own refusal message is shown", errorText(s).includes("only an Owner can import an estate"));
    ok("the modal stayed open on an engine refusal", surface() !== null);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-estate-import-modal (${failures} failure(s))`);
  if (failures > 0) process.exitCode = 1;
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
