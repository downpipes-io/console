// The portal licence-activation control (the Licence card's action area). It is the owner-gated
// Activate / Replace / Remove control, folded INTO the Licence card under a hairline rather than its
// own box (a licence's status and its one action are the same object), so the screen keeps its three
// eager sections. The licence email now leads with a SHORT claim code (DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX)
// rather than the full signed token, so this control offers the claim code FIRST: the operator types or
// pastes it, the console exchanges it for the real token at the vendor's control plane (claim-code.ts),
// and that token is fed into the EXACT SAME submit as a directly pasted token. The full-token textarea
// stays exactly as it was, immediately below, for when the code cannot be reached or fetched. Either way
// the engine verifies the token live against the pinned vendor signer and stores it in the scheduler DO,
// no Worker secret, no command line, no redeploy. Moved verbatim from the licence coordinator for size;
// copy, markup and the no-custody / fail-open framing are unchanged (the claim-code path is additive).
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, LicenceStatus } from "../../api.ts";
import { field, validateForm } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { licenceAccountMismatch, licenceActivatedLine, licenceValidityShortened, tierDisplayName } from "../../lib/billing.ts";
import { recordClaimExchange } from "../../lib/client-diag/ring.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { dateOnly } from "../../lib/format.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canCap, capGateReason, refuseWithReason } from "../common.ts";
import { CLAIM_HINT_TEXT, CLAIM_TIMEOUT_MS, fetchClaimToken, formatClaimCode, isClaimCodeShape, normaliseClaimCode } from "./claim-code.ts";
import { engineRefusalText } from "./shared.ts";

// The capability the engine gates POST /admin/licence on. keys.ceremony is OWNER-RESERVED (a group can
// confer access.policy, never keys.ceremony, see the engine's identity model), so a group-conferred
// access-admin cannot activate a licence; only the owner can. The console mirrors exactly this gate as
// disabled-with-reason UX; the engine ENFORCES it server-side regardless of what the console shows.
const LICENCE_MANAGE_CAP = "keys.ceremony" as const;

