// The one-time RECOVERY-CODES panel: the unmissable surface where the engine's break-glass codes are
// shown ONCE and only once. The engine issues 10 single-use recovery codes on a successful passkey
// enrolment (PasskeyFinish.recoveryCodes) and on regenerate (RecoveryCodesResult.recoveryCodes); each is
// the offline "I lost my authenticator" fallback that signs you in without a passkey. The engine NEVER
// returns them again, so this panel makes the save-or-lose stakes obvious: clear "save these offline, you
// will not see them again" framing, a Copy and a Download (.txt) action, and an EXPLICIT "I have saved my
// recovery codes" confirmation the operator must tick before the panel can be dismissed.
//
// NO-CUSTODY: the codes are the engine's own one-time strings; this panel only displays them and offers
// them as a local download. They are set via textContent (the code-block path), never parsed as markup,
// and nothing is uploaded. The download is a local blob the caller wires (downloadText), no network.
//
// STRICT CSP: built entirely with the h() builder + the shared codeBlock/copyButton primitives. There is
// NO innerHTML over these strings, NO inline <style> attribute (styling is via h()'s CSSOM style handling),
// and NO inline event-handler attribute (every action is a real addEventListener from this bundled code).
//
// The PURE pieces (the .txt file body, and the confirm-gating decision) are exported and exercised directly
// by test/validate-recovery-ui.ts without a DOM, since the panel itself composes them with the builder.

import { recordCeremonyStep } from "../lib/client-diag/ring.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { copyToClipboard } from "../lib/file-delivery.ts";
import { codeBlock } from "./code-block.ts";
import { ICON_LOCK, ICON_ALERT, ICON_COPY, ICON_CHECK } from "../lib/icons.ts";

// Per-instance id seq so two panels mounted at once never collide on the heading or checkbox ids
// (which would break the section aria-labelledby and the label/checkbox pairing). Mirrors stat-tiles.ts.
let panelSeq = 0;

// hasUsableRecoveryCodes is the ONE predicate for "this response is actually a set of codes we can show",
// shared by the panel (which must never throw on a malformed input) and every caller that mints a
// RecoveryCodesResult (which must decide whether to open this panel at all). A response with no
// `recoveryCodes` field would otherwise leave `result.recoveryCodes` as `undefined`, and recoveryCodesText's
// own `.map` would throw straight through the click handler. A malformed response is not
// specific to the demo: any engine on any deploy could answer with a stale or truncated shape, so the
// check lives here (PURE, no DOM) rather than only at the one call site that happened to be reported.
export function hasUsableRecoveryCodes(codes: unknown): codes is string[] {
  return Array.isArray(codes) && codes.length > 0 && codes.every((c) => typeof c === "string" && c.length > 0);
}

// recoveryCodesText is the body of the downloadable / copyable .txt artefact: a short header that states
// what the codes are and the save-or-lose rule, then each code on its own line, then a footer note. It is
// PURE (string in, string out) so the validator can assert the codes appear verbatim and the framing is
// present without a DOM. The lines join with "\n"; the caller's downloadText writes it as text/plain.
// No secret beyond the codes the engine just minted is in here. Defensive against a non-array input (see
// hasUsableRecoveryCodes): a malformed `codes` degrades to the empty list rather than throwing on `.map`,
// so this pure helper can never be the thing that crashes a caller that skipped the usability check.
export function recoveryCodesText(codes: ReadonlyArray<string>): string {
  const safeCodes = Array.isArray(codes) ? codes : [];
  const header = [
    "Downpipes recovery codes",
    "",
    "These are single-use break-glass codes for signing in to your engine if you lose your passkey.",
    "Save them offline now: they are shown only once and cannot be retrieved again.",
    "Each code works once. Keep them somewhere safe and separate from this device.",
    "",
    "Codes:",
  ];
  const footer = [
    "",
    "To use one: on the sign-in screen choose \"Use a recovery code\", enter your email and one code.",
    "After signing in with a code, set up a fresh passkey straight away.",
    "Generating a new set of codes invalidates every code above.",
  ];
  return [...header, ...safeCodes.map((c) => `  ${c}`), ...footer].join("\n");
}

