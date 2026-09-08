// The one-shot-token detach on the Sources screen, driven through the REAL
// promptTokenAndDetach.
//
//   node test/validate-source-detach.ts
//
// This is the console's only path that REMOVES a source binding from the engine, so the wire call it
// makes is the whole risk: detaching the wrong binding stops a real downpipe's backups, and the
// operator's next signal is a failed run rather than an error on screen. The attach direction is
// already covered (validate-token-source.ts drives add-source with a stubbed changeBindings); this
// direction was not covered anywhere.
//
// Three things are pinned hardest:
//
//   1. The call is EXACTLY (token, [], names). An empty add list and the precise names, in order. A
//      detach that also carried an add would attach something nobody asked for, and a names list that
//      drifted would detach a binding the operator did not tick.
//   2. The token is sent once and CLEARED, never retained in the field for a second call.
//   3. The QUEUED fork. When change control defers the detach for approval, the screen must say
//      "queued", not report a detach that has not happened. Telling an operator a source is detached
//      when it is still attached and awaiting an approver is a lie in the safe direction on the
//      surface and a wrong belief about their estate underneath.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

const { promptTokenAndDetach } = await import("../src/screens/sources/tiers.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

interface Call {
  token: string;
  add: unknown[];
  remove: string[];
}

// A 401-shaped error: classifyError reads the status off the MESSAGE, not off a property, so this is
// the shape isUnauthorised keys on.
function unauthorised(): Error {
  return new Error("change bindings: 401");
}

// open drives the modal and returns handles onto its live controls. The token field, the confirm
// button and the inline error are all read back off the document, because that is what an operator
// sees; nothing here inspects the module's internals.
function open(names: string[], result: () => Promise<unknown>): {
  calls: Call[];
  refreshes: () => number;
  token: { value: string };
  detach: { textContent: string; disabled: boolean; click: () => void };
  errorText: () => string;
} {
  // Each case opens its own modal, so any previous one must go first. Without this the helper below
  // searches the whole document and finds the FIRST modal's controls, so a later case clicks an earlier
  // case's button against an unset token field. Three sections failed exactly that way before this line
  // existed, which is worth recording: a stacked-overlay test can fail for reasons that have nothing to
  // do with the code under test.
  closeAllOverlays();
  const calls: Call[] = [];
  let refreshed = 0;
  const engine = {
    changeBindings: (token: string, add: unknown[], remove: string[]) => {
      calls.push({ token, add, remove });
      return result();
    },
  };
  promptTokenAndDetach(engine as never, names, "acct-1", () => { refreshed += 1; });
  const doc = globalThis as unknown as { document: { body: unknown } };
  markConnected(doc.document.body as never);
  const inputs = qsa(doc.document.body as never, "input") as unknown as Array<{ value: string }>;
  const buttons = qsa(doc.document.body as never, "button") as unknown as Array<{ textContent: string; disabled: boolean; click: () => void }>;
  const token = inputs[inputs.length - 1];
  const detach = buttons.find((b) => String(b.textContent ?? "").startsWith("Detach "));
  if (token === undefined || detach === undefined) throw new Error(`modal controls not found (${inputs.length} inputs, ${buttons.length} buttons)`);
  const errorText = (): string => {
    const ps = qsa(doc.document.body as never, "p") as unknown as Array<{ className?: string; textContent: string }>;
    return ps.filter((p) => String(p.className ?? "").includes("field__error")).map((p) => p.textContent).join(" ");
  };
  return { calls, refreshes: () => refreshed, token, detach, errorText };
}

const applied = (detached: string[]) => Promise.resolve({ status: "applied", value: { attached: [], detached } });
const queued = () => Promise.resolve({ status: "queued", changeNumber: "CHG-1" });

async function main(): Promise<void> {
  // Held across cases (1) and (2): case (2b) below discriminates the one-name label against it.
  let labelForTwo = "";
  console.log("(1) the wire call is exactly (token, [], names)");
  {
    const h = open(["KV_a", "KV_b"], () => applied(["KV_a", "KV_b"]));
    labelForTwo = h.detach.textContent; // captured before the click, which relabels the button to its busy text
    h.token.value = "  deploy-token-value  ";
    h.detach.click();
    await flushAsync();
    ok("(1a) changeBindings was called once", h.calls.length === 1);
    ok("(1b) the ADD list is empty: a detach never attaches anything", JSON.stringify(h.calls[0]?.add) === "[]");
    ok("(1c) the remove list is exactly the named bindings, in order", JSON.stringify(h.calls[0]?.remove) === JSON.stringify(["KV_a", "KV_b"]));
    ok("(1d) the token is trimmed before it is sent", h.calls[0]?.token === "deploy-token-value");
    ok("(1e) the token field is cleared, so it cannot be reused", h.token.value === "");
    ok("(1f) the list is refreshed once the engine confirms", h.refreshes() === 1);
  }

  console.log("\n(2) a single name is sent as a single-element list, not flattened");
  {
    const h = open(["KV_only"], () => applied(["KV_only"]));
    const labelForOne = h.detach.textContent; // likewise captured before the click
    h.token.value = "t";
    h.detach.click();
    await flushAsync();
    ok("(2a) remove carries the one name", JSON.stringify(h.calls[0]?.remove) === JSON.stringify(["KV_only"]));
    // The condition here used to be the literal `true`, so a line claiming the button was labelled for one
    // checked nothing at all and could not fail for any reason. tiers.ts:542 builds the confirm control as
    // `Detach ${names.length}`, so the label is read, and read AGAINST the two-name label from case (1): a
    // count that does not move with the selection is exactly what this line was written to catch.
    ok("(2b) the button was labelled for one", labelForOne === "Detach 1");
    ok("(2b) and two names do not produce that label, so the count tracks the selection", labelForTwo === "Detach 2" && labelForOne !== labelForTwo);
  }

  console.log("\n(3) an empty token is refused inline, WITHOUT calling the engine");
    // The important half is the negative: a blank token must not reach the engine at all, because a
    // failed detach attempt still spends the operator's attention and can look like an engine fault.
    for (const blank of ["", "   ", "\t"]) {
      const h = open(["KV_a"], () => applied(["KV_a"]));
      h.token.value = blank;
      h.detach.click();
      await flushAsync();
      ok(`(3) token ${JSON.stringify(blank)}: the engine is not called`, h.calls.length === 0);
      ok(`(3) token ${JSON.stringify(blank)}: an inline error asks for the token`, h.errorText().includes("Paste the deploy token first."));
    }

  console.log("\n(4) the QUEUED fork: change control deferred it, so it is not reported as detached");
  {
    const h = open(["KV_a", "KV_b"], queued);
    // Counted as a DELTA, not as an absence. Toasts from the applied cases above are still in the
    // document (a toast outlives the modal that raised it), so asserting the phrase is absent would fail
    // for a reason that has nothing to do with the queued path. What must hold is that THIS click adds
    // no success toast.
    const successToasts = (): number => (textOf((globalThis as unknown as { document: { body: unknown } }).document.body as never).match(/detached, verified safe/g) ?? []).length;
    const before = successToasts();
    h.token.value = "t";
    h.detach.click();
    await flushAsync();
    ok("(4a) the engine was still called", h.calls.length === 1);
    ok("(4b) the token is cleared on the queued path too", h.token.value === "");
    ok("(4c) the list is refreshed so the pending state shows", h.refreshes() === 1);
    ok("(4d) the queued path raises NO 'detached, verified safe' toast", successToasts() === before);
  }

  console.log("\n(5) an engine refusal is shown inline and the control is re-enabled");
  {
    // The engine refuses a detach it cannot prove safe (it keeps its own bindings). That refusal is the
    // most valuable message this modal can carry, so it must reach the operator verbatim rather than
    // being swallowed, and the button must come back so a corrected attempt is possible.
    const h = open(["KV_a"], () => Promise.reject(new Error("refused: that would remove a binding the engine still needs")));
    h.token.value = "t";
    h.detach.click();
    await flushAsync();
    ok("(5a) the refusal reaches the operator", h.errorText().includes("that would remove a binding the engine still needs"));
    ok("(5b) the button is re-enabled for another attempt", h.detach.disabled === false);
    ok("(5c) the button label is restored", String(h.detach.textContent).startsWith("Detach "));
    ok("(5d) the list is NOT refreshed, because nothing changed", h.refreshes() === 0);
  }

  console.log("\n(6) an expired session goes to the signed-out flow, not to an inline error");
  {
    const h = open(["KV_a"], () => Promise.reject(unauthorised()));
    h.token.value = "t";
    h.detach.click();
    await flushAsync();
    ok("(6a) the engine was called", h.calls.length === 1);
    // A dead session is not a detach problem, so it must not be reported as one in the modal.
    ok("(6b) no inline detach error is shown for a dead session", h.errorText() === "");
    ok("(6c) and the list is not refreshed", h.refreshes() === 0);
  }

  console.log(`\n${failures === 0 ? "SOURCE-DETACH OK: the call is exactly (token, [], names), the token is cleared, and a queued detach is never reported as done" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
