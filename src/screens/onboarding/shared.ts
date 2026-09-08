// Shared leaf helpers and the carousel chrome for the onboarding / key-ceremony area. These are
// the small reusable building blocks the step renderers (./steps.ts) and the card deck
// (./carousel.ts) both reach for, plus the deck's own action-row and eyebrow helpers and its
// per-card navigation types. They live in this leaf so neither sibling imports the other (which
// would form a cycle); the coordinator imports the deck, the deck imports the steps, and both
// import this. Moved verbatim from the onboarding coordinator for size; behaviour is unchanged.
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { deliverFile, openHtmlTab } from "../../lib/file-delivery.ts";
import type { ClientDiagSurface } from "../../lib/client-diag/vocab.ts";
import { toast } from "../../components/toast.ts";
import { caller, whoamiAvailable, refreshIdentity, navigate } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { statusWithLabel, badge, type StatusTone } from "../../components/status.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { accessVerdictFromCaller, type AccessVerdict } from "../../components/trust-chips.ts";
import { copyButton } from "../../components/code-block.ts";
import { infoTip } from "../../components/info-tip.ts";
import { getThemePref, setThemePref, type ThemePref } from "../../lib/theme.ts";
import {
  ICON_X_CIRCLE,
  ICON_MONITOR,
  ICON_SUN,
  ICON_MOON,
  ICON_CHECK,
  ICON_CHEVRON_LEFT,
} from "../../lib/icons.ts";
import { getEngine, getEngineUrl } from "../../lib/store.ts";
import {
  identityFile,
  recipientFile,
  signerPublicFile,
  signerPrivateFile,
  type CeremonyResult,
} from "../../keygen.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../../recovery-sheet.ts";
import type { CustodyMetadata } from "../../lib/custody.ts";
import type { EngineClient } from "../../api.ts";

