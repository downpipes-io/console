// Validates the in-console break-glass restore panel: teardown nulls and zeroes both the recovered private
// and the per-run master directly on the panel's own state; the break-glass private never appears in any
// request while the recovered master crosses only on the restore header; and a wrong key degrades to a
// plain "this key does not match this archive" message.
//
// Run with `node test/validate-break-glass-restore.ts`.

import { installDomShim, qs, qsa, textOf, flushAsync } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

// FileReader + File are what readIdentityFile (attend.ts) and the reassembly card use to read a selected file
// locally; the shared shim does not provide them, so a minimal, faithful pair is installed here. readAsText
// resolves asynchronously (onload on a macrotask), exactly like the browser, so flushAsync drains it.
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
// A no-op MutationObserver so any transitive reference is safe; the panel factory under test wires none (the
// screen wrapper does, and that is not exercised here -- the test calls panel.teardown() directly).
g.MutationObserver = class {
  observe(): void {}
  disconnect(): void {}
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { renderBreakGlassRestore } from "../src/screens/restore-flow/break-glass.ts";
import { b64urlEncode } from "../src/bytes.ts";
import { restorePlanHash } from "../src/api.ts";
import type { CapsuleWrap } from "../src/lib/keydecap.ts";
import type { Caller, CapsuleResult, RestoreApproval, RestorePlan, RestoreRequest } from "../src/api.ts";

interface Vector {
  identityFile: string;
  keyCommitment: string;
  masterHex: string;
  wraps: CapsuleWrap[];
}
const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/keydecap-vector.json"), "utf8")) as Vector;
// A well-formed identity.key that is NOT this archive's recipient (96 bytes of 0x07): openCapsule finds no
// matching wrap and throws, which the panel must surface as a plain wrong-key message.
const WRONG_IDENTITY = `downpipe-identity-v1 ${b64urlEncode(new Uint8Array(96).fill(7))}`;
const RUN_ID = "01J9ZC8XNQ0000000000000AAA";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
}
function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}
// clickShim / setFilesAndChange drive the shimmed controls exactly as a browser would.
function clickShim(node: unknown): void {
  (node as { click: () => void }).click();
}
function supplyFile(input: unknown, text: string): void {
  (input as { files: unknown }).files = [new ShimFile([text], "identity.key")];
  (input as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "change", bubbles: true }));
}

