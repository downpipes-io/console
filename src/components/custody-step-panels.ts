// The per-tier panel renderers and the in-browser crypto actions for the custody step,
// extracted from custody-step.ts to keep that file under the structural budget. The logic is
// byte-for-byte the same: the only mechanical change is that the closure state the renderers
// share (scheme, splitN, splitThreshold, signoffs) and the closure callbacks (emitMeta,
// downloadText, the in-memory ceremony result) are now reached through a CustodyPanelContext
// passed in, instead of lexical closure. No control flow or value changes.
//
// NO-CUSTODY, sacred here above all: every key, share, wrapping key and ciphertext is
// produced in this browser. The private key, the wrapping key and the ciphertext are ONLY ever
// offered as a download and are never transmitted.
//
// THE ONE SANCTIONED EXCEPTION: a single custodian SHARE may, only when the operator explicitly
// clicks Email, be POSTed to the operator's OWN engine so the engine can email it to that custodian
// (a browser cannot send email). This is safe because the ciphertext (the envelope over identity.key)
// is NEVER POSTed, so a captured share stays useless, and a single share
// below the reconstruction threshold reveals nothing (Shamir). Download stays the recommended, most
// private route; email is a secondary convenience the host wires in via ctx.sendShare. See the engine
// email.ts boundary note.
//
// House rules: Australian English; no em dashes; CSSOM via node.style / the h() style helper
// (never setAttribute("style")); every server/operator string via textContent or escape;
// status by shape + label, not colour alone; accessible labels on every control.

import { ceremonyFaultFor, recordCeremonyStep, recordFormRefused } from "../lib/client-diag/ring.ts";
import { h, svgIcon } from "../lib/dom.ts";
import { statusWithLabel } from "./status.ts";
import { field, type Field } from "./field.ts";
import { atMostChars, wholeNumberAtLeast, wholeNumberBetween } from "./field-bounds.ts";
import { infoTip } from "./info-tip.ts";
import { toast } from "./toast.ts";
import {
  ICON_LOCK,
  ICON_KEYS,
} from "../lib/icons.ts";
import { b64urlEncode } from "../bytes.ts";
import { encrypt } from "../lib/envelope.ts";
import { combine, split as shamirSplit, verifyWrappingKey, wrappingKeyChecksum } from "../lib/shamir.ts";
import {
  identityPlaintext,
  serialiseEnvelopeFile,
  wrappingKeyFile,
  serialiseShareFile,
  type CustodyKeyInput,
} from "../lib/custody-files.ts";
import {
  validateSplitParams,
  shareLabels,
  splitReadme,
  CIPHERTEXT_FILENAME,
  SPLIT_README_FILENAME,
  MIN_SHARES,
  MAX_SHARES,
  MIN_THRESHOLD,
  type CustodyScheme,
  type CustodianSignoff,
} from "../lib/custody.ts";
import { renderPaperCompanion } from "./custody-paper.ts";
import type { CustodyShareSendInput, CustodyShareSendResult } from "../lib/api/types.ts";
import {
  resizeSignoffs,
  surfaceNote,
  spinnerLine,
  setBtnBusy,
  errMessage,
  todayISO,
} from "./custody-step-helpers.ts";

// SendShareFn is the host-injected sender for the ONE sanctioned network exception: it POSTs a single
// share to the operator's own engine to email a custodian. The host wires it from its EngineClient
// (engine.sendCustodyShare); when the host omits it, the split panel renders download-only (the most
// private route), so the component itself never reaches the network or imports the API client.
export type SendShareFn = (input: CustodyShareSendInput) => Promise<CustodyShareSendResult>;

// The mutable state shared across the panels (the operator's public selections only; no key
// or share value ever lives here).
export interface CustodyPanelState {
  scheme: CustodyScheme;
  splitN: number;
  splitThreshold: number;
  signoffs: CustodianSignoff[];
}

// CustodyPanelContext carries everything the panel renderers reach for. `result` is the
// in-memory key source (the operator's locally-generated break-glass identity bytes, the only
// part of a ceremony the custody flow reads); `downloadText` is the host's local-download
// helper; `emitMeta` notifies the host of public-metadata changes; `renderPanel` re-renders
// the active panel after a scheme change; `panelHost` is where the active panel lives.
export interface CustodyPanelContext {
  state: CustodyPanelState;
  result: CustodyKeyInput;
  downloadText: (name: string, content: string) => boolean;
  emitMeta: () => void;
  // sendShare is the OPTIONAL host-injected sender (the one sanctioned network exception; see the file
  // header). When present, each share in the split output gains an Email action alongside its download;
  // when absent, the split is download-only.
  sendShare?: SendShareFn;
}