// activationSection is the owner-gated Activate / Replace / Remove control, FOLDED INTO the Licence card as
// its action area (the caller appends it under a hairline). It is NOT its own box: a licence's status and its
// one action are the same object, so a separate adjacent card would spend a fourth eager section against the
// screen's calm-density budget (boxes are for interactive objects, and this control
// is the Licence card's interaction, not a new one). Calm density holds (no ambient effects, no notice
// stacking, the engine's refusal is the single inline error channel, never a toast). The two states the
// brief names:
//   - a CONSOLE-set active token (status.source === "console"): "Replace token" (paste a renewed token for
//     a renewal) and "Remove" (clears the DO-stored token via setLicence(null), returning to whatever the
//     deploy/env or Community state is).
//   - community / no console token (incl. a DEPLOY-set token): a paste field + "Activate", to store the
//     licence token from the activation email through the portal (no Worker secret, no CLI, no redeploy).
// On success: re-fetch the screen (reload) so every tile/row reflects the new tier + a confirmation toast,
// and move focus to focusAnchorId (the Licence card heading) so a keyboard/AT user is not stranded at <body>
// after the region is replaced. On failure: the engine's refusal reason inline at the field. Owner-gating
// mirrors the engine: a non-owner sees the control disabled-with-reason (the engine still enforces
// keys.ceremony server-side). reload returns a Promise (licence.ts load returns the Promise.all chain) so
// the focus restoration can AWAIT the rebuilt region; the re-render is asynchronous, so a synchronous
// restore would run against the skeleton and silently no-op.
// cfAccountId is this engine's own Cloudflare account id
// (GET /admin/status's cfAccountId, read by the caller off data.status), threaded through so a claim
// exchange can send it with the code and the control plane can bind the self-serve licence to it.
// Honestly absent (the common single-account deployment never sets CF_ACCOUNT_ID, or an older engine
// predates the field): the claim then sends no account id, exactly as it did before this field existed.
export function activationSection(engine: EngineClient, lic: LicenceStatus, reload: () => void | Promise<void>, focusAnchorId: string, cfAccountId?: string): HTMLElement {
  const canManage = canCap(LICENCE_MANAGE_CAP);
  const consoleSet = lic.source === "console";

  // A11y focus restoration: after reload() replaces the async region the activation section's nodes are gone
  // and focus falls to <body>. The re-render is ASYNCHRONOUS (reload first paints a skeleton, then awaits the
  // engine reads before render() recreates the Licence card heading carrying focusAnchorId), so this MUST run
  // only after `await reload()` resolves; the re-created heading then exists and focus lands on the card the
  // operator acted on. The toast already announces the result via role=status; this only places focus.
  // Guarded so a missing anchor never throws.
  const restoreFocus = (): void => {
    const anchor = document.getElementById(focusAnchorId);
    if (anchor instanceof HTMLElement) anchor.focus();
  };

  // The section, not a card: a plain wrapper the caller appends inside the Licence card. The header,
  // lead, who/when and owner-gate note are the read-only context; the paste field + actions are the
  // interactive control. Each is built by a focused helper so this shell stays a thin compositor.
  const card = h("section");
  card.appendChild(renderActivationHeader(lic, canManage, consoleSet));

  // The claim-code path FIRST (it is what the licence email leads with): a short, typeable code the
  // console exchanges for the real signed token at the vendor's control plane; the fetched token then runs
  // through the EXACT SAME submit as a pasted token below.
  //
  // STILL OPTIONAL, AND THAT HALF IS UNCHANGED: no `required`, and an EMPTY value is valid, because leaving
  // this blank and pasting a token into the textarea below is a first-class path. Breaking that to gain a
  // validation message would trade a real journey for a nicer error.
  //
  // WHAT CHANGED: a NON-EMPTY value that is not a claim code now says so, instead of nothing.
  // Before this, a customer who mistyped or half-pasted the code from their licence email got no feedback at
  // all: the field stayed silent, the submit handler quietly ignored it, and the screen offered no reason.
  //
  // The check is the SAME predicate the submit handler uses, called through the same normaliser, so the field
  // and the submit can never disagree about what a claim code is. A second, looser copy here would be worse
  // than nothing: it would accept a code the submit then ignores, which is the silence this closes.
  const claimField = field({
    id: "licence-claim-code",
    label: "Claim code (from your licence email)",
    placeholder: "DWNP-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
    autocomplete: "off",
    hint: CLAIM_HINT_TEXT,
    validate: (v) =>
      v.trim() === "" || isClaimCodeShape(normaliseClaimCode(v))
        ? null
        : "That is not a claim code. It is DWNP followed by 30 characters in six groups of five, exactly as your licence email shows it. Leave this empty if you are pasting the licence token below instead.",
    doc: { href: "https://docs.downpipes.io/operations/licensing-and-control-plane", anchor: "buying-and-activating-a-licence-with-no-command-line" },
  });
  card.appendChild(claimField.el);

  const tokenField = field({
    id: "licence-token",
    label: consoleSet ? "Renewed licence token" : "Licence token",
    kind: "textarea",
    placeholder: "Paste the licence token from your activation email",
    hint: "From your activation or renewal email, a long signed block of text. It is verified against the pinned vendor key before anything is stored; a typo or the wrong key is refused, not saved.",
    doc: { href: "https://docs.downpipes.io/operations/licensing-and-control-plane", anchor: "buying-and-activating-a-licence-with-no-command-line" },
    required: true,
    autocomplete: "off",
    // The old rule was v.length >= 1, which is presence and nothing else. The field is already
    // `required`, so field()'s own required arm caught the empty box first and this validator could only
    // ever return null: it was the exact dead shape field.ts warns about, a validator that can only reject
    // the empty string.
    //
    // Meanwhile the engine wants a SHAPE, at engine/src/admin/router-updates.ts:221, and refuses anything
    // else before it verifies anything: the trimmed token must be at most 20000 characters and must match
    // /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, EXACTLY TWO dot-joined parts. Driven against engine main through
    // the production handleAdmin: "x", "not a token", a 30000-character paste and the three-part
    // "abc.def.ghi" all take 400 "that does not look like a licence token"; "abc.def" passes the shape and
    // takes a DIFFERENT 400 (reasonCode "decode"). The engine trims first, so surrounding whitespace on a
    // paste is fine and is not refused here either.
    //
    // WHAT THIS DELIBERATELY DOES NOT CLAIM. Whether the token verifies against the pinned vendor key is
    // not knowable in the browser: the console holds no key and the signature is checked server-side
    // before anything is stored. So the message says the paste does not have the shape of a token, never
    // that it is invalid, and a well-shaped token that fails verification still goes to the engine and
    // comes back with the engine's own refusal at this field.
    validate: (v) => (v === "" || (v.length <= 20000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) ? null : "That does not have the shape of a licence token. It is one long dot-joined string with two parts, copied whole from your activation email."),
  });
  card.appendChild(tokenField.el);

  // The single inline error channel (the engine's verify-before-store refusal verbatim, AT the field;
  // never a toast, and the pasted value is kept so a near-miss can be corrected without re-pasting).
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  card.appendChild(formError);

  // `lic` rides into the actions as `previous`: it is the status this card was rendered from, and after a
  // successful activation it is the only record of what the new token REPLACED. The engine stores whatever
  // verifies without comparing it to what was there, so pasting an older term's token is accepted and
  // reported as an ordinary activation; comparing the two statuses is how the toast can say the validity
  // date moved backwards. See lib/billing.ts licenceValidityShortened.
  card.appendChild(renderActivationActions(engine, { canManage, consoleSet, previous: lic, reload, restoreFocus, claimField, tokenField, formError, ...(cfAccountId !== undefined ? { cfAccountId } : {}) }));
  return card;
}