// RECOVERY_CODES_FILENAME is the fixed download name for the artefact (kept here so the panel and any test
// reference one constant). A plain, recognisable .txt name.
export const RECOVERY_CODES_FILENAME = "downpipes-recovery-codes.txt";

export interface RecoveryCodesPanelOptions {
  // The one-time codes to show (the engine's freshly minted set).
  codes: string[];
  // "enrol" frames the panel as part of finishing passkey setup; "regenerate" frames it as a deliberate
  // re-issue that has just invalidated the previous set. The copy differs only in the lead line.
  context: "enrol" | "regenerate";
  // The host's local blob-download helper (no network), passed in so this component does not duplicate the
  // URL.createObjectURL idiom and stays DOM/encoder-only. Called with the .txt filename + the file body.
  // It returns whether the BROWSER ACCEPTED the delivery (G077): a refused or impossible download used to be
  // a silent no-op on the one artefact the operator cannot ever get back, so the panel now needs the answer.
  downloadText: (name: string, content: string) => boolean;
  // Fired once the operator ticks "I have saved my recovery codes" and confirms. The caller dismisses the
  // panel / proceeds (e.g. continues the post-enrolment boot, or closes the modal). Never fired until the
  // save-confirm is ticked, so it is impossible to move on without acknowledging the save.
  onConfirm: () => void;
}

// buildCodeBlock renders the monospace code block (textContent, literal). codeBlock carries a
// per-block copy of its OWN content (the visible newline-joined list); the explicit Copy-all
// and Download in the action row act on the full .txt body so a copied set carries the framing.
function buildCodeBlock(codes: ReadonlyArray<string>): HTMLElement {
  return codeBlock(codes.join("\n"), { copyLabel: "Copy recovery codes" });
}

// buildActionRow renders the Copy-all and Download .txt controls. Copy and Download both act on
// the full .txt artefact (codes + framing), the same text the download writes. The Copy control
// is a SINGLE real button (the previous version nested an icon-only button inside a span styled
// as a button, so a click on the visible "Copy" label hit the span, not the button).
//
// G077: BOTH controls now REPORT A REFUSAL, to the operator and to the pack. A browser that declines the
// clipboard write or the download used to leave the operator looking at a panel that had not changed, on the
// one artefact that is shown once and never again, and support with no trace of it afterwards. Copy goes
// through the guarded copyToClipboard primitive (which records the refusal in the ring); Download reports
// what the host's guarded delivery told it. The refusal line names the way out that still works: the codes
// are on screen, so they can be written down.
function buildActionRow(codesText: string, downloadText: (name: string, content: string) => boolean): HTMLElement {
  const actions = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  const refusal = h("p", { class: "field__hint", role: "alert", hidden: "" }) as HTMLParagraphElement;
  const sayRefused = (what: string): void => {
    refusal.replaceChildren(h("b", `This browser refused the ${what}.`), " ", h("span", "Your codes are still on screen above. Copy them by hand, or use another browser, before you continue."));
    refusal.hidden = false;
  };
  const copyBtn = h(
    "button",
    { "data-dp": "components-recovery-codes-panel.button.copy", class: "btn btn--secondary btn--sm recovery-codes-panel__copy", type: "button", "aria-label": "Copy recovery codes" },
    svgIcon(ICON_COPY, { size: 14 }),
    h("span", "Copy"),
  ) as HTMLButtonElement;
  copyBtn.addEventListener("click", async () => {
    if (!(await copyToClipboard(codesText, "recovery-codes"))) {
      // G328: the copy was REFUSED on the one artefact that is shown once and never again. The capability-fault row
      // (G077) already says the browser declined the clipboard; this says WHICH ENROLMENT STEP the customer lost by
      // it, which no capability row can, and it is the row that answers "the recovery codes were never saved".
      recordCeremonyStep("recovery-codes-copy", false, "clipboard-denied");
      copyBtn.replaceChildren(h("span", "Copy refused"));
      sayRefused("copy");
      return;
    }
    // The succeeded ending. Without it the ticket is unanswerable in the direction that matters: a customer who
    // never pressed Copy at all and one whose Copy silently failed both leave NO row, and only one of them was let
    // down by the console.
    recordCeremonyStep("recovery-codes-copy", true);
    refusal.hidden = true;
    copyBtn.replaceChildren(svgIcon(ICON_CHECK, { size: 14 }), h("span", "Copied"));
    window.setTimeout(() => copyBtn.replaceChildren(svgIcon(ICON_COPY, { size: 14 }), h("span", "Copy")), 1400);
  });
  const downloadBtn = h(
    "button",
    { "data-dp": "components-recovery-codes-panel.button.download", class: "btn btn--secondary btn--sm", type: "button", "aria-label": "Download recovery codes as a text file" },
    "Download .txt",
  ) as HTMLButtonElement;
  downloadBtn.addEventListener("click", () => {
    if (downloadText(RECOVERY_CODES_FILENAME, codesText)) {
      refusal.hidden = true;
      return;
    }
    sayRefused("download");
  });
  actions.appendChild(copyBtn);
  actions.appendChild(downloadBtn);
  const wrap = h("div", { style: "display:grid;gap:var(--space-2)" }, actions, refusal);
  return wrap;
}