export function renderUndecided(): HTMLElement {
  // No recap essay (the per-tier (i) on each card carries the detail). One calm line.
  return surfaceNote(
    "info",
    "Choose a scheme above",
    "Pick the option that fits your team. Whichever you choose can be recorded on the recovery sheet.",
  );
}

// --- Tier 1 / Tier 2 -------------------------------------------------------------
export function renderTier12(ctx: CustodyPanelContext, s: "password-manager" | "encrypted-usb-paper"): HTMLElement {
  const wrap = h("div", { class: "custody-tier" });
  // The tier's longer explanation lives in the menu card's infoTip (o.detail), not as a
  // paragraph here; the panel goes straight to the action.

  // The optional pre-encryption affordance: wrap the key file in-browser before it goes
  // into the vault / onto the USB (defence in depth). This is OPTIONAL on Tier 1/2; the
  // key file may be stored as-is.
  wrap.appendChild(h("h4", { class: "legend-col__title", style: "margin-top:var(--space-4)" }, "Optional: pre-encrypt the key file"));
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      s === "password-manager"
        ? "You can store identity.key as it was downloaded, or encrypt it first for defence in depth (the vault also encrypts). Encrypting it here produces a ciphertext and a separate wrapping key, both generated in this browser."
        : "Store identity.key on the encrypted drive as downloaded, or encrypt it first for defence in depth. Encrypting it here produces a ciphertext and a separate wrapping key, both generated in this browser.",
    ),
  );

  // The encrypt action + its output region.
  const out = h("div", { class: "custody-out", role: "status", "aria-live": "polite" });
  const encryptBtn = h(
    "button",
    { "data-dp": "components-custody-step-panels.button.encrypt", class: "btn btn--secondary", type: "button", style: "margin-top:var(--space-3)" },
    svgIcon(ICON_LOCK, { size: 14 }),
    "Encrypt the key file in this browser",
  ) as HTMLButtonElement;
  encryptBtn.addEventListener("click", () => void doTier12Encrypt(ctx, s, out, encryptBtn));

  // (The optional security-key (YubiKey) layer was removed from the UI: it was permanently
  // gated off behind a confusing "coming soon" note because the per-credential PRF secret makes
  // a single recorded credential unrecoverable by a backup key. The encryption + custody options
  // above protect the key file on their own. The enrol/derive plumbing in webauthn-prf.ts is kept
  // for a possible future multi-wrap design.)
  wrap.appendChild(encryptBtn);
  wrap.appendChild(out);

  // The "I have stored it" sign-off recorder for the recovery sheet (a single holder).
  wrap.appendChild(renderSingleSignoff(ctx));

  return wrap;
}

