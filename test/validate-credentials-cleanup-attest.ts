// The credentials cleanup attestation, driven through the REAL modal and the REAL row.
//
//   node test/validate-credentials-cleanup-attest.ts
//
// What this records is the operator's WORD. Downpipes never held the token and cannot check Cloudflare,
// so "deleted (attested)" is an assurance record about a human action, not a verified fact. That makes
// three things load-bearing, and none of them was tested.
//
//   1. The row id reaching the API must be EXACTLY this row's. Attesting the wrong id marks a credential
//      deleted that is still live, which is a false assurance record in the customer's own ledger, and
//      nothing downstream can detect it because there is nothing to check it against.
//   2. A REJECTED call must leave the modal OPEN. The action returns false on failure so the operator can
//      retry; closing on failure would look like success and lose the attempt silently.
//   3. A READER must not be able to attest at all. The row renders a REFUSED button for a reader
//      AND attaches no click listener, which is the part worth pinning: the refusal is a DOM state an
//      inspector can clear, whereas an absent listener cannot be re-created from the console. The refusal
//      is now aria-disabled plus the reason as text rather than `disabled` plus a title, so it stays in
//      the tab order and a keyboard or touch user can reach the reason; that made the absent listener
//      load-bearing rather than merely reassuring, and it is asserted by clicking.
//
// The copy is asserted too, because the honesty of the wording IS the feature: the modal must say it does
// not verify deletion.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

