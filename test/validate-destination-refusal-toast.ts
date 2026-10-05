// validate-destination-refusal-toast.ts -- the plain remove-destination refusal toast shows the ENGINE's
// own sentence, not the transport's envelope around it.
//
// Run with: node test/validate-destination-refusal-toast.ts
//
// The engine refuses to remove a destination that downpipes still use with an "in use by N downpipe(s)"
// 400, naming which downpipes to reassign. `parseJsonOrOwnerAction` folds that reason into the thrown
// message as `<verb>: <reason>: <status>` (client-transport.ts), the same envelope the force-remove
// dialogue's `engineRefusalText` already unwraps (validate-orphan-guard-reason-on-screen.ts covers that
// dialogue). This file covers the OTHER refusal surface in the same handler: the plain toast an "in use
// by" refusal falls through to, which never went through offerForceRemove and never unwrapped the
// envelope.
//
// This drives the REAL removeDestination handler over the DOM shim, through a REAL Transport that
// produces the exact envelope from a stubbed 400 response (rather than a hand-typed guess at the shape),
// and reads the toast a customer actually sees.
//
// It also covers the SUCCESS side of the same handler: engine 0.3.7 rides an optional `notice` on a
// removal that cost something (a force dropped runs, or older runs the run history no longer holds), and
// the toast must show it, in the warn tone, instead of the plain "Destination removed."

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qs, qsa, flushAsync, textOf, classesOf, type ShimNode } from "./dom-shim.ts";
import { SN, findButtonByText, click } from "./validate-stable-components-shared.ts";
import { removeDestination } from "../src/screens/destination-cards-actions.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import type { ConfigApprovalPolicy, DestinationList, DestinationStatus, EngineClient, OwnerActionResult } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

console.log("validate-destination-refusal-toast");

// The engine's real sentence shape for this refusal: it names the count and the downpipes to reassign.
const REASON = "destination is in use by 2 downpipe(s): Ledger, Mail. Reassign them first.";