// doTier12Encrypt wraps the in-memory identity.key bytes with a fresh random wrapping key,
// then offers the ciphertext download and the wrapping key as a separate download to keep
// offline. Everything is local.
async function doTier12Encrypt(
  ctx: CustodyPanelContext,
  s: "password-manager" | "encrypted-usb-paper",
  out: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  setBtnBusy(btn, true, "Encrypting in this browser");
  out.replaceChildren(spinnerLine("Encrypting the key file in this browser. Nothing is being sent."));
  try {
    const plaintext = identityPlaintext(ctx.result);
    const env = await encrypt(plaintext);
    setBtnBusy(btn, false, "Encrypt the key file in this browser");
    // Offer the ciphertext. The IV rides inside the file so it is self-contained for recovery.
    const ciphertextFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
    ctx.downloadText(CIPHERTEXT_FILENAME, ciphertextFile);
    // Offer the random wrapping key as a separate download to keep offline.
    const wkFile = wrappingKeyFile(env.wrappingKey);
    ctx.downloadText("identity.wrapping-key.txt", wkFile);
    // The succeeded ending, recorded for the same reason the failed one is. A ceremony that ran and worked
    // must be distinguishable from one that was never run at all, and the absence of a row is what the two states
    // otherwise share.
    recordCeremonyStep("tier12-encrypt", true);
    const children: Node[] = [
      statusWithLabel("ok", "Encrypted in this browser. Ciphertext downloaded."),
      h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Store ${CIPHERTEXT_FILENAME} in ${s === "password-manager" ? "your password manager" : "the encrypted drive"}. It carries no usable key on its own.`),
      surfaceNote(
        "warn",
        "Keep the wrapping key apart from the ciphertext",
        "The wrapping key was downloaded as identity.wrapping-key.txt. Store it separately from the ciphertext (a different vault entry or a different drive). Anyone with both can decrypt the key file.",
      ),
    ];
    out.replaceChildren(...children);
    // Tier 2 cold storage: offer the printed/QR paper companion for the ciphertext, so
    // the encrypted file survives flash charge loss on paper.
    if (s === "encrypted-usb-paper") {
      out.appendChild(
        renderPaperCompanion({
          payloadB64: b64urlEncode(env.ciphertext),
          payloadLabel: "the encrypted key file",
          downloadText: ctx.downloadText,
        }),
      );
    }
  } catch (err) {
    // The in-browser key-file encryption failed. Without a record, the only trace was this sentence on screen.
    // Support debugged it from screenshots. The coarse fault class is chosen from the thrown value's CONSTRUCTOR
    // NAME and nothing else: the message is rendered to the operator (where they need it) and is never read into
    // the ring, because a WebCrypto message can carry a byte length and a length is a fingerprint of the key.
    recordCeremonyStep("tier12-encrypt", false, ceremonyFaultFor(err));
    setBtnBusy(btn, false, "Encrypt the key file in this browser");
    out.replaceChildren(
      h("p", { class: "field__error" }, `Encryption failed in the browser (${errMessage(err)}). Nothing left this device.`),
    );
  }
}

// renderSingleSignoff records who holds the (single) Tier 1/2 copy, plus the date. This
// is public metadata for the recovery sheet, never a secret.
function renderSingleSignoff(ctx: CustodyPanelContext): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-4)" });
  wrap.appendChild(
    h(
      "h4",
      { class: "legend-col__title", style: "display:flex;align-items:center;gap:var(--space-1)" },
      "Record custodian sign-off (for the recovery sheet)",
      // The essential re-download reminder is folded here, where the operator records the
      // choice, instead of a standing nag paragraph on the ceremony page.
      infoTip("Who holds this copy, and when they confirmed it (public metadata only, never the key). After recording it, re-download the recovery sheet so it captures your choice and the sign-off.", { label: "About custodian sign-off" }),
    ),
  );
  const holder = field({ id: "custody-holder-single", label: "Holder (name or role)", placeholder: "e.g. Alex Chen, Security", doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "your-standing-duty-after-the-ceremony" } });
  // Pre-fill the date to TODAY so the operator is not left to type it (it is editable). A
  // holderless date alone does not create a sign-off row: sync records one only once a holder
  // (or an edited date) is entered, so the prefilled date never fabricates recovery metadata.
  const dated = field({ id: "custody-dated-single", label: "Signed and dated", placeholder: "e.g. 2026-06-09", value: todayISO(), doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "your-standing-duty-after-the-ceremony" } });
  const sync = (): void => {
    const h0 = holder.value();
    const d0 = dated.value();
    ctx.state.signoffs = h0 === "" && d0 === "" ? [] : [{ shareIndex: 1, holder: h0, ...(d0 !== "" ? { signedOn: d0 } : {}) }];
    ctx.emitMeta();
  };
  holder.control.addEventListener("input", sync);
  dated.control.addEventListener("input", sync);
  wrap.appendChild(h("div", { class: "ob-form-grid" }, holder.el, dated.el));
  return wrap;
}

// --- M-of-N split ----------------------------------------------------------------
// buildSplitPickers constructs the bounded N/threshold number inputs and the validity,
// share-list and output hosts for the split panel. Extracted from renderSplit so the
// renderer stays under the structural budget; no behaviour change.
function buildSplitPickers(ctx: CustodyPanelContext): {
  nField: Field;
  tField: Field;
  validity: HTMLElement;
  shareListHost: HTMLElement;
  out: HTMLElement;
} {
  // N and threshold pickers (number inputs, bounded). A live validity line gates the
  // split action with a precise reason.
  // Each picker validates its OWN bound at the field (blur and submit), which is what the live
  // validity line below cannot do: that line is a single status sentence for the PAIR, so it can say
  // the pair is unusable without ever telling the operator which box holds the bad number. The
  // cross-field rule (M cannot exceed N) stays where it belongs, on the pair, in applySplitValidity.
  const nField = field({
    id: "custody-split-n",
    label: `Number of shares (N), ${MIN_SHARES} to ${MAX_SHARES}`,
    type: "number",
    value: String(ctx.state.splitN),
    placeholder: "5",
    validate: wholeNumberBetween({
      noun: "The share count",
      min: MIN_SHARES,
      max: MAX_SHARES,
      remedy: `Type how many shares to cut the key into, for example ${MIN_SHARES + 3}.`,
    }),
    doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "what-the-recovery-kit-contains" },
  });
  const tField = field({
    id: "custody-split-threshold",
    label: "Threshold (M): how many shares reconstruct",
    type: "number",
    value: String(ctx.state.splitThreshold),
    placeholder: "3",
    validate: wholeNumberAtLeast({
      noun: "The threshold",
      min: MIN_THRESHOLD,
      remedy: `Type ${MIN_THRESHOLD} or more, so no single share can rebuild the key on its own.`,
    }),
    doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "what-the-recovery-kit-contains" },
  });
  (nField.control as HTMLInputElement).min = String(MIN_SHARES);
  (nField.control as HTMLInputElement).max = String(MAX_SHARES);
  (tField.control as HTMLInputElement).min = String(MIN_THRESHOLD);

  const validity = h("p", { class: "field__hint", role: "status", "aria-live": "polite" });
  const shareListHost = h("div", { class: "custody-sharelist" });
  const out = h("div", { class: "custody-out", role: "status", "aria-live": "polite" });
  return { nField, tField, validity, shareListHost, out };
}

export function renderSplit(ctx: CustodyPanelContext): HTMLElement {
  const wrap = h("div", { class: "custody-tier" });
  // The split's longer explanation lives in the menu card's infoTip (o.detail); the panel
  // goes straight to the N/threshold pickers.

  const { nField, tField, validity, shareListHost, out } = buildSplitPickers(ctx);

  const splitBtn = h(
    "button",
    { "data-dp": "components-custody-step-panels.button.split", class: "btn btn--primary", type: "button", style: "margin-top:var(--space-3)" },
    svgIcon(ICON_KEYS, { size: 16 }),
    "Encrypt and split in this browser",
  ) as HTMLButtonElement;

  const refresh = (): void => applySplitValidity(ctx, { nField, tField, validity, shareListHost, splitBtn });
  nField.control.addEventListener("input", refresh);
  tField.control.addEventListener("input", refresh);
  // G335: the split-parameter refusal is recorded on BLUR, not on every keystroke. That is the whole
  // difference between evidence and noise here. On input, "12" passes through "1", which the ceremony
  // correctly refuses, so an operator who types a perfectly good pair would produce a refusal row every time;
  // on blur, the row means the operator LEFT the picker with a pair the ceremony will not take, which is the
  // ticket ("the split button stays disabled"). A row here is not on its own proof the ceremony was lost: a
  // later `ceremony-step` shamir-split row (G328) says the split then ran, and the two together tell an
  // operator who fixed it apart from one who is still stuck. Neither N nor the threshold ever rides.
  //
  // AND AN EMPTY PICKER IS NOT A REFUSED PAIR. Number("") is 0, so clearing the share-count
  // box and tabbing away used to run the ceremony's rule over a pair the operator never chose and write
  // custody-split-n/rejected -- indistinguishable from the operator who really did ask for a 1-of-1 split, which
  // is the row the member exists for. A number control also reports "" for text it could not convert, so a
  // mid-edit box is empty here in both senses. Both boxes must hold a value before the pair can be judged at all:
  // the threshold rule is a rule ABOUT THE PAIR (t <= n), so a refusal read off a missing half is a fact the code
  // never established. The recorder enforces the same rule again on whichever box was refused.
  const noteRefusal = (): void => {
    const nRaw = nField.value();
    const tRaw = tField.value();
    if (nRaw === "" || tRaw === "") return; // an operator part-way through the pickers: nothing has been refused
    const res = validateSplitParams(Math.trunc(Number(nRaw)), Math.trunc(Number(tRaw)));
    if (!res.ok && res.refusedField !== undefined) {
      recordFormRefused(res.refusedField, res.refusedField === "custody-split-n" ? nRaw : tRaw);
    }
  };
  nField.control.addEventListener("blur", noteRefusal);
  tField.control.addEventListener("blur", noteRefusal);

  splitBtn.addEventListener("click", () => void doSplit(ctx, ctx.state.splitN, ctx.state.splitThreshold, out, splitBtn));

  // A CONTENT-WIDTH ROW, not two half-panel columns. `.ob-form-grid` is `1fr 1fr`,
  // which gave each picker a 292px track for a single digit AND, worse, squeezed the threshold label
  // below the 277.5px it needs to hold one line. Once that label wrapped, the two number boxes sat
  // 13.4px apart and the two Learn more links 6.7px apart: the owner found exactly that while setting
  // up keys, and the onboarding first-setup card meets it at 1440 and 1280 because its interior column
  // is narrower still. `.custody-split-pickers` sizes each field to its own content and wraps the pair
  // onto separate rows rather than shrinking them, so a label that cannot fit is alone on its row with
  // no peer left to fall out of line with.
  wrap.appendChild(h("div", { class: "custody-split-pickers", style: "margin-top:var(--space-3)" }, nField.el, tField.el));
  wrap.appendChild(validity);
  wrap.appendChild(splitBtn);
  wrap.appendChild(out);

  wrap.appendChild(
    h(
      "h4",
      { class: "legend-col__title", style: "margin-top:var(--space-4);display:flex;align-items:center;gap:var(--space-1)" },
      "Custodian sign-off (for the recovery sheet)",
      infoTip("Record who holds each share (public metadata only, never a share value). After recording them, re-download the recovery sheet so it captures your choice and the sign-offs.", { label: "About custodian sign-off" }),
    ),
  );
  wrap.appendChild(shareListHost);

  refresh();
  return wrap;
}

// applySplitValidity re-validates the N/threshold pickers, gates the split action with a
// precise reason, keeps the sign-off list sized to N (preserving any holders already typed),
// and re-renders the share sign-off rows. The logic is byte-for-byte the original `refresh`
// closure; the only mechanical change is reaching shared state through ctx.
function applySplitValidity(
  ctx: CustodyPanelContext,
  els: { nField: Field; tField: Field; validity: HTMLElement; shareListHost: HTMLElement; splitBtn: HTMLButtonElement },
): void {
  const { nField, tField, validity, shareListHost, splitBtn } = els;
  const n = Math.trunc(Number(nField.value()));
  const t = Math.trunc(Number(tField.value()));
  const res = validateSplitParams(n, t);
  if (res.ok) {
    ctx.state.splitN = n;
    ctx.state.splitThreshold = t;
    validity.replaceChildren(statusWithLabel("ok", `Valid: any ${t} of ${n} shares reconstruct the wrapping key.`));
    splitBtn.disabled = false;
    splitBtn.removeAttribute("aria-disabled");
    // Keep the sign-off list sized to N (preserving any holders already typed).
    ctx.state.signoffs = resizeSignoffs(ctx.state.signoffs, n);
    ctx.emitMeta();
    shareListHost.replaceChildren(renderShareSignoffs(ctx, n, t));
  } else {
    validity.replaceChildren(statusWithLabel("warn", res.reason ?? "Invalid parameters."));
    splitBtn.disabled = true;
    splitBtn.setAttribute("aria-disabled", "true");
    shareListHost.replaceChildren();
  }
}

// renderShareSignoffs builds one holder/date input pair per share, syncing into the
// signoffs state. Public metadata only.
function renderShareSignoffs(ctx: CustodyPanelContext, n: number, threshold: number): HTMLElement {
  const list = h("div");
  const labels = shareLabels(n, threshold);
  for (const lab of labels) {
    const existing = ctx.state.signoffs.find((s) => s.shareIndex === lab.index);
    const holder = field({
      id: `custody-share-holder-${lab.index}`,
      label: `Share ${lab.index} of ${n}: holder`,
      placeholder: "e.g. Alex Chen, Security",
      value: existing?.holder ?? "",
      doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "your-standing-duty-after-the-ceremony" },
    });
    const dated = field({
      id: `custody-share-dated-${lab.index}`,
      // NAMED PER SHARE, like the holder field above it. Five shares each carried the label
      // "Signed / dated", so assistive technology announced five identical controls in a ceremony
      // whose entire purpose is recording WHICH custodian held WHICH share and signed when. The
      // holder field one line up already solves this, and the two are built in the same loop; this
      // one had simply kept a constant. Found by the state walk, which reaches this panel where the
      // loaded-state sweep did not.
      label: `Share ${lab.index} of ${n}: signed / dated`,
      placeholder: "e.g. 2026-06-09",
      // Pre-fill TODAY when this share has no recorded date yet (editable); preserve an
      // already-recorded date on re-render.
      value: existing?.signedOn ?? todayISO(),
      doc: { href: "https://docs.downpipes.io/concepts/key-ceremony-and-recovery-kit", anchor: "your-standing-duty-after-the-ceremony" },
    });
    const sync = (): void => {
      upsertSignoff(ctx, lab.index, holder.value(), dated.value());
      ctx.emitMeta();
    };
    holder.control.addEventListener("input", sync);
    dated.control.addEventListener("input", sync);
    list.appendChild(h("div", { class: "ob-form-grid custody-share-row" }, holder.el, dated.el));
  }
  return list;
}

function upsertSignoff(ctx: CustodyPanelContext, index: number, holder: string, signedOn: string): void {
  const next = ctx.state.signoffs.filter((s) => s.shareIndex !== index);
  next.push({ shareIndex: index, holder, ...(signedOn !== "" ? { signedOn } : {}) });
  next.sort((a, b) => a.shareIndex - b.shareIndex);
  ctx.state.signoffs = next;
}

// renderSplitOutput offers the ciphertext + readme + each share as separate downloads and
// renders the per-custodian re-download rows plus the no-network confirmation. Extracted from
// doSplit so the crypto orchestrator stays a thin function; no behaviour change.
function renderSplitOutput(
  ctx: CustodyPanelContext,
  out: HTMLElement,
  env: { iv: Uint8Array; ciphertext: Uint8Array },
  shares: Uint8Array[],
  checksum: Uint8Array,
  n: number,
  threshold: number,
): void {
  const ciphertextFile = serialiseEnvelopeFile({ iv: env.iv, ciphertext: env.ciphertext });
  // Track what actually reached disk. N+2 downloads fire in one synchronous loop, and a browser that
  // blocks the second and subsequent ones does NOT throw, so this used to report "Downloaded." while a
  // share never arrived. The wrapping key exists only in this closure, so navigating away then made the
  // ciphertext permanently unopenable. Per-share Re-download buttons were the mitigation, and they only
  // help an operator who noticed.
  const undelivered: string[] = [];
  const deliver = (name: string, content: string): void => {
    if (!ctx.downloadText(name, content)) undelivered.push(name);
  };
  deliver(CIPHERTEXT_FILENAME, ciphertextFile);
  deliver(SPLIT_README_FILENAME, splitReadme(n, threshold));
  const labels = shareLabels(n, threshold);
  const shareFiles: HTMLElement[] = [];
  labels.forEach((lab, i) => {
    const shareBytes = shares[i]!;
    const makeFile = (): string => serialiseShareFile({ index: lab.index, n, threshold, checksum, share: shareBytes });
    deliver(lab.filename, makeFile());
    // A per-custodian row with a re-download (no value shown; the file holds the bytes) and, when the
    // host wired an email sender, an Email action that toggles an inline form on this same line.
    const row = h("div", { class: "custody-share-dl" });
    row.appendChild(h("span", { class: "custody-share-dl__title" }, h("strong", lab.title)));
    row.appendChild(h("code", { class: "mono" }, lab.filename));
    const dl = h(
      "button",
      { "data-dp": "components-custody-step-panels.button.download-text", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Re-download ${lab.filename}` },
      "Re-download",
    ) as HTMLButtonElement;
    dl.addEventListener("click", () => ctx.downloadText(lab.filename, makeFile()));
    row.appendChild(dl);
    if (ctx.sendShare) {
      // The email form drops to its own full-width line inside the wrapping flex row (flex-basis:100%),
      // so it opens directly under this share's actions. Download stays the primary, most private route.
      const formHost = h("div", { style: "flex-basis:100%" });
      const emailBtn = h(
        "button",
        { "data-dp": "components-custody-step-panels.button.email", class: "btn btn--secondary btn--sm", type: "button", "aria-expanded": "false", "aria-label": `Email ${lab.title} to a custodian` },
        "Email",
      ) as HTMLButtonElement;
      emailBtn.addEventListener("click", () => {
        if (formHost.childElementCount > 0) {
          formHost.replaceChildren();
          emailBtn.setAttribute("aria-expanded", "false");
        } else {
          formHost.replaceChildren(renderShareEmailForm(ctx, lab, shareBytes, n, threshold));
          emailBtn.setAttribute("aria-expanded", "true");
        }
      });
      row.appendChild(emailBtn);
      row.appendChild(formHost);
    }
    shareFiles.push(row);
  });

  // Prove the split actually reconstructs, BEFORE the operator distributes it and destroys the original.
  // Every share and the checksum are in memory at this instant, so the check is free, and it is the one
  // thing that turns "we split the key" into "we know a quorum recovers it". Deliberately uses only a
  // THRESHOLD-sized subset, because that is the promise being made, not the whole set.
  const selfTest = ((): boolean => {
    try {
      const probe = combine(shares.slice(0, threshold));
      const good = verifyWrappingKey(probe, checksum);
      probe.fill(0);
      return good;
    } catch {
      return false;
    }
  })();

  out.replaceChildren(
    selfTest
      ? statusWithLabel("ok", `Encrypted and split into ${n} shares (any ${threshold} reconstruct). Checked: ${threshold} shares rebuild the key.`)
      : statusWithLabel("danger", `Split into ${n} shares, but a ${threshold}-share check did NOT rebuild the key. Do not distribute these shares or destroy your identity.key. Split again.`),
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Give one share to each custodian. Store ${CIPHERTEXT_FILENAME} (the encrypted key file) separately; on its own it carries no usable key. ${SPLIT_README_FILENAME} explains recovery.`),
    h("div", { class: "custody-share-dls", style: "margin-top:var(--space-3)" }, ...shareFiles),
    ...(undelivered.length > 0
      ? [
          h("p", { class: "field__error", style: "margin-top:var(--space-2)" },
            `Your browser did not deliver ${undelivered.length} of these files (${undelivered.join(", ")}). Use the Re-download buttons below, or allow multiple downloads for this site and split again. Do not leave this page until you hold every file: the key that encrypts them exists only here.`),
        ]
      : []),
    surfaceNote(
      "info",
      "Everything here was generated in this browser",
      "If you download a share it never leaves this device. If you email a share it passes through your own engine and email provider to the custodian's inbox, where it rests until they save it and delete the email; the encrypted key file is never sent anywhere, so keep it well away from your inboxes. Either way Maelstrom receives nothing. Give each share to a different custodian.",
    ),
  );
  toast({ message: `Split into ${n} shares in this browser. Distribute one per custodian.` });
}

// renderShareEmailForm builds the inline "email this share to a custodian" form for one share row. The
// share value is NEVER shown; on send only the share bytes (base64url) plus the typed address and optional
// label go to the operator's OWN engine, which emails it. The ciphertext never goes with it (S1), so a
// captured share stays useless. Download-and-hand-carry stays the most private route.
function renderShareEmailForm(ctx: CustodyPanelContext, lab: { index: number; title: string }, shareBytes: Uint8Array, n: number, threshold: number): HTMLElement {
  const form = h("div", { class: "custody-share-email", style: "margin-top:var(--space-2);padding:var(--space-3);border:1px solid var(--border-subtle);border-radius:var(--radius);width:100%" });
  const emailField = field({
    id: `custody-share-email-${lab.index}`,
    label: `Email share ${lab.index} to`,
    type: "email",
    placeholder: "custodian@yourcompany.com",
    doc: { href: "https://docs.downpipes.io/concepts/choosing-your-key-custody", anchor: "sending-shares-by-email" },
  });
  const labelField = field({
    id: `custody-share-emaillabel-${lab.index}`,
    label: "Custodian name (optional)",
    placeholder: "e.g. Alex Chen, Security",
    // The engine SANITISES this rather than refusing it: cleanLabel trims it to 120 characters and
    // says nothing, so a longer name arrived at the custodian silently cut in half. Refusing it here
    // is the only place the operator can be told before the email goes.
    validate: atMostChars({
      noun: "The custodian name",
      max: 120,
      remedy: "Shorten it to the name or role the custodian will recognise, for example Alex Chen, Security.",
    }),
    doc: { href: "https://docs.downpipes.io/concepts/choosing-your-key-custody", anchor: "sending-shares-by-email" },
  });
  const status = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin-top:var(--space-2)" });
  const sendBtn = h("button", { "data-dp": "components-custody-step-panels.button.send", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-2)" }, "Send this share") as HTMLButtonElement;
  // THE FIELD'S RULE IS ENFORCED HERE, not merely displayed. atMostChars above runs on blur, and before
  // this the Send handler read the raw value and posted it regardless, so an over-long name showed a red
  // error AND was sent, and the engine's cleanLabel truncated it to 120 in silence: the custodian received
  // a cut name and both the console and the engine reported success. Running the field's own validator
  // before the request is built is the only point at which the operator can still fix it.
  sendBtn.addEventListener("click", () => {
    if (!labelField.validate()) {
      labelField.focus();
      status.replaceChildren(statusWithLabel("warn", "The custodian name is too long, so nothing was sent. Shorten it and send again."));
      return;
    }
    void doSendShare(ctx, shareBytes, n, threshold, emailField, labelField, sendBtn, status);
  });
  form.appendChild(h("div", { class: "ob-form-grid" }, emailField.el, labelField.el));
  form.appendChild(sendBtn);
  form.appendChild(status);
  form.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "The custodian is asked to save it offline or in a password manager, then delete the email. For the most sensitive shares, prefer download and hand-carry."),
  );
  return form;
}

// doSendShare POSTs one share to the operator's own engine to email it. Fail-soft: a refusal
// (email not configured, a bad address, a rate limit) surfaces as a precise warn line, never a throw, and
// the operator can always fall back to the download. The share value is never rendered.
async function doSendShare(
  ctx: CustodyPanelContext,
  shareBytes: Uint8Array,
  n: number,
  threshold: number,
  emailField: Field,
  labelField: Field,
  btn: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  if (!ctx.sendShare) return;
  const toEmail = emailField.value().trim();
  if (toEmail === "") {
    status.replaceChildren(statusWithLabel("warn", "Enter the custodian's email address."));
    return;
  }
  const label = labelField.value().trim();
  setBtnBusy(btn, true, "Sending");
  status.replaceChildren(spinnerLine("Sending the share through your engine. The encrypted key file is never sent."));
  // sendShare is a host-injected prop, and this await had no rejection path of its own. Today's three
  // injectors all route to sendCustodyShare, which is documented fail-soft and catches everything, so
  // the freeze was not reachable -- but nothing at THIS seam enforced that, and the failure mode if it
  // ever stopped holding is the worst one there is: the button stays disabled reading "Sending", the
  // spinner line stays up, and the custodian never receives a share the operator believes was sent.
  // That is the frozen-placeholder shape, in a one-shot custody ceremony. The panel now owns its own
  // rejection instead of borrowing someone else's discipline.
  let res: Awaited<ReturnType<NonNullable<typeof ctx.sendShare>>>;
  try {
    res = await ctx.sendShare({
      toEmail,
      n,
      m: threshold,
      shareB64: b64urlEncode(shareBytes),
      ...(label !== "" ? { custodianLabel: label } : {}),
    });
  } catch {
    setBtnBusy(btn, false, "Send this share");
    status.replaceChildren(statusWithLabel("warn", "The send did not complete, so treat this share as NOT delivered. Try again, or download it and hand it over yourself."));
    return;
  }
  setBtnBusy(btn, false, "Send this share");
  if (res.sent) {
    status.replaceChildren(statusWithLabel("ok", `Emailed to ${toEmail}. Ask them to save it offline or in a password manager, then delete the email.`));
  } else {
    status.replaceChildren(statusWithLabel("warn", shareSendReasonMessage(res.reason, res.code)));
  }
}

// shareSendReasonMessage maps the engine's coarse, value-free refusal reason to a specific, actionable
// line, so the operator learns WHY and what to do (configure email, fix the address, or just download).
function shareSendReasonMessage(reason?: string, code?: string): string {
  const r = reason ?? "";
  if (r === "email-not-configured") {
    return "Outbound email is not set up on your engine yet. Configure a sending domain first, then try again, or download this share and hand it over.";
  }
  if (r === "email-from-not-configured" || r === "email-from-invalid") {
    return "Your engine's sender address is unset or not a custom-domain address. Set it on the engine, then try again.";
  }
  if (r.startsWith("custodian email invalid")) {
    return "That is not a valid address on a custom domain. Check it and try again.";
  }
  if (r === "rate-limited" || code === "rate-limited") {
    return "Too many sends just now. Wait a moment and try again.";
  }
  if (r === "not-authorised" || r === "forbidden") {
    return "You do not have permission to email custodian shares.";
  }
  if (r === "network-error") {
    return "Could not reach your engine. Check your connection and try again.";
  }
  return `The share was not sent (${r === "" ? "unknown reason" : r}). You can download it and hand it over instead.`;
}

// doSplit performs the envelope + Shamir split entirely in-browser and offers the
// ciphertext, a recovery readme, and each share as a separate, clearly-labelled download.
async function doSplit(ctx: CustodyPanelContext, n: number, threshold: number, out: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  setBtnBusy(btn, true, "Encrypting and splitting");
  out.replaceChildren(spinnerLine("Encrypting and splitting in this browser. No share or key is being sent."));
  try {
    const plaintext = identityPlaintext(ctx.result);
    // 1. Envelope-encrypt the key file with a fresh random 256-bit wrapping key.
    const env = await encrypt(plaintext);
    // 2. Shamir-split ONLY the 32-byte wrapping key M-of-N.
    const shares = shamirSplit(env.wrappingKey, n, threshold);
    // 2b. Compute the PUBLIC wrapping-key checksum (R4): it travels in every share file and
    // the readme so recovery can detect a wrong or mis-transcribed share BEFORE trusting the
    // recombined key. It is one-way and reveals nothing usable about the key.
    const checksum = wrappingKeyChecksum(env.wrappingKey);
    setBtnBusy(btn, false, "Encrypt and split in this browser");

    // 3. Offer the ciphertext + readme + each share as separate downloads.
    recordCeremonyStep("shamir-split", true);
    renderSplitOutput(ctx, out, env, shares, checksum, n, threshold);
  } catch (err) {
    // The M-of-N split failed in the browser. Neither N nor the threshold rides, deliberately and against
    // the temptation: they are in scope right here, they would be genuinely useful, and they are the customer's
    // own custody design and a fingerprint of it. The step, the outcome and a coarse fault class answer the
    // ticket ("our split keeps failing") without them.
    recordCeremonyStep("shamir-split", false, ceremonyFaultFor(err));
    setBtnBusy(btn, false, "Encrypt and split in this browser");
    out.replaceChildren(
      h("p", { class: "field__error" }, `Split failed in the browser (${errMessage(err)}). No share or key left this device.`),
    );
  }
}