// themeControl builds the live System / Light / Dark segmented control (theme.ts). It is
// a real control, not a mock; status by pressed-state + glyph + label.
export function themeControl(): HTMLElement {
  const group = h("div", { class: "ob-theme", role: "group", "aria-label": "Colour theme" });
  const opts: Array<{ pref: ThemePref; label: string; glyph: string }> = [
    { pref: "system", label: "System", glyph: ICON_MONITOR },
    { pref: "light", label: "Light", glyph: ICON_SUN },
    { pref: "dark", label: "Dark", glyph: ICON_MOON },
  ];
  const buttons: HTMLButtonElement[] = [];
  const current = getThemePref();
  for (const o of opts) {
    const btn = h(
      "button",
      { "data-dp": "onboarding.toggle.set-theme-pref",
        class: "ob-theme__btn",
        type: "button",
        "aria-pressed": o.pref === current ? "true" : "false",
      },
      svgIcon(o.glyph, { size: 14 }),
      h("span", { class: "ob-theme__label" }, o.label),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      setThemePref(o.pref);
      for (const b of buttons) b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    buttons.push(btn);
    group.appendChild(btn);
  }
  return group;
}

// ============================================================================
// Step 1: Connect (with the CONSOLE_ORIGIN diagnostic, C2)
// ============================================================================

// accessLine maps the resolved sign-in verdict to the single status line the connect
// result carries. Honest by construction: green only for a verified method, amber for
// the unattributable token, and the degrade states claim no more than was proven.
//
// G298: TOTAL OVER THE VERDICT UNION. It used to answer four states and send the rest to a neutral "not verified
// yet", so an OIDC or SAML sign-in the engine had verified, and a recovery-code sign-in, read on the connect step
// exactly like a session the console could make no claim about at all. Each verified method now says which one it
// was, and the only neutral line left is for the states where nothing WAS established.
export function accessLine(v: AccessVerdict): HTMLElement {
  switch (v.state) {
    case "verified":
      return statusWithLabel("ok", `Cloudflare Access verified${v.email ? ` as ${v.email}` : ""}.`);
    case "passkey-verified":
      return statusWithLabel("ok", `Signed in with a passkey${v.email ? ` as ${v.email}` : ""}.`);
    case "idp-verified":
      return statusWithLabel("ok", `Signed in through your identity provider over ${v.protocol === "saml" ? "SAML" : "OIDC"}${v.email ? ` as ${v.email}` : ""}.`);
    case "recovery-verified":
      return statusWithLabel("warn", `Signed in with a recovery code${v.email ? ` as ${v.email}` : ""}; use your usual method once you are back in.`);
    case "token-fallback":
      return statusWithLabel("warn", "Admin token in use; the readiness checklist and the Access verifier cover hardening.");
    case "session-present":
      return statusWithLabel("info", "Signed in; this engine does not report the method.");
    case "unverified":
      return statusWithLabel("warn", "This session is not verified; sign in again.");
    default:
      return statusWithLabel("neutral", "Sign-in method not verified yet; the readiness checklist re-checks it.");
  }
}

// resolveAccessVerdict reads the honest verdict. When whoami (D1) is available it returns
// verified (access) / token-fallback (token) from the real result; until D1 ships it
// degrades to "session-present" (a 200 proves an authenticated session, but not the
// method) and never claims the green/amber distinction it cannot back. It refreshes the shared identity so the shell chip stays in step.
export async function resolveAccessVerdict(engine: EngineClient): Promise<AccessVerdict> {
  // If the shell has already resolved whoami, mirror it (no second round trip).
  if (whoamiAvailable() && caller()) {
    return accessVerdictFromCaller(caller(), true);
  }
  try {
    const who = await engine.whoami();
    // Refresh the shared identity so the shell chip and the client gate use the same
    // verdict the verifier just showed.
    await refreshIdentity();
    // G298: ONE READ OF THE METHOD, AND THIS IS IT. This branch used to re-implement the mapping and stop at
    // access/passkey, so every other method -- a live OIDC or SAML session, a recovery-code sign-in, and any
    // method a newer engine adds -- fell through to token-fallback and told the customer, on the onboarding
    // readiness checklist, that their fleet runs on the shared break-glass credential. It is the worst claim the
    // console can make about a customer's posture, it was false, and the remedy it implies ("rotate the token,
    // we are exposed") is a scramble against nothing. It also recorded no wire-anomaly row for an unrecognised
    // method, so the pack could not even show that this surface had been handed a value it could not read.
    // accessVerdictFromCaller is the single classifier: it answers honestly for all six methods and records the
    // unknown-enum row itself. WhoAmI carries every field Caller requires, so it needs no re-shaping.
    return accessVerdictFromCaller(who, true);
  } catch (err) {
    if (isUnauthorised(err)) throw err;
    // whoami absent (D1 pending): prove the session another way. A 200 from status means
    // authenticated-session-present (method unknown); a thrown non-401 is unknown.
    await engine.status();
    return { state: "session-present" };
  }
}

// ============================================================================
// Step 3: Key ceremony (the emotional centre; in-browser, no custody)
// ============================================================================

export function fileRow(name: string, dest: string, tone: StatusTone, onDownload: () => void, opts: { keepOffline?: boolean; tip?: string } = {}): HTMLElement {
  const li = h("li", { class: "ob-filelist__row" });
  li.appendChild(h("code", { class: "mono ob-filelist__name" }, name));
  // ONE badge per row. Keep-offline files (identity.key, the recovery sheet) carry a
  // single amber "Keep offline" chip, so colour marks exactly the files the operator
  // must protect; routine to-engine files get a quiet neutral chip. (The old rows
  // double-stamped identity.key with both "KEEP OFFLINE" and "Keep offline".)
  li.appendChild(opts.keepOffline ? badge("warn", dest) : badge(tone, dest));
  // Each per-file explanation lives in an infoTip on the row, not as standing text (calm
  // density). The label names the file so the (i) control is self-describing for AT.
  if (opts.tip) li.appendChild(infoTip(opts.tip, { label: `About ${name}` }));
  li.appendChild(h("span", { class: "ob-filelist__spacer" }));
  // aria-label disambiguates each Re-download button with the file name so that
  // keyboard and AT users do not encounter a list of identically-named controls
  // (WCAG 4.1.2 / SC 2.4.6).
  const dl = h("button", { "data-dp": "onboarding.button.download", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Re-download ${name}` }, "Re-download") as HTMLButtonElement;
  dl.addEventListener("click", onDownload);
  li.appendChild(dl);
  return li;
}

export function fpRow(label: string, fingerprint: string): HTMLElement {
  return h(
    "div",
    { class: "fp-row" },
    h("span", { class: "fp-row__label field__hint" }, label),
    // Focusable so keyboard users can scroll the full fingerprint into view to
    // verify it (WCAG 2.1.1); the universal :focus-visible ring applies.
    h("code", { class: "mono fp-row__value", tabindex: "0", role: "region", "aria-label": `${label} fingerprint` }, fingerprint),
    copyButton(`Copy ${label} fingerprint`, () => fingerprint),
  );
}

// ============================================================================
// Shared helpers
// ============================================================================

// notConnectedNotice is the honest "no engine connected" state any step past connect
// shows if reached without a connection (e.g. a deep link before connecting). It teaches
// and routes back rather than rendering a broken step.
export function notConnectedNotice(): HTMLElement {
  return verdictSurface({
    tone: "neutral",
    glyph: ICON_X_CIRCLE,
    title: "Not connected to an engine yet",
    body: "Connect to your in-account engine first; this step needs it.",
    action: { label: "Go to Connect", onClick: () => navigate("/onboarding/connect") },
  });
}

// setBusy toggles a button's busy state with a stable-width label swap (the busy label is
// remembered against the original so it restores cleanly). aria-busy is set for AT.
export function setBusy(btn: HTMLButtonElement, busy: boolean, label: string): void {
  if (busy) {
    // data-busy drives the design-system .btn__spinner (reserved width, reduced-motion
    // gated by tokens.css); aria-busy announces it to assistive tech.
    btn.dataset.busy = "true";
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "btn__spinner", "aria-hidden": "true" }), document.createTextNode(` ${label}`));
  } else {
    btn.dataset.busy = "false";
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    btn.replaceChildren(document.createTextNode(label));
  }
}

// recordCeremonyIntent records the key-ceremony INTENT in the audit log (D4 1.4.5), best-effort and
// Owner-gated server-side. It records ONLY that a ceremony was STARTED, never a value or a fingerprint.
//
// G046: it is called at the ATTEMPT, before the ceremony runs, not after it succeeds. Recorded only on
// success, the marker vanished exactly when it was needed: a ceremony that threw (no WebCrypto, a hardened
// browser) left the engine's audit log identical to one where the operator never pressed the button, so
// support could not tell a FAILED ceremony from a SKIPPED one, and the customer with no recovery material
// could not be told which had happened. Marking the attempt makes the two distinguishable in the support
// pack: an intent event with no keys installed is a ceremony that did not complete, and no intent event at
// all is a ceremony nobody started. The word "intent" is exact for a marker taken at the attempt.
//
// A missing audit store (or a non-Owner caller) simply means no entry, an honest degrade and never a
// surfaced error. That POST goes through the one engine seam, so a failure to record the marker is itself
// carried into the pack as a closed-class engine-call fault.
export function recordCeremonyIntent(): void {
  const engine = getEngine();
  if (!engine) return;
  void engine.recordAuditIntent("key-ceremony-intent").catch(() => {
    // No-op: the audit store (D4) may not be present, or the caller may not be Owner.
    // The ceremony is complete regardless; the intent marker is additive.
  });
}

// sheetParams builds the recovery-sheet metadata (the account label, the creation time,
// and the active posture worded to match the ceremony). The break-glass-only posture is
// the stronger default (no operational private on the engine). The optional custody
// argument carries the chosen offline custody scheme + custodian sign-off (public metadata
// only; never a key or share value), included only once a scheme is chosen.
export function sheetParams(result: CeremonyResult, custody?: CustodyMetadata): SheetParams {
  const includeCustody = custody !== undefined && custody.scheme !== "undecided";
  return {
    downpipeAccount: hostLabel(),
    createdAt: new Date().toISOString(),
    posture: result.operational ? "two-recipient" : "break-glass-only",
    ...(includeCustody ? { custody } : {}),
  };
}

export function hostLabel(): string {
  const url = getEngineUrl();
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      // fall through to the console host
    }
  }
  return location.host;
}

// openRecoverySheetWith opens the self-contained, public-only recovery sheet in a new tab through the guarded
// blob-tab primitive (lib/file-delivery.ts). The sheet document has its own opaque origin, so it is
// independent of the console's Content-Security-Policy, and its print button uses addEventListener rather
// than an inline onclick, so no unsafe-hashes exemption is needed. The sheet carries only PUBLIC
// fingerprints; no private key material is placed into the HTML (see the NO-CUSTODY assertion in
// recoverySheetHTML).
//
// G077: a browser that refuses the blob tab now says so and reports a closed-class capability fault into the
// support pack, instead of leaving the operator looking at a tab that never opened.
export function openRecoverySheetWith(result: CeremonyResult, custody?: CustodyMetadata): boolean {
  const opened = openHtmlTab(recoverySheetHTML(result, sheetParams(result, custody)), "recovery-sheet");
  if (!opened) {
    toast({ tone: "warn", message: "Your browser would not open the recovery sheet. Download recovery-sheet.txt instead, or allow this site to open new tabs." });
  }
  return opened;
}

// downloadCeremonyFiles delivers the five (or six, with an operational key) ceremony files. identity.key is
// the break-glass private the operator keeps OFFLINE; it is never sent anywhere. Each is a local blob
// download, the visible evidence that the private key materialised locally rather than via an upload.
//
// G077: it returns the names of the files the browser REFUSED, and it keeps going after a refusal rather
// than abandoning the rest of the burst. A refusal on the first file used to throw out of the middle of the
// ceremony: the remaining files were never offered, and the throw landed in the ceremony's own catch, which
// told the operator their keys could not be generated when the keys existed and only the DELIVERY had
// failed. The caller now names the files that did not arrive and offers them again, and each refusal is a
// closed-class capability fault in the pack. The names returned are product constants, and they are used
// only to word the on-screen message; nothing about a file's CONTENT is read, held or recorded.
export function downloadCeremonyFiles(result: CeremonyResult): string[] {
  // Each file carries the SURFACE it belongs to. Five of them are the key ceremony itself, and losing any of
  // them (identity.key above all) is a recoverability failure. The sixth, the recovery sheet, holds only public
  // fingerprints, so a browser that refuses it costs the customer a printable record and not their backups.
  // Those are different tickets, so they are different rows.
  const files: Array<[string, string, ClientDiagSurface]> = [
    ["identity.key", identityFile(result.breakGlass), "key-ceremony"],
    ["recipient.pub", recipientFile(result.breakGlass), "key-ceremony"],
    ...(result.operational ? ([["operational.pub", recipientFile(result.operational), "key-ceremony"]] as Array<[string, string, ClientDiagSurface]>) : []),
    ["signer.pub", signerPublicFile(result.signer), "key-ceremony"],
    ["signer.key", signerPrivateFile(result.signer), "key-ceremony"],
    ["recovery-sheet.txt", recoverySheet(result, sheetParams(result)), "recovery-sheet"],
  ];
  const refused: string[] = [];
  for (const [name, content, surface] of files) {
    // deliverFile is total (it never throws), so one refusal cannot abandon the files after it. The per-file
    // toast is skipped here: a burst of refusals is ONE fault to state, which the caller does.
    if (!deliverFile(name, content, "text/plain", surface)) refused.push(name);
  }
  return refused;
}

// downloadText delivers one file through the guarded primitive and returns whether the browser accepted it.
// On a refusal it says so, because a recovery file that never arrived is the failure the operator must not
// discover months later, when they need it (G077).
export function downloadText(name: string, content: string, surface: ClientDiagSurface): boolean {
  const delivered = deliverFile(name, content, "text/plain", surface);
  if (!delivered) {
    toast({ tone: "warn", message: `Your browser did not save ${name}. Check its download settings, then use the Re-download control.` });
  }
  return delivered;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// The carousel chrome (the deck's action row, eyebrow and per-card navigation)
// ============================================================================

// The chapter labels shown on the progress rail.
export const OB_CHAPTERS = ["Connect", "Your keys", "Configure", "Your team", "Ready"] as const;

// The carousel's per-card navigation handle, handed to each card's mount.
export interface CarouselNav {
  advance(): void;     // the sanctioned forward move (a card's own primary); bypasses the gate
  back(): void;        // one card back
  markPassed(): void;  // a gated card calls this when its action completes, so the chevron/arrow also unlock
}

export interface CardDef {
  id: string;
  chapter: number;
  gate?: boolean;      // forward via chevron/arrow/Next is locked until the card calls markPassed()
  heroTone?: "ok";     // when "ok", the chassis applies the ok-toned hero styling to this card
  custody: string;     // the per-card trust line shown in the top bar
  nudge?: string;      // the message shown when a locked forward move is attempted
  mount(host: HTMLElement, nav: CarouselNav): void;
  // onShow runs each time the operator RETURNS to an already-mounted card (the deck mounts each card
  // exactly once and never re-mounts, so a stateful card must re-sync itself here). A key-ceremony card
  // implements it as a rebuild (clear + mount) so a generate / "replace keys" round-trip reads the live
  // store rather than a frozen spinner or stale key material. Absent for the static informational cards.
  onShow?(host: HTMLElement, nav: CarouselNav): void;
}

// Deep links use the old :step names; map each to the card the carousel should open on.
export const STEP_TO_CARD: Record<string, string> = {
  connect: "welcome",
  ceremony: "keys-intro",
  configure: "install",
  invite: "team",
  readiness: "readiness",
};

// cardActions builds the standard bottom action row for a card: a quiet Back on the left, an
// optional secondary, and the primary on the right. Returns the primary so a gated card can
// enable it later. Mirrors the old navRow contract (disabled-with-visible-reason) in the deck.
export function cardActions(opts: {
  nav: CarouselNav;
  showBack?: boolean;
  secondary?: { label: string; onClick: () => void };
  primary?: { label: string; onClick: () => void; enabled?: boolean; reason?: string; icon?: string };
}): { row: HTMLElement; primaryBtn: HTMLButtonElement | null } {
  const row = h("div", { class: "cx-card__actions" });
  if (opts.showBack !== false) {
    row.appendChild(
      h("button", { "data-dp": "onboarding.button.back#2", class: "cx-back", type: "button", on: { click: () => opts.nav.back() } }, svgIcon(ICON_CHEVRON_LEFT, { size: 16 }), "Back"),
    );
  }
  row.appendChild(h("span", { class: "cx-spacer" }));
  if (opts.secondary) {
    const s = opts.secondary;
    row.appendChild(h("button", { "data-dp": "onboarding.button.click", class: "btn btn--ghost", type: "button", on: { click: () => s.onClick() } }, s.label));
  }
  let primaryBtn: HTMLButtonElement | null = null;
  if (opts.primary) {
    const p = opts.primary;
    const enabled = p.enabled !== false;
    const btn = h(
      "button",
      { "data-dp": "onboarding.button.card-actions",
        class: "btn btn--primary btn--lg",
        type: "button",
        ...(enabled ? {} : { disabled: true, "aria-disabled": "true", ...(p.reason ? { title: p.reason } : {}) }),
      },
      ...(p.icon ? [svgIcon(p.icon, { size: 16 })] : []),
      p.label,
    ) as HTMLButtonElement;
    // The click listener is ALWAYS attached; a disabled button never fires it. A gated card
    // therefore enables later via enableGatedPrimary without re-wiring, so it cannot double-fire.
    //
    // THIS CARD KEEPS `disabled` AND IT IS THE RIGHT CALL HERE, which is worth saying because the
    // rest of the console moved off it. `btn.disabled` is not decoration on this control, it is the
    // runtime guard the always-attached listener reads, and the gate flips mid-session through
    // enableGatedPrimary / disableGatedPrimary. Swapping it for aria-disabled would leave the listener
    // live behind an announcement, which is not a refusal.
    //
    // It costs a customer nothing, because the reason is ALREADY reachable without a mouse: the
    // .cx-gate-reason span below is visible text beside the button. The aria-disabled written above is
    // the one thing here that does not work, and it cannot: `disabled` takes the control out of the
    // tab order, so the ARIA state is announced to nobody. It is kept only because removing it would
    // be a change with no reader either way.
    btn.addEventListener("click", () => { if (!btn.disabled) p.onClick(); });
    primaryBtn = btn;
    row.appendChild(btn);
    if (!enabled && p.reason) row.appendChild(h("span", { class: "field__hint cx-gate-reason" }, p.reason));
  }
  return { row, primaryBtn };
}

// enableGatedPrimary flips a gated card's primary from disabled to active and removes its
// disabled-reason hint. The listener is already wired by cardActions, so this never re-wires
// (no double advance). Idempotent: a no-op once already enabled.
export function enableGatedPrimary(primaryBtn: HTMLButtonElement | null): void {
  if (!primaryBtn || primaryBtn.disabled === false) return;
  primaryBtn.disabled = false;
  primaryBtn.removeAttribute("aria-disabled");
  primaryBtn.removeAttribute("title");
  const reason = primaryBtn.parentElement?.querySelector(".cx-gate-reason");
  if (reason) reason.remove();
}

// disableGatedPrimary is enableGatedPrimary's counterpart for a card whose gate can re-lock
// (prereqs is the only one): it restores the exact disabled-with-visible-reason shape
// cardActions first rendered (disabled, aria-disabled, title and the .cx-gate-reason hint),
// so a re-locked primary never reads as a bare unexplained disabled control. Idempotent: a
// no-op once already disabled, and it never appends a second hint.
export function disableGatedPrimary(primaryBtn: HTMLButtonElement | null, reason: string): void {
  if (!primaryBtn || primaryBtn.disabled) return;
  primaryBtn.disabled = true;
  primaryBtn.setAttribute("aria-disabled", "true");
  primaryBtn.setAttribute("title", reason);
  const row = primaryBtn.parentElement;
  if (row && !row.querySelector(".cx-gate-reason")) {
    row.appendChild(h("span", { class: "field__hint cx-gate-reason" }, reason));
  }
}

// The eyebrow line: an uppercase chapter label, optionally prefixed with a done check.
export function cardEyebrow(label: string, done = false): HTMLElement {
  return done
    ? h("p", { class: "cx-eyebrow" }, svgIcon(ICON_CHECK, { size: 13 }), "Done")
    : h("p", { class: "cx-eyebrow" }, label);
}