async function main(): Promise<void> {
  installNav({ navigate: () => {}, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  const caller: Caller = { method: "access", email: "op@test", role: "operator", groups: [], isOnlyOwner: false };
  setCaller(caller);
  const engine = connect("https://engine.test");

  // A recording stub for the two engine calls the panel makes. restoreCapsule serves the pinned vector's
  // capsule so the panel's REAL openCapsule recovers the pinned master; restore records its arguments so the
  // test can prove what crossed the wire.
  const calls: { capsule: string[]; restore: Array<{ req: RestoreRequest; change: unknown; opts: { restoreMasterB64?: string } | undefined }> } = { capsule: [], restore: [] };
  engine.restoreCapsule = async (runId: string): Promise<CapsuleResult> => {
    calls.capsule.push(runId);
    return { ok: true, runId, masterCapsule: V.wraps, keyCommitment: V.keyCommitment, recordCount: 3 };
  };
  engine.restore = async (req: RestoreRequest, change?: unknown, opts?: { restoreMasterB64?: string }): Promise<RestorePlan> => {
    calls.restore.push({ req, change, opts });
    return { ok: true, runId: req.runId, mode: "dry-run", recordsVerified: 3, isLatest: true, plannedWrites: 3, bytes: 128, sample: [{ name: "greetings", sourceType: "kv", binding: "KV", plaintextSize: 12 }], skipped: [] };
  };
  // Stub the change-management policy read requireChange (confirm.ts's applyRestore) makes before the real
  // apply call, matching the established pattern in validate-restore-batch.ts / validate-config-changes.ts.
  // Left unstubbed this hits the real global fetch against the unresolvable "engine.test" host: requireChange
  // fails open on the rejection either way, but the wait for that rejection to settle is real network I/O on
  // a network-dependent timer, not a flushAsync-bounded microtask/macrotask chain, so it is a source of
  // flakiness under a loaded or sandboxed runner rather than a deterministic unit test.
  engine.getConfigApprovalPolicy = async () => ({ requireConfigApproval: false, requireChangeNumber: false });

  console.log("-- teardown-wipe + custody (FINDING 1) --");
  const panel = renderBreakGlassRestore(engine, RUN_ID);

  ok("panel starts with no private and no master", panel.peekSensitiveForTest().hasPrivate === false && panel.peekSensitiveForTest().master === null);

  const fileInput = qs(panel.el, "#bg-identity");
  ok("the identity.key file input is present", fileInput !== null);
  supplyFile(fileInput, V.identityFile);
  await flushAsync();
  ok("supplying identity.key populates the private closure", panel.peekSensitiveForTest().hasPrivate === true);
  ok("supplying the key alone does NOT populate a master (no decap yet)", panel.peekSensitiveForTest().master === null);

  const previewBtn = qs(panel.el, '[data-dp="restore-flow.button.preview"]');
  ok("preview is enabled once a run and a key are supplied", previewBtn !== null && (previewBtn as { disabled: boolean }).disabled === false);
  clickShim(previewBtn);
  await flushAsync();

  const expectedMasterB64 = b64urlEncode(hexToBytes(V.masterHex));
  const peeked = panel.peekSensitiveForTest();
  ok("the local decap populated the per-run master (32 bytes, matches the pinned vector)", peeked.master !== null && peeked.master.length === 32 && b64urlEncode(peeked.master) === expectedMasterB64);

  // CUSTODY: the break-glass PRIVATE never appears in any request; the master rides ONLY the header (opts).
  const identityToken = V.identityFile.trim().split(/\s+/)[1]!; // the 96-byte private, base64url
  ok("restoreCapsule was called with only a runId string (no private)", calls.capsule.length === 1 && calls.capsule[0] === RUN_ID && !JSON.stringify(calls.capsule).includes(identityToken));
  ok("restore was called exactly once, as a dry-run (no confirm)", calls.restore.length === 1 && calls.restore[0]!.req.confirm === undefined);
  const restoreCall = calls.restore[0]!;
  ok("the restore BODY carries only the runId (no master, no private field)", JSON.stringify(restoreCall.req) === JSON.stringify({ runId: RUN_ID }));
  ok("the master crossed ONLY on the header opts (restoreMasterB64), matching the decap", restoreCall.opts?.restoreMasterB64 === expectedMasterB64);
  ok("the break-glass PRIVATE token appears in NO restore argument", !JSON.stringify({ req: restoreCall.req, change: restoreCall.change, opts: restoreCall.opts }).includes(identityToken));

  // FINDING 1: teardown zeros the master IN PLACE and nulls BOTH closures, asserted on the panel's own state.
  const capturedMaster = panel.peekSensitiveForTest().master!;
  panel.teardown();
  const after = panel.peekSensitiveForTest();
  ok("teardown nulls the private reference", after.hasPrivate === false);
  ok("teardown nulls the master reference", after.master === null);
  ok("teardown zeroed the master bytes in place (all 32 bytes are 0)", capturedMaster.length === 32 && allZero(capturedMaster));
  panel.teardown(); // idempotent: a second teardown must not throw
  ok("teardown is idempotent (a second call is safe)", panel.peekSensitiveForTest().hasPrivate === false && panel.peekSensitiveForTest().master === null);

  console.log("\n-- wrong key degrades clearly (item 5) --");
  const panel2 = renderBreakGlassRestore(engine, RUN_ID);
  supplyFile(qs(panel2.el, "#bg-identity"), WRONG_IDENTITY);
  await flushAsync();
  ok("a well-formed but wrong identity.key still populates the private", panel2.peekSensitiveForTest().hasPrivate === true);
  const beforeWrongRestoreCalls = calls.restore.length;
  clickShim(qs(panel2.el, '[data-dp="restore-flow.button.preview"]'));
  await flushAsync();
  ok("a wrong key surfaces the plain 'does not match this archive' message", textOf(panel2.el).includes("does not match this archive"));
  ok("a wrong key never leaves a recovered master in the closure", panel2.peekSensitiveForTest().master === null);
  ok("a wrong key never reaches the restore call (decap failed first)", calls.restore.length === beforeWrongRestoreCalls);
  panel2.teardown();

  // ---- the panel that exists to APPLY a break-glass restore must actually be able to apply one. ------
  // Drives the panel end to end: preview, then the confirm+apply block it mounts, through an Apply click,
  // and asserts the master that opened the preview is the same master that rides the apply call.
  console.log("\n-- preview -> the real dual-control confirm+apply block -> Apply carries the SAME master --");
  {
    // An OWNER holds restore.apply (F1) so renderConfirm's role gate does not short-circuit to the read-only
    // panel; a distinct APPROVER signs so the maker-checker mirror (findUsableApproval, shared.ts) can arm.
    setCaller({ method: "access", email: "owner@test", role: "owner", groups: [], isOnlyOwner: true } as Caller);
    const expectedPlanHash = await restorePlanHash({ runId: RUN_ID });
    const approval: RestoreApproval = {
      planHash: expectedPlanHash,
      runId: RUN_ID,
      isLatest: true,
      plannedWrites: 3,
      bytes: 128,
      redirectBinding: null,
      requestedBy: "requester@test",
      requestedAt: new Date().toISOString(),
      reason: "prove recoverability",
      status: "approved",
      approvedBy: "approver@test", // DISTINCT from owner@test: maker != checker
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const restoreCallsBefore = calls.restore.length;
    engine.listApprovals = async () => [approval];
    // The apply-carries-the-master proof needs the stub to answer DIFFERENTLY for the dry-run preview
    // (confirm omitted) and the real apply (confirm:true) -- exactly like the real engine (router-restore.ts
    // gates on body.confirm), so a bug that silently dropped confirm:true would show up as an unexpected-mode
    // outcome rather than passing by accident.
    engine.restore = async (req, change, opts) => {
      calls.restore.push({ req, change, opts });
      if (req.confirm === true) {
        return { ok: true, runId: req.runId, mode: "applied", recordsVerified: 3, recordsRestored: 3, bytesRestored: 128, isLatest: true, failures: [] };
      }
      return { ok: true, runId: req.runId, mode: "dry-run", recordsVerified: 3, isLatest: true, plannedWrites: 3, bytes: 128, sample: [{ name: "greetings", sourceType: "kv", binding: "KV", plaintextSize: 12 }], skipped: [] };
    };

    const panel3 = renderBreakGlassRestore(engine, RUN_ID);
    supplyFile(qs(panel3.el, "#bg-identity"), V.identityFile);
    await flushAsync();
    clickShim(qs(panel3.el, '[data-dp="restore-flow.button.preview"]'));
    await flushAsync();

    ok("the preview succeeded and the REAL confirm+apply block mounted", qs(panel3.el, ".restore-confirm") !== null);
    ok("the dead-end 'raise it from the standard restore flow' copy is GONE", !textOf(panel3.el).includes("raise it from the standard restore flow"));
    ok("the gate ARMED (a usable approval from a distinct approver was found)", qs(panel3.el, ".restore-confirm__armed") !== null);

    const applyBtn = qs(panel3.el, '[data-dp="restore-flow.button.apply#3"]');
    ok("an Apply button is present", applyBtn !== null);
    const previewMasterB64 = calls.restore[restoreCallsBefore]?.opts?.restoreMasterB64;
    ok("sanity: the preview itself carried a master (established coverage above)", typeof previewMasterB64 === "string" && previewMasterB64.length > 0);

    clickShim(applyBtn);
    await flushAsync();
    // A same-binding, non-large, non-redirect plan uses the plain confirmModal (Confirm/Cancel), mounted at
    // document.body (NOT inside panel3.el -- it is a top-level overlay). Click its primary action.
    const modalSurface = qs(document.body, ".dialog--modal");
    ok("the Apply confirmation modal opened", modalSurface !== null);
    if (modalSurface) {
      const confirmActionBtn = qsa(modalSurface, "button").find((b) => textOf(b).trim() === "Apply restore");
      ok("the modal's own 'Apply restore' action is present", confirmActionBtn !== undefined);
      if (confirmActionBtn) clickShim(confirmActionBtn);
      await flushAsync();
    }

    ok("the apply reached the engine as a SECOND restore() call for THIS block (preview + apply, no extra calls)", calls.restore.length === restoreCallsBefore + 2);
    const applyCall = calls.restore[restoreCallsBefore + 1];
    ok("the apply call carries confirm:true (a real apply, not another dry-run)", applyCall?.req.confirm === true);
    ok(
      "the apply call carries the SAME master the preview recovered, on opts.restoreMasterB64 (never in the body)",
      applyCall?.opts?.restoreMasterB64 === previewMasterB64 && applyCall !== undefined && !("restoreMasterB64" in applyCall.req),
    );
    ok("the break-glass PRIVATE still appears in NO argument of the apply call", !JSON.stringify(applyCall).includes(identityToken));
    ok('the receipt rendered (the apply completed, not stuck on "Restoring")', textOf(panel3.el).includes("recovered") || qs(panel3.el, ".restore-receipt") !== null || !textOf(panel3.el).includes("Restoring"));

    panel3.teardown();
  }

  console.log(failures === 0 ? "\nBREAK-GLASS RESTORE PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