// renderActivationHeader builds the read-only context of the activation section: the heading (with the
// "activated in console" badge when applicable), the plain-words lead stating the no-CLI / fail-open
// framing once, the redaction-safe who/when line for a console-set token, and the owner-gate note for a
// caller who cannot manage. No interaction lives here.
function renderActivationHeader(lic: LicenceStatus, canManage: boolean, consoleSet: boolean): HTMLElement {
  const head = h("div");
  head.appendChild(
    h(
      "div",
      { class: "card__header", style: "margin-bottom:var(--space-2)" },
      h("h3", { class: "section-title", style: "margin-bottom:0" }, consoleSet ? "Replace or remove licence" : "Activate licence"),
      consoleSet ? badge("ok", "Activated in console", { dot: true }) : false,
    ),
  );
  head.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      consoleSet
        ? "This licence was activated here in the console. Paste a renewed token to replace it (for a renewal), or remove it to return to the deploy-time or Community state. A licence never gates the data or recovery path, this only changes the reported tier."
        : "Paste the licence token from your activation email. The engine verifies it live against the pinned vendor key and stores it in your account, no Worker secret, no command line, no redeploy. A licence never gates the data or recovery path; this only changes the reported tier.",
    ),
  );

  // Who/when, for a console-set token (redaction-safe: an email + a date, never the token value).
  if (consoleSet && (lic.setBy || lic.setAt !== undefined)) {
    const whenStr = lic.setAt !== undefined ? dateOnly(new Date(lic.setAt).toISOString()) : undefined;
    const parts: string[] = [];
    if (lic.setBy) parts.push(`by ${lic.setBy}`);
    if (whenStr) parts.push(`on ${whenStr}`);
    if (parts.length) head.appendChild(h("p", { class: "field__hint" }, `Activated ${parts.join(" ")}.`));
  }

  // The owner gate, mirrored as a calm note (not a tinted banner, standing information). The engine
  // enforces keys.ceremony regardless; this only decides whether the controls are enabled.
  if (!canManage) {
    head.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `Activating a licence is owner only. ${capGateReason(LICENCE_MANAGE_CAP)}`));
  }
  return head;
}