// buildSaveConfirmGate renders the explicit save-confirm gate: a checkbox + label, then a
// Continue button that stays disabled until the box is ticked. This is what makes the codes
// impossible to dismiss unacknowledged; onConfirm fires only once the box is ticked.
function buildSaveConfirmGate(onConfirm: () => void, checkboxId: string): HTMLElement {
  const confirmBtn = h(
    "button",
    { "data-dp": "components-recovery-codes-panel.button.confirm", class: "btn btn--primary btn--sm recovery-codes-panel__confirm", type: "button", disabled: true },
    "Continue",
  ) as HTMLButtonElement;

  const checkbox = h("input", { type: "checkbox", id: checkboxId, class: "recovery-codes-panel__saved-check" }) as HTMLInputElement;
  checkbox.addEventListener("change", () => {
    confirmBtn.disabled = !checkbox.checked;
  });
  const confirmRow = h(
    "div",
    { style: "display:grid;gap:var(--space-3);border-top:1px solid var(--border);padding-top:var(--space-3)" },
    h(
      "label",
      { for: checkboxId, style: "display:flex;gap:var(--space-2);align-items:flex-start;cursor:pointer" },
      checkbox,
      h(
        "span",
        { style: "display:grid;gap:var(--space-1)" },
        h("span", { style: "color:var(--text)" }, "I have saved my recovery codes"),
        h("span", { class: "field__hint", style: "display:flex;gap:var(--space-2);align-items:flex-start" }, h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_ALERT, { size: 14 })), h("span", "Tick this only after copying or downloading them. You cannot get back to this panel.")),
      ),
    ),
  );

  confirmBtn.addEventListener("click", () => {
    if (!checkbox.checked) return; // belt and braces: the disabled state already prevents this
    onConfirm();
  });
  confirmRow.appendChild(h("div", confirmBtn));
  return confirmRow;
}

// buildDegradedPanel is the HONEST fallback for a `codes` value that fails hasUsableRecoveryCodes: 
// fix for "the panel should not throw on an unexpected response from any source". It states plainly that
// the codes could not be shown (never a blank screen, never a generic engine-error toast the operator
// cannot act on), is explicit that nothing here confirms whether a save-worthy set exists, and gives the
// one thing the operator can actually do next: try again. The single "Close" action calls onConfirm so the
// caller's existing dismiss/reload plumbing still runs; a caller for whom onConfirm means "codes were
// saved, tell the operator so" (this file's only two callers do not: access.ts validates BEFORE opening
// this panel via hasUsableRecoveryCodes, and passkey/flows.ts already guards codes.length > 0 before ever
// calling showRecoveryCodes) would need its own guard too. That is the generalisation this fix buys: every
// FUTURE caller is protected at the panel boundary even if it forgets to check first.
function buildDegradedPanel(context: RecoveryCodesPanelOptions["context"], onConfirm: () => void, headingId: string): HTMLElement {
  const panel = h("section", {
    class: "card card--warn recovery-codes-panel",
    "aria-labelledby": headingId,
    style: "display:grid;gap:var(--space-4)",
  });
  const header = h("div", { style: "display:flex;gap:var(--space-2);align-items:center" });
  header.appendChild(h("span", { style: "color:var(--warn)", "aria-hidden": "true" }, svgIcon(ICON_ALERT, { size: 20 })));
  header.appendChild(h("h2", { id: headingId, class: "card__title", style: "margin:0;font-size:var(--text-lg)" }, "Your recovery codes could not be shown"));
  panel.appendChild(header);

  const contextLine = context === "regenerate"
    ? "You asked to regenerate your recovery codes, but the response did not include a usable set."
    : "Your passkey is set up, but the response did not include a usable set of recovery codes.";
  panel.appendChild(
    h(
      "p",
      { style: "color:var(--text);margin:0" },
      h("span", { class: "field__hint" }, `${contextLine} This is not a confirmation that your codes changed either way: check "Recovery codes remaining" once this closes, and try again if you need a working set.`),
    ),
  );

  const closeBtn = h(
    "button",
    { "data-dp": "components-recovery-codes-panel.button.close", class: "btn btn--primary btn--sm", type: "button" },
    "Close",
  ) as HTMLButtonElement;
  closeBtn.addEventListener("click", () => onConfirm());
  panel.appendChild(h("div", { style: "border-top:1px solid var(--border);padding-top:var(--space-3)" }, closeBtn));
  return panel;
}