// engineRemoveError drives the REAL Transport against a stubbed 400 so the fixture is the exact envelope
// parseJsonOrOwnerAction throws, not a hand-typed guess at its shape.
async function engineRemoveErrorFor(reason: string): Promise<Error> {
  const t = new Transport("https://engine.example.invalid");
  const r = new Response(JSON.stringify({ error: reason }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    await t.parseJsonOrOwnerAction(r, "remove destination");
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected parseJsonOrOwnerAction to throw");
}
async function engineRemoveError(): Promise<Error> {
  return engineRemoveErrorFor(REASON);
}

// LONG_IN_USE_REFUSAL is destInUseRefusal(["Ledger", "Mail", "Nightly", "Archive", "Backups", "Extra"],
// { count: 12, names: ["src-d1", "src-r2"], unreplicable: 2, olderOutsideHistory: 4 }), built from engine
// src/sched/dest-removal-text.ts at d852e17b and pasted here verbatim (1,056 characters): the "in use"
// refusal (the one this plain toast surfaces, never the orphan guard, which escalates to the force-remove
// dialogue instead) with six pinned downpipes, the replication-wait clause, the unreplicable-runs clause
// and the older-runs-outside-history clause all present. The old 600-character cap would have cut it well
// before its closing sentence.
const LONG_IN_USE_REFUSAL =
  "destination is in use by 6 downpipe(s): Ledger, Mail, Nightly, Archive, Backups, …. Keep it on them for now: it holds 12 backed-up run(s) that no other destination holds yet (src-d1, src-r2). Replication copies 10 of them to the other destinations of their downpipes at each 15-minute tick, oldest first within each downpipe. This can take hours. It stops copying for a downpipe left with one destination. 2 of them belong to downpipes with fewer than two destinations, which replication does not copy, so waiting does not clear them. Give each of those downpipes this destination and one other, and wait for replication to copy the runs. This can take hours too. When a removal no longer reports runs held only here, take this destination off those downpipes and remove it. 4 older run(s) of the downpipes that sealed runs here are no longer in the run history, which keeps the newest 50 runs of each downpipe. Replication does not copy those, so downpipes cannot restore any of them held only here once this destination is removed, with or without force.";

// answerModal waits for the next confirmModal to render under the shim and clicks the button with the
// given label, the same helper validate-destinations.ts uses for the real confirmModal / dialog.
async function answerModal(label: string): Promise<void> {
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  if (!surface) return;
  const btn = findButtonByText(surface, label);
  if (btn) click(btn);
  await flushAsync();
}

function lastToast(): { text: string; tone: string } | null {
  const toasts = qsa(SN(document.body) as unknown as ShimNode, ".toast");
  const el = toasts[toasts.length - 1];
  if (!el) return null;
  const classes = classesOf(el);
  const tone = classes.includes("toast--warn") ? "warn" : classes.includes("toast--info") ? "info" : "success";
  const msgNode = qs(el, ".toast__msg");
  return { text: msgNode ? textOf(msgNode) : "", tone };
}

// lastToastOfTone reads the most recent toast OF A GIVEN TONE, rather than the most recent element in
// document order. Success/info and warn toasts render into two SEPARATE live regions (toast.ts, polite
// vs assertive), each created once and never reordered, so a later region's toast can sort before an
// earlier region's in a plain document-order query. The success cases below fire a warn toast and then a
// plain one in the same run (no auto-dismiss here: the shim's setTimeout is real, so nothing expires
// within a flush), so this file needs the tone-scoped read; the single-scenario read above never mixed
// tones in one run and did not need it.
function lastToastOfTone(tone: "success" | "info" | "warn"): { text: string } | null {
  const toasts = qsa(SN(document.body) as unknown as ShimNode, `.toast--${tone}`);
  const el = toasts[toasts.length - 1];
  if (!el) return null;
  const msgNode = qs(el, ".toast__msg");
  return { text: msgNode ? textOf(msgNode) : "" };
}

// checkSingularClearConfirmText drives the REAL removeDestination confirm dialogue for a
// DestinationStatus with no id (present: false, the env-configured-only card: GET /destination
// carries neither id nor isDefault for it, engine src/sched/scheduler-do-dest-config.ts
// getDestStatus). st.id === undefined routes the eventual call to engine.setDestination(null,
// ...) -- the singular clear (POST /admin/destination {"config": null}) -- which engine
// setDestConfig runs through removalScan's in-use (pinned) check only; it never runs the orphan
// guard (uncoveredOriginRunCount / atRisk), so the confirm text must never claim this destination
// "holds the only proven copy of a run" (that phrase is destOrphanRefusal's, engine
// dest-removal-text.ts, and only removeDest -- the id-bearing plural remove -- reaches it).
async function checkSingularClearConfirmText(): Promise<void> {
  const st: DestinationStatus = { present: false, source: "deploy" };
  const engine = {} as unknown as EngineClient;
  removeDestination(engine, st, 0, () => undefined);
  await flushAsync();
  const surface = qs(SN(document.body) as unknown as ShimNode, ".dialog--modal");
  const full = surface ? textOf(surface) : "";
  ok("the singular-clear confirm dialogue opened", surface !== null);
  ok('it does NOT claim the orphan guard\'s "only proven copy" phrase', !full.toLowerCase().includes("only proven copy"));
  ok("it states the in-use guard instead", full.includes("The engine refuses the removal while a downpipe still writes to this destination."));
  const cancelBtn = surface ? findButtonByText(surface, "Cancel") : null;
  if (cancelBtn) click(cancelBtn);
  await flushAsync();
}

async function main(): Promise<void> {
  await checkSingularClearConfirmText();

  const st: DestinationStatus = { present: true, id: "d1", label: "Primary", isDefault: false };
  const err = await engineRemoveError();

  // POSITIVE CONTROL on the fixture: the wrapper is really there to strip.
  ok(
    "the fixture really carries the wrapped envelope",
    err.message.startsWith("remove destination: ") && err.message.includes(REASON) && err.message.endsWith(": 400"),
  );

  const engine = {
    async getConfigApprovalPolicy(): Promise<ConfigApprovalPolicy> {
      // Require Change Number OFF: requireChange() is a no-op and removeDestination proceeds straight
      // from the Remove confirm to the engine call.
      return { requireChangeNumber: false } as ConfigApprovalPolicy;
    },
    async removeDestination(): Promise<OwnerActionResult<DestinationList>> {
      throw err;
    },
  } as unknown as EngineClient;

  // count=2: not the last destination, so the confirm body reads the ordinary (non-last-copy) sentence
  // and the click target below is the plain "Remove" confirm.
  removeDestination(engine, st, 2, () => undefined);
  await answerModal("Remove");
  // requireChange resolves on the next microtask turn (policy off, no modal), then the engine call
  // rejects and the catch renders the toast; flush twice to settle both.
  await flushAsync();
  await flushAsync();

  const t = lastToast();
  ok("a toast was shown", t !== null);
  const text = t?.text ?? "";
  ok("the toast carries the engine's own sentence", text.includes(REASON));
  ok('the toast names the downpipes to reassign ("Ledger, Mail")', text.includes("Ledger, Mail"));
  ok('the toast does NOT carry the transport verb ("remove destination:")', !text.includes("remove destination:"));
  ok('the toast does NOT carry the trailing status (": 400")', !text.includes(": 400"));
  ok("the toast uses the warn tone", t?.tone === "warn");

  // THE WHOLE REFUSAL, UNCUT. A destination-removal refusal can run to four figures (six pinned
  // downpipes, plus the replication-wait, unreplicable-runs and older-runs-outside-history clauses
  // together); the plain toast must carry all of it, not a 600-character head with an ellipsis.
  ok("LONG_IN_USE_REFUSAL is really the 1,056-character variant", LONG_IN_USE_REFUSAL.length === 1056);
  ok("...and it never uses the orphan guard's phrase (it stays on the plain toast path)", !LONG_IN_USE_REFUSAL.toLowerCase().includes("only proven copy"));

  const st3: DestinationStatus = { present: true, id: "d3", label: "Primary", isDefault: false };
  const longErr = await engineRemoveErrorFor(LONG_IN_USE_REFUSAL);
  const longEngine = {
    async getConfigApprovalPolicy(): Promise<ConfigApprovalPolicy> {
      return { requireChangeNumber: false } as ConfigApprovalPolicy;
    },
    async removeDestination(): Promise<OwnerActionResult<DestinationList>> {
      throw longErr;
    },
  } as unknown as EngineClient;
  removeDestination(longEngine, st3, 2, () => undefined);
  await answerModal("Remove");
  await flushAsync();
  await flushAsync();
  const longToast = lastToast();
  ok("a toast was shown for the long refusal", longToast !== null);
  const longText = longToast?.text ?? "";
  ok("the toast's text contains the whole 1,056-character refusal, with no ellipsis cut", longText.includes(LONG_IN_USE_REFUSAL));
  ok("the toast still ends on the engine's own closing sentence", longText.endsWith("with or without force."));
  ok("the toast uses the warn tone", longToast?.tone === "warn");

  // A SUCCESSFUL removal: engine 0.3.7 rides an optional `notice` on the response, the sentence naming
  // what the removal cost (present only when a force dropped runs, or older runs the run history no
  // longer holds). This drives the two success shapes through the same real removeDestination handler.
  async function runSuccessCase(label: string, notice: string | undefined, expectText: string, expectTone: "success" | "warn"): Promise<void> {
    const st2: DestinationStatus = { present: true, id: "d2", label: "Primary", isDefault: false };
    const successEngine = {
      async getConfigApprovalPolicy(): Promise<ConfigApprovalPolicy> {
        return { requireChangeNumber: false } as ConfigApprovalPolicy;
      },
      async removeDestination(): Promise<OwnerActionResult<DestinationList>> {
        return { status: "result", value: { destinations: [], defaultId: null, ...(notice !== undefined ? { notice } : {}) } };
      },
    } as unknown as EngineClient;
    let reloaded = 0;
    removeDestination(successEngine, st2, 2, () => {
      reloaded++;
    });
    await answerModal("Remove");
    await flushAsync();
    const success = lastToastOfTone(expectTone);
    ok(`${label}: a toast was shown`, success !== null);
    ok(`${label}: the toast text is "${expectText}"`, (success?.text ?? "") === expectText);
    ok(`${label}: reload ran`, reloaded === 1);
  }

  await runSuccessCase(
    "a force notice",
    "Destination removed with force. Downpipes cannot restore the 6 backed-up run(s) that were only here.",
    "Destination removed with force. Downpipes cannot restore the 6 backed-up run(s) that were only here.",
    "warn",
  );
  await runSuccessCase("no notice", undefined, "Destination removed.", "success");

  console.log(`\n${failures === 0 ? "0 failures" : `${failures} FAILURE(S)`}`);
  console.log(failures === 0 ? "VALIDATE-DESTINATION-REFUSAL-TOAST VECTORS PASS" : `${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exit(1);
}

void main();