// renderActivationActions builds the Activate/Replace (primary) + Remove (console-set only) buttons,
// owner-gated as disabled-with-reason (the engine enforces server-side). On success each handler
// awaits reload() so the region is rebuilt before restoreFocus() places focus on the card heading;
// on failure it surfaces the engine's refusal verbatim at the field and keeps the pasted value.
function renderActivationActions(
  engine: EngineClient,
  ctx: {
    canManage: boolean;
    consoleSet: boolean;
    // The status this card was rendered from: what the token about to be stored is replacing.
    previous: LicenceStatus;
    reload: () => void | Promise<void>;
    restoreFocus: () => void;
    claimField: ReturnType<typeof field>;
    tokenField: ReturnType<typeof field>;
    formError: HTMLElement;
    cfAccountId?: string;
  },
): HTMLElement {
  const { canManage, consoleSet, previous, reload, restoreFocus, claimField, tokenField, formError, cfAccountId } = ctx;
  const actions = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-top:var(--space-3)" });

  const submitLabel = consoleSet ? "Replace token" : "Activate";
  const submitBtn = h(
    "button",
    { "data-busy-label": "Verifying", "data-dp": "licence.button.submit", class: "btn btn--primary btn--sm", type: "button" },
    submitLabel,
  ) as HTMLButtonElement;

  // submitToken runs the UNCHANGED verify-before-store submit against whichever token is in hand: a
  // claim-code exchange's answer, or the textarea's pasted value. Both paths converge here so there is
  // exactly ONE activation behaviour (toast + reload + focus-restore on success; the engine's refusal
  // verbatim inline on failure), never two implementations that could drift apart.
  async function submitToken(token: string): Promise<void> {
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying";
    try {
      const status = await engine.setLicence(token);
      // The confirmation is derived from the status the engine JUST returned, never assumed from the fact
      // that the call resolved. A licence minted for a DIFFERENT Cloudflare account activates exactly like
      // any other (fail-open: the engine stores it and reports its tier), so a fixed success sentence here
      // told the operator their licence was fine at the one moment they would have acted on being told it
      // was not. licenceActivatedLine says what was stored AND names the account fact; the warn tone stops
      // it reading as an ordinary confirmation, and the card's standing banner carries the remedy.
      //
      // `previous` adds the second thing a fixed sentence hid: the engine stores whatever verifies without
      // comparing it to the token already there, so an OLDER term's token replaces a current one, shortens
      // the validity date, and reports success. Neither fact can refuse the activation (the engine has
      // already stored it, and fail-open means it gates nothing either way), so both are reported.
      const needsCare = licenceAccountMismatch(status) || licenceValidityShortened(previous, status);
      toast({ message: licenceActivatedLine(status, previous), ...(needsCare ? { tone: "warn" as const } : {}) });
      await reload();
      restoreFocus();
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: nothing was activated, so the submit control comes back.
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
        return goSignedOut();
      }
      // Verify-before-store refusal: surface the engine's reason verbatim and keep the pasted value.
      formError.textContent = engineRefusalText(err);
      formError.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  }

  async function activate(): Promise<void> {
    formError.hidden = true;
    // The claim-code field wins when it holds a well-shaped code (DWNP + a 30-character Crockford-base32
    // payload; normaliseClaimCode tolerates case, hyphens and stray whitespace): fetch the real token from
    // the control plane and hand it to the SAME submit the textarea uses below. An empty or wrong-shape
    // value here is NOT an error of its own; it silently falls through to the textarea path (today's
    // behaviour, byte for byte, including the shared empty-input message when both are empty).
    const normalised = normaliseClaimCode(claimField.value());
    // The silent shape-rejection. A value that is not a well-formed claim code falls straight through to
    // the paste-a-token path without a word, so an operator who typed a NEAR MISS (a transposed character, a
    // dropped group) is answered with the token path's message and is steered to the wrong fix entirely: they
    // go hunting for a token they were never sent, while the actual problem is one character in the code in
    // front of them.
    //
    // Recorded ONLY when the field is non-empty. An EMPTY claim field is the operator legitimately using the
    // token path, which is the flow working, and a row on every healthy token activation would be a signal that
    // fires on the good path. The code itself never rides: `claimResult` is a closed enum and there is no field
    // that could carry it.
    if (normalised !== "" && !isClaimCodeShape(normalised)) recordClaimExchange("shape-rejected");
    if (isClaimCodeShape(normalised)) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Retrieving…";
      const claimed = await fetchClaimToken(formatClaimCode(normalised), CLAIM_TIMEOUT_MS, cfAccountId);
      if (!claimed.ok) {
        formError.textContent = claimed.message;
        formError.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
        return;
      }
      await submitToken(claimed.token);
      return;
    }
    if (!validateForm([tokenField])) return;
    await submitToken(tokenField.value());
  }
  if (canManage) submitBtn.addEventListener("click", () => void activate());
  else refuseWithReason(submitBtn, capGateReason(LICENCE_MANAGE_CAP));
  actions.appendChild(submitBtn);

  if (consoleSet) {
    const removeBtn = h(
      "button",
      { "data-dp": "licence.button.remove", class: "btn btn--ghost btn--sm", type: "button" },
      "Remove",
    ) as HTMLButtonElement;
    if (!canManage) refuseWithReason(removeBtn, capGateReason(LICENCE_MANAGE_CAP));
    if (canManage) {
      removeBtn.addEventListener("click", async () => {
        const okd = await confirmModal({
          title: "Remove the activated licence?",
          body: "This clears the licence token stored here. Fail-open holds: nothing is gated, backups and restores continue. The engine falls back to a deploy-time token if one is pinned, otherwise it reports the Community tier.",
          confirmLabel: "Remove licence",
          variant: "danger",
          busyLabel: "Removing",
        });
        if (!okd) return;
        formError.hidden = true;
        try {
          const status = await engine.setLicence(null);
          toast({ message: `Licence removed. The engine now reports the ${tierDisplayName(status.tier)} tier.` });
          await reload();
          restoreFocus();
        } catch (err) {
          if (isUnauthorised(err)) return goSignedOut();
          formError.textContent = engineRefusalText(err);
          formError.hidden = false;
        }
      });
    }
    actions.appendChild(removeBtn);
  }

  return actions;
}