// recoveryCodesPanel builds the one-time panel node. The confirm button is DISABLED until the
// "I have saved my recovery codes" checkbox is ticked (the save-confirm gate), so the codes cannot be
// dismissed unacknowledged. Copy copies the whole set; Download saves the .txt. Returns the panel element
// for the caller to mount (inline or inside a modal body).
//
// `opts.codes` crosses a JSON wire boundary (an engine response, real or faked), so its runtime shape
// is never guaranteed by the TypeScript type alone. A missing or malformed set used to reach recoveryCodesText's
// `codes.map` and throw past the click handler that opened this panel -- on the public, no-login tour, that
// was `console/src/screens/security-centre/access.ts`'s Regenerate button reaching the demo world's unmodelled
// /admin/auth/* fallback. hasUsableRecoveryCodes is the ONE check (shared with the callers that can pre-empt
// this) that decides whether there is anything safe to render; a "no" degrades honestly instead of throwing.
export function recoveryCodesPanel(opts: RecoveryCodesPanelOptions): HTMLElement {
  const instance = ++panelSeq;
  const headingId = `recovery-codes-h-${instance}`;
  const checkboxId = `recovery-codes-saved-${instance}`;
  if (!hasUsableRecoveryCodes(opts.codes)) return buildDegradedPanel(opts.context, opts.onConfirm, headingId);
  const panel = h("section", {
    class: "card card--warn recovery-codes-panel",
    "aria-labelledby": headingId,
    style: "display:grid;gap:var(--space-4)",
  });

  // Header: a lock glyph + the unmissable heading.
  const header = h("div", { style: "display:flex;gap:var(--space-2);align-items:center" });
  header.appendChild(h("span", { style: "color:var(--trust);flex:none", "aria-hidden": "true" }, svgIcon(ICON_LOCK, { size: 20 })));
  header.appendChild(h("h2", { id: headingId, class: "card__title", style: "margin:0;font-size:var(--text-lg)" }, "Save your recovery codes"));
  panel.appendChild(header);

  // The save-or-lose framing, stated plainly. The lead line differs by context.
  const lead = opts.context === "regenerate"
    ? "These are your new recovery codes. Your previous codes have stopped working."
    : "Your passkey is set up. These recovery codes are your break-glass if you ever lose your passkey.";
  panel.appendChild(
    h(
      "p",
      { style: "color:var(--text);margin:0" },
      h("b", "Save these offline now. You will not see them again."),
      " ",
      h("span", { class: "field__hint" }, `${lead} Each code works once; store them somewhere safe and separate from this device. They cannot be shown again.`),
    ),
  );

  // The codes themselves, then the Copy-all / Download row, then the save-confirm gate.
  const codesText = recoveryCodesText(opts.codes);
  panel.appendChild(buildCodeBlock(opts.codes));
  panel.appendChild(buildActionRow(codesText, opts.downloadText));
  panel.appendChild(buildSaveConfirmGate(opts.onConfirm, checkboxId));

  return panel;
}
