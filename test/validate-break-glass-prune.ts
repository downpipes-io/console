// The in-console break-glass retention-prune panel, driven against the REAL panel code under the
// shared DOM shim (no jsdom, no network; the engine is a recording stub) -- the same style
// validate-break-glass-restore.ts uses for its sibling panel.
//
// Covers, against the real code: teardown-wipe custody (masters recovered via a REAL openCapsule decap of
// the pinned keydecap vector, zeroed in place and nulled on teardown, mirroring break-glass-restore's own
// teardown-wipe proof); the whole preview -> apply arc across every PruneApplyMode outcomeCard/renderOutcome
// renders (preview, not-approved, incomplete-batch, applied); the dual-control request panel (a blank
// reason cannot submit, a submitted reason calls retentionPruneRequest with the right downpipe id, and a
// successful request shows the "Awaiting approval" verdict with a link to the pending prune approvals
// inbox); that Apply re-disables after every attempt (masters are wiped on every non-preview call, so a
// retry needs a fresh preview -- the invariant notApprovedPanel's own copy promises); and the restore.apply
// capability gate that fronts the whole panel.
//
// Run with `node test/validate-break-glass-prune.ts`.

import { installDomShim, qs, qsa, textOf, flushAsync } from "./dom-shim.ts";
import { makeEvent } from "./dom-shim-core.ts";
installDomShim();

// FileReader + File, the same minimal faithful shim validate-break-glass-restore.ts installs (readIdentityFile
// needs both; the shared shim does not provide them).
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
import { connect, setCaller } from "../src/lib/store.ts";
import { installNav } from "../src/lib/nav.ts";
import { renderBreakGlassPrune } from "../src/screens/restore-flow/break-glass-prune.ts";
import { b64urlEncode } from "../src/bytes.ts";
import type { CapsuleWrap } from "../src/lib/keydecap.ts";
import type { Caller, PruneApplyResult, PruneApproval, PruneCandidateResult } from "../src/api.ts";
import { split, wrappingKeyChecksum } from "../src/lib/shamir.ts";
import { serialiseShareFile, serialiseEnvelopeFile } from "../src/lib/custody-files.ts";
import { encrypt } from "../src/lib/envelope.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

interface Vector {
  identityFile: string;
  keyCommitment: string;
  masterHex: string;
  wraps: CapsuleWrap[];
}
const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/keydecap-vector.json"), "utf8")) as Vector;
const RUN_ID = "01J9ZC8XNQ0000000000000AAA";
const DP_ID = "dp_prune_test";

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
function clickShim(node: unknown): void {
  (node as { click: () => void }).click();
}
function supplyFile(input: unknown, text: string): void {
  (input as { files: unknown }).files = [new ShimFile([text], "identity.key")];
  (input as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "change", bubbles: true }));
}
function setValue(node: unknown, v: string): void {
  (node as { value: string }).value = v;
  (node as { dispatchEvent: (e: unknown) => void }).dispatchEvent(makeEvent({ type: "input", bubbles: true }));
}

const candidateResult: PruneCandidateResult = {
  downpipeId: DP_ID,
  policy: { keepRuns: 1, enforce: true },
  retainedRunIds: [RUN_ID],
  supersededRunIds: [],
  capsules: [{ runId: RUN_ID, masterCapsule: V.wraps, keyCommitment: V.keyCommitment, recordCount: 3 }],
};
const expectedMasterB64 = b64urlEncode(hexToBytes(V.masterHex));