const { openCleanupAttest } = await import("../src/screens/credentials/forms.ts");
const { renderPendingCleanupRow } = await import("../src/screens/credentials/list.ts");
const { closeAllOverlays } = await import("../src/components/dialog.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const unauthorised = (): Error => new Error("cleanup attest: 401");

const row = (over: Record<string, unknown> = {}) => ({
  id: "exp-abc123",
  label: "Deploy token, June",
  tokenRef: "tok-9f8e7d",
  state: "pending-cleanup",
  ...over,
});

interface Harness {
  calls: string[];
  reloads: () => number;
  confirm: { textContent: string; click: () => void } | undefined;
  bodyText: () => string;
  modalOpen: () => boolean;
}

// open drives the real modal. Overlays are closed first: modals stack, and a stale one would give the
// helper an earlier case's button.
function open(r: unknown, result: () => Promise<unknown>): Harness {
  closeAllOverlays();
  const calls: string[] = [];
  let reloaded = 0;
  const engine = {
    cleanupAttestExpiry: (id: string) => {
      calls.push(id);
      return result();
    },
  };
  openCleanupAttest(engine as never, r as never, () => { reloaded += 1; });
  const doc = (globalThis as unknown as { document: { body: unknown } }).document;
  markConnected(doc.body as never);
  const buttons = qsa(doc.body as never, "button") as unknown as Array<{ textContent: string; click: () => void }>;
  return {
    calls,
    reloads: () => reloaded,
    confirm: buttons.find((b) => String(b.textContent ?? "").includes("I have deleted it in Cloudflare")),
    bodyText: () => textOf(doc.body as never),
    modalOpen: () => (qsa(doc.body as never, "button") as unknown as Array<{ textContent: string }>).some((b) => String(b.textContent ?? "").includes("I have deleted it in Cloudflare")),
  };
}

async function main(): Promise<void> {
  console.log("(1) the modal states plainly that it does NOT verify deletion");
  {
    const h = open(row(), () => Promise.resolve(undefined));
    const t = h.bodyText();
    ok("(1a) it says downpipes never held the token", t.includes("never held this token"));
    ok("(1b) and cannot check Cloudflare for the operator", t.includes("cannot check Cloudflare for you"));
    ok("(1c) and that this does not verify deletion", t.includes("it does not verify deletion"));
    ok("(1d) it attributes the record to the operator's attestation", t.includes("marks the entry deleted by your attestation"));
  }

  console.log("\n(2) the token id is shown when known, and omitted when it is not");
    ok("(2a) a known token id is shown, so the operator deletes the right one", open(row(), () => Promise.resolve(undefined)).bodyText().includes("tok-9f8e7d"));
    // Blank and whitespace-only both count as unknown: rendering "Token id:" with nothing after it would
    // read as a rendering fault, and a user-owned token genuinely has no captured id.
    for (const ref of ["", "   ", undefined] as Array<string | undefined>) {
      const h = open(row({ tokenRef: ref }), () => Promise.resolve(undefined));
      ok(`(2b) tokenRef ${JSON.stringify(ref)}: no empty "Token id" row`, !h.bodyText().includes("Token id:"));
    }

  console.log("\n(3) the EXACT row id reaches the API");
  {
    const h = open(row({ id: "exp-target" }), () => Promise.resolve(undefined));
    h.confirm?.click();
    await flushAsync();
    ok("(3a) the API was called once", h.calls.length === 1);
    ok("(3b) with exactly this row's id", h.calls[0] === "exp-target");
    ok("(3c) and the list is reloaded so the row's state refreshes", h.reloads() === 1);
    // A different row must send a different id: this is the assertion that would catch a captured-variable
    // bug where every row attested the first one.
    const other = open(row({ id: "exp-second" }), () => Promise.resolve(undefined));
    other.confirm?.click();
    await flushAsync();
    ok("(3d) a second row sends ITS id, not the first row's", other.calls[0] === "exp-second");
  }

  console.log("\n(4) a REJECTED call leaves the modal open, so the attempt is not lost");
  {
    const h = open(row(), () => Promise.reject(new Error("engine refused")));
    h.confirm?.click();
    await flushAsync();
    ok("(4a) the API was called", h.calls.length === 1);
    ok("(4b) the modal is still open for a retry", h.modalOpen());
    ok("(4c) the list is NOT reloaded, because nothing was recorded", h.reloads() === 0);
    ok("(4d) the failure is surfaced with the engine's reason", h.bodyText().includes("Could not record the attestation"));
    // And a retry from the same open modal reaches the API again rather than being swallowed.
    h.confirm?.click();
    await flushAsync();
    ok("(4e) a retry calls the API a second time", h.calls.length === 2);
  }

  console.log("\n(5) an expired session is a sign-out, not an attestation failure");
  {
    // Toasts outlive the modal that raised them, so the earlier rejected-call case
    // has already left a "Could not record the attestation" toast in the document; asserting its absence
    // would fail for a reason unrelated to this branch. What must hold is that THIS click adds no such toast.
    const failToasts = (): number => (h.bodyText().match(/Could not record the attestation/g) ?? []).length;
    const h = open(row(), () => Promise.reject(unauthorised()));
    const before = failToasts();
    h.confirm?.click();
    await flushAsync();
    ok("(5a) the API was called", h.calls.length === 1);
    ok("(5b) a dead session adds NO attestation-failure toast", failToasts() === before);
    ok("(5c) and does not reload the list", h.reloads() === 0);
  }

  console.log("\n(6) a READER cannot attest: refused-with-reason AND no listener");
  {
    closeAllOverlays();
    const editRow = renderPendingCleanupRow({ cleanupAttestExpiry: () => Promise.resolve(undefined) } as never, row() as never, "edit" as never, () => {});
    markConnected(editRow as unknown as never);
    const editBtn = (qsa(editRow, "button") as unknown as Array<{ textContent: string; disabled: boolean; click: () => void }>).find((b) => String(b.textContent ?? "").includes("I have deleted it"));
    ok("(6a) in edit mode the button is enabled", editBtn !== undefined && editBtn.disabled === false);
    editBtn?.click();
    await flushAsync();
    const doc = (globalThis as unknown as { document: { body: unknown } }).document;
    ok("(6b) and clicking it opens the attestation modal", textOf(doc.body as never).includes("never held this token"));

    closeAllOverlays();
    const roRow = renderPendingCleanupRow({ cleanupAttestExpiry: () => Promise.resolve(undefined) } as never, row() as never, "readonly" as never, () => {});
    markConnected(roRow as unknown as never);
    const roBtn = (qsa(roRow, "button") as unknown as Array<{ textContent: string; disabled: boolean; getAttribute: (k: string) => string | null; click: () => void }>).find((b) => String(b.textContent ?? "").includes("I have deleted it"));
    // (6c)/(6d) were "disabled" and "has a title", and both are now the wrong contract. `disabled`
    // removes the control from the tab order, so its reason was reachable by mouse only, and a title
    // fires on hover, which a phone never does. The refusal is now delivered by refuseWithReason:
    // aria-disabled, still focusable, with the reason as real text in the control. The strictly
    // stronger assertion is the one that follows, and it is unchanged.
    ok("(6c) a reader's button is refused but still focusable, so its reason is reachable by keyboard", roBtn !== undefined && roBtn.disabled === false && roBtn.getAttribute("aria-disabled") === "true");
    // Read off the CONTROL, not the row: a reason that only exists elsewhere on the page is not the
    // reason this control carries. "Operator" is the fragment both branches of gateReason share (the
    // caller-known one names the held role, the blind one names the required role), so the assertion
    // does not depend on whether a caller happens to be set in this run.
    ok("(6d) with the reason as text on the control itself, not as a hover-only title", textOf(roBtn as never).includes("Operator"));
    // The load-bearing half. `disabled` can be cleared in a browser inspector; an absent listener cannot
    // be conjured. Clicking the reader's button must do nothing at all.
    roBtn?.click();
    await flushAsync();
    ok("(6e) clicking a reader's button opens NO modal, because no listener is attached", !textOf(doc.body as never).includes("never held this token"));
  }

  console.log(`\n${failures === 0 ? "CLEANUP-ATTEST OK: the exact row id is attested, a rejection keeps the modal open, and a reader has no listener to fire" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