async function main(): Promise<void> {
  // The navigations are RECORDED, not discarded. The Awaiting-approval verdict's whole job is to hand the
  // operator the portal path for the second review, and a label naming the inbox is not the path.
  const navigations: string[] = [];
  installNav({ navigate: (to: string) => { navigations.push(to); }, onUnauthorised: () => {}, refreshIdentity: async () => {}, onAuthenticated: async () => {}, signOut: () => {} });
  // restore-operator holds restore.apply (the panel's own gate) AND restore.request (the request panel's
  // implicit floor, mirrored by the engine's own gate on POST /retention-prune/request).
  const caller: Caller = { method: "access", email: "op@test", role: "restore-operator", groups: [], isOnlyOwner: false };
  setCaller(caller);
  const engine = connect("https://engine.test");

  const calls: { candidate: string[]; apply: Array<{ downpipeId: string; batch: Array<{ runId: string; masterB64: string }>; previewOnly?: boolean }>; request: Array<{ downpipeId: string; reason: string }> } = {
    candidate: [],
    apply: [],
    request: [],
  };
  let nextApplyResult: PruneApplyResult = { downpipeId: DP_ID, mode: "preview", retainedRuns: 1, supersededRuns: 0, runTreeObjects: 0, orphanSegs: 0 };
  engine.retentionPruneCandidate = async (downpipeId: string): Promise<PruneCandidateResult> => {
    calls.candidate.push(downpipeId);
    return candidateResult;
  };
  engine.retentionPruneApply = async (input: { downpipeId: string; batch: Array<{ runId: string; masterB64: string }>; previewOnly?: boolean }): Promise<PruneApplyResult> => {
    calls.apply.push(input);
    return nextApplyResult;
  };
  engine.retentionPruneRequest = async (input: { downpipeId: string; reason: string }): Promise<PruneApproval> => {
    calls.request.push(input);
    return {
      planHash: "sha384:test",
      downpipeId: input.downpipeId,
      retainedRuns: 1,
      supersededRuns: 0,
      requestedBy: caller.email ?? "op@test",
      requestedAt: new Date().toISOString(),
      reason: input.reason,
      status: "requested",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  };

  console.log("-- permission gate (the panel that fronts every branch below) --");
  {
    const viewerCaller: Caller = { method: "access", email: "viewer@test", role: "viewer", groups: [], isOnlyOwner: false };
    setCaller(viewerCaller);
    const gated = renderBreakGlassPrune(engine, DP_ID);
    ok("a caller without restore.apply sees the permission gate, not the panel", textOf(gated.el).includes("Permission to apply a retention prune required"));
    ok("the gated render never touches sensitive state", gated.peekSensitiveForTest().hasPrivate === false && gated.peekSensitiveForTest().masterCount === 0);
    setCaller(caller);
  }

  console.log("\n-- load candidates, supply the key, recover + preview --");
  const panel = renderBreakGlassPrune(engine, DP_ID);
  ok("panel starts with no private and no masters", panel.peekSensitiveForTest().hasPrivate === false && panel.peekSensitiveForTest().masterCount === 0);

  const loadBtn = qs(panel.el, '[data-dp="restore-flow.button.load-candidates"]');
  ok("Load this downpipe's runs is present and enabled (downpipeId was prefilled)", loadBtn !== null && (loadBtn as { disabled: boolean }).disabled === false);
  clickShim(loadBtn);
  await flushAsync();
  ok("retentionPruneCandidate was called with the prefilled downpipe id", calls.candidate.length === 1 && calls.candidate[0] === DP_ID);
  ok("the candidate summary names the retained/superseded split", textOf(panel.el).includes("1 run(s) in scope"));
  ok("an enforce-on downpipe says Apply will actually delete", textOf(panel.el).includes("Enforce toggle is ON"));

  const fileInput = qs(panel.el, "#bgp-identity");
  ok("the identity.key file input is present", fileInput !== null);
  supplyFile(fileInput, V.identityFile);
  await flushAsync();
  ok("supplying identity.key populates the private closure", panel.peekSensitiveForTest().hasPrivate === true);
  ok("supplying the key alone does NOT populate a master (no decap yet)", panel.peekSensitiveForTest().masterCount === 0);

  const recoverBtn = qs(panel.el, '[data-dp="restore-flow.button.recover"]');
  ok("Recover keys and preview is enabled once candidates + a key are both present", recoverBtn !== null && (recoverBtn as { disabled: boolean }).disabled === false);
  clickShim(recoverBtn);
  await flushAsync();
  ok("the local decap populated exactly one recovered master", panel.peekSensitiveForTest().masterCount === 1);
  ok("retentionPruneApply was called with previewOnly true", calls.apply.length === 1 && calls.apply[0]!.previewOnly === true);
  ok("the batch carries the run's REAL recovered master (matches the pinned vector), not a placeholder", calls.apply[0]!.batch.length === 1 && calls.apply[0]!.batch[0]!.runId === RUN_ID && calls.apply[0]!.batch[0]!.masterB64 === expectedMasterB64);
  ok("a preview outcome says nothing was deleted", textOf(panel.el).includes("Preview: nothing was deleted"));

  const applyBtn = qs(panel.el, '[data-dp="restore-flow.button.apply#2"]');
  ok("Apply re-arms after a preview that recovered a master", applyBtn !== null && (applyBtn as { disabled: boolean }).disabled === false);
  // THE PRESERVED CONTROL'S REASON MUST BE REAL TEXT, AND MUST TRACK THE ARMING. This button deliberately
  // keeps `disabled` (its handler is attached unconditionally and it deletes archived backup data), so it
  // cannot carry its reason the way the 33 migrated controls do. It previously carried it in a hover TITLE
  // alone, and the code claimed the live plan region covered a non-mouse reader; that region is empty until
  // something has been previewed, which is exactly when the Apply is held. A re-armed Apply must also stop
  // announcing a hold that has been lifted, which is the half a static reason would get wrong.
  ok("a re-armed Apply announces no stale hold", !textOf(applyBtn as never).includes("Recover keys and preview first"));

  console.log("\n-- apply refuses \"not-approved\": the dual-control request panel --");
  nextApplyResult = { downpipeId: DP_ID, mode: "not-approved", retainedRuns: 1, supersededRuns: 0, planHash: "sha384:abc123", error: "prune not approved" };
  clickShim(applyBtn);
  await flushAsync();
  ok("retentionPruneApply was called a second time, previewOnly false", calls.apply.length === 2 && calls.apply[1]!.previewOnly === false);
  ok("the not-approved refusal renders the dual-control banner, never a bare error", textOf(panel.el).includes("A second authorised identity needs to approve this plan"));
  ok("it does not claim a delete happened", !textOf(panel.el).includes("Applied") || textOf(panel.el).includes("Apply now"));
  ok("every apply attempt wipes the batch it sent (custody: held for one request only)", panel.peekSensitiveForTest().masterCount === 0);
  ok("Apply disables again until a fresh preview (masters are gone, so a same-batch retry would be dishonest)", (applyBtn as { disabled: boolean }).disabled === true);
  // And the reason comes BACK as real text, not only as a title, so a screen-reader or touch user is told
  // why the control they can see will not act. This is the assertion that would have failed before the
  // reason was carried in a visually-hidden span.
  ok("a re-held Apply says why, in text rather than only in a hover title", textOf(applyBtn as never).includes("Recover keys and preview first"));
  ok("and the title still says it too, so a mouse user loses nothing", (applyBtn as unknown as { title: string }).title === "Recover keys and preview first.");

  const reasonField = qs(panel.el, "#bgp-prune-reason");
  ok("the request panel's reason field is present", reasonField !== null);
  const requestBtn = qs(panel.el, '[data-dp="restore-flow.button.request#1"]');
  ok("the Request approval button is present", requestBtn !== null);

  clickShim(requestBtn);
  await flushAsync();
  ok("a BLANK reason refuses to submit (validateForm), so no request is raised", calls.request.length === 0);

  setValue(reasonField, "Clearing superseded runs past the retention window");
  clickShim(requestBtn);
  await flushAsync();
  ok("a filled reason raises exactly one request, against the right downpipe", calls.request.length === 1 && calls.request[0]!.downpipeId === DP_ID);
  ok("the reason travels verbatim to retentionPruneRequest", calls.request[0]!.reason === "Clearing superseded runs past the retention window");
  ok("a successful request shows the Awaiting approval verdict", textOf(panel.el).includes("Awaiting approval"));
  // SCOPED TO THE VERDICT, NOT THE PANEL. Asking the whole panel whether the phrase appears anywhere is
  // already true BEFORE any request is raised: the request form's own standing instruction says "a
  // different authorised operator approves it from the pending prune approvals inbox", and it renders
  // unconditionally. So the line below used to pass with the verdict absent, which is the one thing it
  // exists to check. The claim is that THIS VERDICT names the portal path, so the verdict is what is read.
  const verdict = qsa(panel.el, "*").find((n) => textOf(n).includes("Awaiting approval") && textOf(n).includes("Request raised"));
  ok("the Awaiting approval verdict is locatable as its own element, or the scoping below means nothing", verdict !== undefined);
  ok("it names the pending prune approvals inbox ON THE VERDICT, not merely somewhere on the panel", verdict !== undefined && textOf(verdict).includes("pending prune approvals inbox"));
  // AND IT POINTS THERE. The phrase is text; the portal path is the thing the second review needs, and
  // only the action carries it. So the verdict's own control is driven and the destination recorded.
  const inboxAction = verdict === undefined ? undefined : qsa(verdict, "button").find((b) => textOf(b).includes("Open the pending prune approvals inbox"));
  navigations.length = 0;
  inboxAction?.click();
  ok("it POINTS at the pending prune approvals inbox, the portal path this row's second review required", navigations.length === 1 && navigations[0] === "/restore/prune-approvals");

  console.log("\n-- \"incomplete-batch\": some candidate runs could not be opened, refused before any plan --");
  clickShim(recoverBtn);
  await flushAsync();
  ok("masters are recovered again ahead of a fresh apply attempt", panel.peekSensitiveForTest().masterCount === 1);
  nextApplyResult = { downpipeId: DP_ID, mode: "incomplete-batch", retainedRuns: 1, supersededRuns: 0, missingRunIds: ["01J9ZC8XNQ0000000000000BBB"] };
  clickShim(applyBtn);
  await flushAsync();
  ok("an incomplete batch says some runs could not be opened, not a generic failure", textOf(panel.el).includes("Some runs could not be opened"));
  ok("it names the specific missing run id, so the operator knows which key to try", textOf(panel.el).includes("01J9ZC8XNQ0000000000000BBB"));
  ok("nothing was deleted (it says so)", textOf(panel.el).includes("nothing was deleted"));

  console.log("\n-- \"applied\": the terminal success outcome --");
  clickShim(recoverBtn);
  await flushAsync();
  nextApplyResult = { downpipeId: DP_ID, mode: "applied", retainedRuns: 1, supersededRuns: 1, runTreeObjects: 4, orphanSegs: 2 };
  clickShim(applyBtn);
  await flushAsync();
  ok("an applied outcome shows the Applied card", textOf(panel.el).includes("Applied"));
  ok("it carries the real counts from the engine's own response (2 orphaned segment(s))", textOf(panel.el).includes("2 orphaned segment(s)"));
  ok("masters are wiped again after the applied call", panel.peekSensitiveForTest().masterCount === 0);

  console.log("\n-- teardown wipes both closures (mirrors break-glass-restore's own teardown-wipe proof) --");
  clickShim(recoverBtn);
  await flushAsync();
  const capturedMasterCount = panel.peekSensitiveForTest().masterCount;
  ok("a master is recovered ahead of teardown, so the wipe assertion is not vacuous", capturedMasterCount === 1);
  panel.teardown();
  const after = panel.peekSensitiveForTest();
  ok("teardown nulls the private reference", after.hasPrivate === false);
  ok("teardown clears every recovered master", after.masterCount === 0);
  panel.teardown(); // idempotent: a second teardown must not throw
  ok("teardown is idempotent (a second call is safe)", panel.peekSensitiveForTest().hasPrivate === false && panel.peekSensitiveForTest().masterCount === 0);

  // ---------------------------------------------------------------------------------------------------
  // WHAT THE PANEL SAYS, not only what it holds. Both `resetKeyStatus?.()` call sites in
  // break-glass-prune.ts can be deleted independently without any assertion here or in
  // validate-break-glass-restore-from-shares, validate-break-glass-restore, validate-custody-resplit,
  // validate-attend-from-shares, lint:key-wipe or lint:split-custody catching it, because hasPrivate ===
  // false and masterCount === 0 stay true even when the status text is wrong. The status text is a
  // separate claim: an operator mid-incident reads "Split key reassembled in this browser. Nothing was
  // uploaded." as custody state, and if that sentence outlives the key it asserts the opposite of the
  // truth while the panel holds nothing. So these assert on the rendered text, on both paths that drop
  // the key.
  // ---------------------------------------------------------------------------------------------------
  console.log("\n-- the key status must stop claiming a key is held once it is not (the seventh custody defect) --");
  {
    const REASSEMBLED = "Split key reassembled in this browser";
    const DEFAULT_STATUS = "No key supplied yet.";
    // The custody artefacts, built the way the custody step emits them: the pinned vector's identity.key
    // encrypted under a fresh wrapping key, and that key split 3-of-5.
    const env = await encrypt(new TextEncoder().encode(V.identityFile));
    const shares = split(env.wrappingKey, 5, 3);
    const checksum = wrappingKeyChecksum(env.wrappingKey);
    const envelopeFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
    const shareFiles = shares.map((s, i) => serialiseShareFile({ index: i + 1, n: 5, threshold: 3, checksum, share: s }));

    // A fresh panel: the one above has been torn down twice.
    const p2 = renderBreakGlassPrune(engine, DP_ID);
    const r2 = p2.el;
    await flushAsync();
    const says = (phrase: string): boolean => textOf(r2).includes(phrase);
    const addShare = async (text: string): Promise<void> => {
      setValue(qs(r2, "#recover-shares-paste"), text);
      clickShim(qs(r2, '[data-dp="restore-flow.button.add-share"]'));
      await flushAsync();
    };

    for (const s of shareFiles.slice(0, 3)) await addShare(s);
    supplyFile(qs(r2, "#recover-ciphertext"), envelopeFile);
    await flushAsync();
    clickShim(qs(r2, '[data-dp="restore-flow.button.reconstruct"]'));
    await flushAsync();
    // Not vacuous: the claim must actually appear while it is TRUE, or the two assertions below are
    // satisfied by a panel that never said it in the first place.
    ok("a quorum reconstructs into the prune panel and it says so while that is true", p2.peekSensitiveForTest().hasPrivate === true && says(REASSEMBLED));

    // PATH 1, the seventh defect itself: edit the share list the key was derived from. The staleness rule
    // correctly drops the private; the sentence must go with it. No teardown is involved.
    clickShim(qs(r2, '[data-dp="restore-flow.button.remove-share"]'));
    await flushAsync();
    ok("editing the shares drops the private", p2.peekSensitiveForTest().hasPrivate === false);
    ok("and the status STOPS claiming a reassembled key is held", says(REASSEMBLED) === false);
    ok("and it reads as holding nothing, rather than merely going blank", says(DEFAULT_STATUS));

    // PATH 2: teardown. Same sentence, different trigger, separate call site.
    for (const s of shareFiles.slice(0, 3)) await addShare(s);
    supplyFile(qs(r2, "#recover-ciphertext"), envelopeFile);
    await flushAsync();
    clickShim(qs(r2, '[data-dp="restore-flow.button.reconstruct"]'));
    await flushAsync();
    ok("a fresh quorum reconstructs again, so the teardown assertion is not vacuous", p2.peekSensitiveForTest().hasPrivate === true && says(REASSEMBLED));
    p2.teardown();
    await flushAsync();
    ok("teardown stops the status claiming a reassembled key is held", says(REASSEMBLED) === false);
    ok("and a torn-down prune panel reads as holding nothing", says(DEFAULT_STATUS));
    // The standing limit, unchanged: this settles which code runs, not what survives in a browser's heap.
  }

  console.log(failures === 0 ? "\nBREAK-GLASS PRUNE PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
