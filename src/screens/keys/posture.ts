// The Posture tab of the Keys and break-glass screen (the default tab and the trust anchor): the presence
// posture read (from GET /admin/status; presence is the binding being set, never that the value works), the
// key ceremony entry and result (the ceremony runs in THIS browser; the break-glass private is only ever
// offered as the downloaded identity.key, with deliberately no command and no field that puts it on the
// engine), the no-CLI wiring block (the engine writes its own secrets from a one-shot token), and the strict
// break-glass-only posture switch. It imports the shared leaf (./shared.ts) and the add-operational entry
// (./add-operational.ts, split out to keep this file under its length budget), so it never imports another
// TAB module (which would form a cycle).
//
// NO-CUSTODY: the break-glass PRIVATE is generated here and never sent anywhere; the signer private (the one
// private the engine legitimately holds) is concealed behind a reveal toggle.

import type { ConfigRecipientOutcome, EngineClient, RunlogHandoverSummary, StatusReport } from "../../api.ts";
import { codeBlock, keyField } from "../../components/code-block.ts";
import { renderCustodyStep } from "../../components/custody-step.ts";
import { blockError, engineAnswered, errorDetail, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge, type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { type CeremonyResult, identityFile, isCeremonyResult, recipientFile, runKeyCeremony, signerPublicFile } from "../../keygen.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import type { CustodyMetadata } from "../../lib/custody.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL, ICON_LOCK, ICON_REFRESH } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { engineHoldsUsableOperationalKey } from "../../lib/operational-key-posture.ts";
import { POSTURE_ACK_STATEMENTS, type PostureChoice } from "../../lib/posture-ack-statements.ts";
import { clearSensitiveState, getCeremony, getCeremonyRekey, setCeremony } from "../../lib/store.ts";
import { recoverySheet } from "../../recovery-sheet.ts";
import { canDo, collapsedSection, gateReason, refuseWithReason } from "../common.ts";
import { renderAddOperationalEntry } from "./add-operational.ts";
import { needsConfigKeys, renderAddConfigKeysEntry } from "./config-keys.ts";
import { renderPostureSwitch } from "./posture-switch.ts";
import {
  commandWithValue,
  downloadText,
  fpRow,
  legendCol,
  openRecoverySheetWith,
  renderTokenApply,
  sheetParams,
} from "./shared.ts";

// renderPostureTab is the default tab: the presence posture, the ceremony entry/result ((re)generate
// the key set), and the break-glass-only posture switch (the in-console fulfilment of the onboarding
// "switch later on the Keys screen" promise).
export function renderPostureTab(engine: EngineClient): HTMLElement {
  const wrap = h("div");
  wrap.appendChild(renderPosture(engine));
  const raw = getCeremony();
  const existing: CeremonyResult | null = isCeremonyResult(raw) ? raw : null;
  // Thread the PERSISTED rekey intent (getCeremonyRekey) into the result render, never a bare default: on
  // a re-render of an in-memory ceremony (a bfcache pageshow re-render, or any re-entry to this tab) a
  // deliberate, warned re-key would otherwise lose confirmRekey and the engine would refuse the install,
  // forcing the owner to start the warned re-key again. The engine still refuses a silent overwrite, so
  // this only ever restores the confirmRekey the owner was already warned about at generate time.
  if (existing) wrap.appendChild(renderCeremonyResult(engine, existing, getCeremonyRekey()));
  else wrap.appendChild(renderCeremonyEntryOrAddOperational(engine));
  wrap.appendChild(renderPostureSwitch(engine));
  wrap.appendChild(renderPostureAcknowledgement(engine));
  return wrap;
}

// renderPostureAcknowledgement is the RE-AFFIRMATION surface: the only way an existing customer can put a
// posture acceptance on the record.
//
// The engine defines a "keys-rekey" acknowledgement channel alongside "onboarding" (posture-ack-statements.ts).
// This surface is the only place besides the onboarding fork that can capture it, so it covers three
// populations the onboarding fork cannot reach: an engine stood up with scripts/deploy.sh, which installs the
// operational pair without any acknowledgement at all; a returning operator, because the onboarding fork
// correctly refuses to force a choice against a posture that is already fixed and records nothing on that
// path; and every customer of a future statement version, because a bumped statement needs somewhere to be
// accepted.
//
// It is deliberately quiet (a collapsed section, calm-density budget): most operators never need it, and it
// must not read as an outstanding task on a healthy estate. It states the posture the ENGINE reports rather
// than one the operator picks, so this can never be used to record a posture that is not in force.
function renderPostureAcknowledgement(engine: EngineClient): HTMLElement {
  const body = h("div");
  const card = h("div", { class: "card measure" }, collapsedSection("Record your key-posture acknowledgement", body));

  function load(): void {
    body.replaceChildren(skeletonRows(1));
    void engine
      .status()
      .then((s: StatusReport) => body.replaceChildren(ackBody(engine, engineHoldsUsableOperationalKey(s))))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the acknowledgement body is a skeleton until this replaces it.
          body.replaceChildren(sessionEnded(() => load()));
          goSignedOut();
          return;
        }
        body.replaceChildren(blockError(err, () => load()));
      });
  }

  load();
  return card;
}

// ackBody renders the statement in force for the posture the engine actually reports, and records it. The
// posture is NOT an operator choice here: this surface evidences what is already true, and offering a
// picker would let someone record an acceptance of a posture their engine is not in.
function ackBody(engine: EngineClient, operationalPresent: boolean): HTMLElement {
  const posture: PostureChoice = operationalPresent ? "operational" : "break-glass-only";
  const stmt = POSTURE_ACK_STATEMENTS[posture];
  const wrap = h("div", { class: "stack-sm" });
  wrap.appendChild(
    h("p", { class: "field__hint" },
      "Your engine reports the ",
      h("strong", operationalPresent ? "operational key" : "offline key only"),
      " posture. Confirming records the posture, the statement version and a hash of these exact words in your tamper-evident audit log, under your signed-in identity. It changes nothing about your keys.",
    ),
  );
  wrap.appendChild(h("blockquote", { class: "field__hint", style: "margin:0;padding-left:var(--space-3);border-left:2px solid var(--border)" }, stmt.text));

  const outcome = h("p", { class: "field__hint", style: "margin:0" });
  const check = h("input", { type: "checkbox", id: "posture-ack-understood" }) as HTMLInputElement;
  const btn = h("button", { "data-dp": "keys.button.ack-body", class: "btn btn--secondary btn--sm", type: "button", disabled: true }, "Record this acknowledgement") as HTMLButtonElement;
  check.addEventListener("change", () => { btn.disabled = !check.checked; });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const ack = await engine.acknowledgePosture({ posture, statementVersion: stmt.version, acknowledgedText: stmt.text, channel: "keys-rekey" });
    if (ack.ok) {
      outcome.replaceChildren(badge("ok", "Recorded in your audit log", { dot: true }));
      toast({ message: "Key-posture acknowledgement recorded." });
      return;
    }
    // Honest failure. Only a refused STATEMENT (an unknown version, or words that differ from the engine's) is
    // console/engine version skew, and there the fix is to update, not retry. Every other failure (a rate
    // limit, a role refusal, a lost connection) shows its reason: the engine's own text when it sent one,
    // else the status or the console's transport-fault line. Telling the operator to update would send them
    // to fix the wrong thing.
    outcome.textContent = ack.statementRefused
      ? "The engine did not record it. If your console and engine are on different versions, update them and try again."
      : `The engine did not record it: ${ack.reason ?? "no reason was given"}.`;
    btn.disabled = false;
  });

  wrap.appendChild(h("div", { class: "checkbox-row" }, check, h("label", { for: "posture-ack-understood" }, "I have read the statement above and understand my choice.")));
  wrap.appendChild(h("div", { style: "display:flex;align-items:center;gap:var(--space-3)" }, btn, outcome));
  return wrap;
}

// ---- Posture (presence-only, from GET /admin/status) --------------------------

function renderPosture(engine: EngineClient): HTMLElement {
  const card = h("div", { class: "card measure" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Current engine posture"),
    ),
  );
  card.appendChild(
    h("p", { class: "field__hint" },
      h("strong", "present"),
      " means the binding is set, not that the value works.",
    ),
  );
  const host = h("div");
  card.appendChild(host);

  function loadPosture(): void {
    host.replaceChildren(skeletonRows(1));
    void engine
      .status()
      .then((s: StatusReport) => host.replaceChildren(postureBody(s)))
      .catch((err) => {
        // A 401 routes to the signed-out screen (the session is invalid, not a transient
        // engine fault). Every other error is a transport/auth fault: render as a blockError
        // with Retry so the operator sees a specific, actionable message and the
        // CONSOLE_ORIGIN diagnostic when CORS is the root cause. Operator input on the rest
        // of the screen (the ceremony, wiring block) is unaffected.
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the posture body is a skeleton until this replaces it.
          host.replaceChildren(sessionEnded(() => loadPosture()));
          return goSignedOut();
        }
        // Classify to decide whether to surface the CONSOLE_ORIGIN hint. A fetch failure
        // with no status is the CORS/CONSOLE_ORIGIN footgun; pass the origin so blockError
        // can name the value the operator must set.
        const kind = classifyError(err, { origin: location.origin });
        const opts = kind.kind === "console-origin" ? { origin: location.origin } : {};
        host.replaceChildren(blockError(err, () => loadPosture(), opts));
      });
  }

  loadPosture();
  return card;
}

// postureReadyRow is the engine version + readiness summary line (the first row of postureBody),
// pulled out so the body stays under the function-length budget.
function postureReadyRow(s: StatusReport): HTMLElement {
  const readyTone: StatusTone = s.ready ? "ok" : "neutral";
  const readySummary = h("div", {
    class: "posture-ready-row",
    style: "display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-4)",
  });
  readySummary.appendChild(statusWithLabel(readyTone, s.ready ? "Engine ready" : "Engine not ready"));
  const verEl = h("span", { class: "field__hint" });
  // textContent: server-supplied string, set safely
  verEl.textContent = `Version: ${s.engineVersion}`;
  readySummary.appendChild(verEl);
  if (s.destKind) {
    const dkEl = h("span", { class: "field__hint" });
    dkEl.textContent = `Destination: ${s.destKind}`;
    readySummary.appendChild(dkEl);
  }
  return readySummary;
}

// postureMeaningDisclosure is the per-key teaching, demoted behind ONE disclosure so the standing
// card carries the five reads, not ninety words of prose on every visit.
function postureMeaningDisclosure(s: StatusReport): HTMLElement {
  return h(
    "details",
    { class: "disclosure", style: "grid-column:1/-1" },
    // The shared h2.disclosure__heading (the collapsedSection pattern) keeps the summary at
    // heading weight and in the document outline, not small bare text.
    h("summary", h("h2", { class: "disclosure__heading" }, "What do these mean?")),
    h(
      "div",
      { class: "disclosure__body", style: "display:grid;gap:var(--space-1)" },
      meaningRow("Signer", "the private key the engine signs runs with; it cannot decrypt archives. Required for engine ready."),
      meaningRow("Break-glass public", "the engine can wrap archive keys to this public key but never unwrap. Required for engine ready."),
      meaningRow("Operational key (public)", "the read-back recipient new runs are wrapped to."),
      meaningRow("Operational key (private)", "the UNATTENDED-proof key: present, and not retired by a break-glass-only choice, means the engine can run scheduled restore tests, automated drills and in-account retention pruning on its own. Absent, or retired though still bound, is strict break-glass-only custody. Verify-at-seal and the canary still run in-account with no key, and an in-console restore still works with your break-glass key supplied to the browser; what stops is the unattended work."),
      meaningRow("Destination", s.destKind ? `destination kind: ${s.destKind}.` : "no destination kind reported yet."),
    ),
  );
}

function postureBody(s: StatusReport): HTMLElement {
  const wrap = h("div", { class: "posture-grid" });

  wrap.appendChild(postureReadyRow(s));

  wrap.appendChild(presenceRow("Signer", s.signerConfigured));
  wrap.appendChild(presenceRow("Break-glass public", s.breakGlassConfigured));
  wrap.appendChild(presenceRow("Operational key (public)", s.operationalConfigured.public));
  wrap.appendChild(presenceRow("Operational key (private)", s.operationalConfigured.private));
  wrap.appendChild(presenceRow("Destination", s.destConfigured));

  wrap.appendChild(postureMeaningDisclosure(s));

  const usable = engineHoldsUsableOperationalKey(s);
  const recovery: StatusTone = usable ? "ok" : "info";
  const recoveryLabel = usable
    ? "two-recipient (in-account read-back available)"
    : "break-glass-only (highest-assurance posture: the engine cannot self-decrypt archives)";
  wrap.appendChild(
    h("div", { class: "posture-mode", style: "grid-column:1/-1;margin-top:var(--space-3)" },
      statusWithLabel(recovery, `Recovery mode: ${recoveryLabel}`),
    ),
  );

  // Downpipe count: informational.
  const dpEl = h("div", { class: "field__hint", style: "margin-top:var(--space-2)" });
  dpEl.textContent = `Downpipes configured: ${s.downpipeCount}`;
  wrap.appendChild(dpEl);

  return wrap;
}

function presenceRow(label: string, present: boolean): HTMLElement {
  // Presence is not validity: this reports the env var is SET / the binding is bound,
  // never that the value parses or verifies (current-state.md 2).
  return h(
    "div",
    { class: "posture-row" },
    statusWithLabel(present ? "ok" : "neutral", `${label}: ${present ? "present" : "not present"}`),
  );
}

// meaningRow is one line of the "What do these mean?" disclosure (the per-key teaching
// demoted from the standing presence rows).
function meaningRow(label: string, note: string): HTMLElement {
  return h("p", { class: "field__hint", style: "margin:0" }, h("strong", `${label}: `), note);
}

// ---- Key ceremony (entry point and result) ------------------------------------

// PostureRead: the estate's current posture, when known, before the operator touches the checkbox. "operational" (two-recipient), "strict" (break-glass-only, or a fresh install), "unknown" (the status read failed).
type PostureRead = "operational" | "strict" | "unknown";

// renderPostureChoice is the checkbox deciding whether "Generate keys" also makes an operational key. It sits in view, before the Generate keys control, and its starting state follows the estate's current posture: a two-recipient estate (an operational key already present) starts UNTICKED, so an untouched re-key installs a fresh operational pair and the estate stays two-recipient, with a new key rather than the old one. Ticking it removes the pair instead: the engine sets the break-glass-only marker and deletes both operational secrets. A break-glass-only estate and a fresh install start TICKED, matching strict custody's documented default; an unread posture also starts TICKED, with a line saying the read failed.
//
// What the operational key buys is the UNATTENDED work: scheduled restore tests, automated drills and in-account retention pruning, each of which needs a key at a moment when nobody is present to supply one. It is NOT what makes the archives verified. Verify-at-seal reaches the same keyed tier from the run's own per-run key while the seal path still holds it, and the canary runs with no skipped checks, so a strict estate is continuously proven in-account. An in-console restore also still works, with the break-glass key supplied to the browser and wiped after. Saying otherwise here is not a wording preference: this copy is read at the moment the posture is CHOSEN, and overstating the cost pushes a customer away from the stricter posture for a reason that stopped being true. Returns the checkbox so the caller reads its checked state at generate.
function renderPostureChoice(current: PostureRead): { container: HTMLElement; disclosure: HTMLElement; strictCheck: HTMLInputElement } {
  // The element id stays fixed: the field catalogue, the census and the harness mirrors key on it.
  const strictCheck = h("input", { type: "checkbox", id: "ceremony-strict", checked: current !== "operational" }) as HTMLInputElement;

  const unknownNote = current === "unknown"
    ? [h("p", { class: "field__hint", style: "margin:0" }, "Your engine's current posture could not be read, so strict custody is selected.")]
    : [];
  const container = h(
    "div",
    { class: "stack-sm" },
    h("div", { class: "checkbox-row" }, strictCheck, h("label", { for: "ceremony-strict" }, "Keep strict custody: no operational key (reopening a past run then needs you present)")),
    ...unknownNote,
  );

  const disclosure = h(
    "details",
    { class: "disclosure" },
    // The shared h2.disclosure__heading, as above: the summary is a section heading.
    h("summary", h("h2", { class: "disclosure__heading" }, "Key posture: strict break-glass-only custody (no key in the engine that can read an archive)")),
    h(
      "div",
      { class: "disclosure__body" },
      h(
        "p",
        { class: "field__hint" },
          "Without it the live engine can never read an archive on its own, even if fully compromised. Your engine still verifies every run as it seals it, unless the VERIFY_AT_SEAL override turns that off, and the canary, while it is on, still proves the write, seal, read, decrypt and restore path against its own test data (hourly by default). What stops is anything that reopens a run the engine sealed EARLIER with nobody present: scheduled restore tests, drills and retention pruning, so storage grows until you prune with your break-glass key in this console. Restoring from this console keeps working, with you present and supplying your break-glass key in the browser, and you prove past runs restorable the same way at an attended verification. Your engine also keeps its own configuration recovery: the config export is sealed to a dedicated key that opens that export and nothing else, installed in either posture, so a wiped engine still auto-recovers its configuration with no key present that can read an archive.",
      ),
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
        // This line must not claim posture is fixed at generation, or that changing it means re-keying, a new
        // key set, every secret re-applied, and a fresh recovery sheet. All four clauses are false against this
        // same file: renderAddOperationalEntry
        // (below) writes ONLY the operational pair over POST /admin/keys/add-operational and states "No new
        // identity.key is needed", and posture-switch.ts removes it over POST /admin/keys/break-glass-only with no
        // keygen at all. Pricing the safe option as the expensive one at the moment of choice would be exactly
        // backwards: keeping strict custody now is the reversible direction, and the operational
        // key is the one whose effect on already-sealed archives cannot be taken back.
        "Keeping strict custody now does not lock you in: the Keys screen can add an operational key later without a re-key, and your break-glass key and identity.key stay the ones you already have. The reverse is the direction that does not fully undo, because archives sealed while an operational key was present stay readable by it.",
      ),
      // Group-level doc link for this opt-out control: the page that sets out the
      // strict break-glass-only posture in full, what it removes and what it costs.
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/concepts/recovery-postures#strict-break-glass-only", target: "_blank", rel: "noreferrer noopener" },
        "About strict break-glass-only custody",
        svgIcon(ICON_EXTERNAL, { size: 13 }),
      ),
    ),
  );
  return { container, disclosure, strictCheck };
}

// runCeremonyAndRender runs the browser-only key ceremony (no-custody, async post-quantum keygen),
// auto-downloads ONLY identity.key (the one save-or-lose file; a six-file burst tripped browser
// multi-download blocking and left no way to refetch), and swaps the entry card for the result card.
// A failure restores the button and shows the reason in place. Pulled out of renderCeremonyEntry so
// the entry stays under the function-length budget.
async function runCeremonyAndRender(
  engine: EngineClient,
  card: HTMLElement,
  generateBtn: HTMLButtonElement,
  progress: HTMLElement,
  strictCheck: HTMLInputElement,
  rekey: boolean,
): Promise<void> {
  generateBtn.dataset.busy = "true";
  generateBtn.textContent = "Generating in this browser";
  generateBtn.disabled = true;
  progress.replaceChildren(
    h("p", { class: "field__hint" }, "Generating the hybrid keys in this browser."),
  );
  try {
    const result = await runKeyCeremony({ operational: !strictCheck.checked });
    // Persist the rekey intent WITH the ceremony (not only in this closure) so a later re-render of the
    // result card threads the same confirmRekey back; a fresh estate stores false.
    setCeremony(result, rekey);
    downloadText("identity.key", identityFile(result.breakGlass), "text/plain", "key-ceremony");
    const fresh = renderCeremonyResult(engine, result, rekey);
    card.replaceWith(fresh);
    toast({ message: "Keys generated in this browser. Save identity.key offline." });
  } catch (err) {
    // A browser that cannot generate a key pair produces NO KEY MATERIAL AT ALL: there is nothing to
    // download, nothing to save, and no backup taken afterwards could ever be recovered. This failure is
    // reported so a support pack from a locked-down browser carries evidence of the most consequential
    // failure the console has. The reporter takes no error, so the message below stays on the screen where
    // the operator needs it and never enters the pack.
    reportKeygenFault("key-ceremony");
    generateBtn.dataset.busy = "false";
    generateBtn.textContent = "Generate keys";
    generateBtn.disabled = false;
    progress.replaceChildren(
      h("p", { class: "field__error" }, `Key generation failed in the browser (${err instanceof Error ? err.message : String(err)}). Nothing was sent anywhere.`),
    );
  }
}

// renderCeremonyEntryOrAddOperational decides, from the LIVE engine status, which card a returning owner
// with no ceremony in memory should see (see pickReturningOwnerCard for the three-way choice). A status-read
// fault fails safe to the state-blind first-time card rather than blocking the tab: the engine's own already-
// present guard on POST /keys/install is the backstop, so a re-key attempted from that fallback card without
// the confirmRekey flag is refused server-side rather than silently overwriting the signer.
function renderCeremonyEntryOrAddOperational(engine: EngineClient): HTMLElement {
  const host = h("div");
  host.appendChild(skeletonRows(1));
  void engine
    .status()
    .then((s: StatusReport) => {
      // An engine keyed without its configuration keys gets the targeted add FIRST, whatever its posture:
      // it closes a gap in the keys the engine already has, and it never touches the signer.
      const configCard = needsConfigKeys(s) ? [renderAddConfigKeysEntry(engine, s)] : [];
      host.replaceChildren(...configCard, pickReturningOwnerCard(engine, s));
    })
    .catch((err) => {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: this host is a skeleton and nothing later replaces it. There is no
        // reload to offer (the read is issued once, at build time), so the sentence stands alone.
        host.replaceChildren(sessionEnded());
        goSignedOut();
        return;
      }
      // Fail safe to the state-blind first-time card (the engine guard backstops a re-key from here).
      host.replaceChildren(renderCeremonyEntry(engine, { rekey: false, currentPosture: "unknown" }));
    });
  return host;
}

// pickReturningOwnerCard chooses the entry card from the LIVE status. A fully two-recipient estate must never
// fall through to the generic, state-blind renderCeremonyEntry with no signal that "Generate
// keys" would REISSUE the signer and break signature verification of every prior run receipt.
//   1. break-glass-only (signer + break-glass present, operational.private absent) -> the targeted
//      renderAddOperationalEntry card: it installs ONLY an operational key and never touches the signer.
//   2. ANY OTHER estate that ALREADY HAS A SIGNER (a fully two-recipient estate, or a half-keyed one) -> the
//      ceremony card in RE-KEY mode: it renders the signer-continuity warning BEFORE the generate control and
//      confirms the deliberate re-key to the engine (so a silent overwrite is impossible, but the warned
//      re-key still succeeds).
//   3. a genuinely signer-less estate (a fresh engine, or a demo reset that masks the persisted secret) -> the
//      unqualified first-time ceremony card, unchanged.
function pickReturningOwnerCard(engine: EngineClient, s: StatusReport): HTMLElement {
  if (s.signerConfigured && s.breakGlassConfigured && !s.operationalConfigured.private) return renderAddOperationalEntry(engine, () => renderCeremonyEntry(engine, { rekey: true, currentPosture: "strict" }));
  if (s.signerConfigured) return renderCeremonyEntry(engine, { rekey: true, currentPosture: engineHoldsUsableOperationalKey(s) ? "operational" : "strict" });
  return renderCeremonyEntry(engine, { rekey: false, currentPosture: "strict" });
}

// rekeyContinuityWarning is the signer-continuity warning the re-key path shows before "Generate keys": on an
// estate that ALREADY has a signer, a new key set ROTATES the signer, so every run signed by the current
// signer stops verifying through this console. Warn-tinted, role="note" (static mount-time content, not an
// alert), never shouting: the same pattern the break-glass rotation card uses for its archive-continuity
// warning. Its presence gives a fully-two-recipient estate the "signer already present" awareness it needs
// before generating a new key set.
function rekeyContinuityWarning(): HTMLElement {
  const box = h("div", {
    class: "card card--warn",
    role: "note",
    style: "margin-top:var(--space-4);border-color:var(--warn);background:var(--warn-bg)",
  });
  box.appendChild(
    h("p", { style: "font-weight:var(--weight-semibold)" },
      "Your engine already has a signer, so generating a new key set will rotate the signer.",
    ),
  );
  box.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "A new key set reissues your signer and your break-glass key. Every run signed by your current signer then stops verifying through this console; you verify those earlier runs with the offline reader and the matching old signer.pub instead. You also get a new identity.key to save offline. Most returning owners do not want to re-key.",
    ),
  );
  box.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "Your configuration recovery key and your configuration wrap key do not change. To get new configuration keys, deploy a new engine.",
    ),
  );
  return box;
}

// renderCeremonyEntry is the first-time ceremony card. When opts.rekey is set (an estate that already has a
// signer), it renders the signer-continuity warning before the generate control and threads the flag through
// to the install so it carries confirmRekey: the engine allows this DELIBERATE, warned re-key while still
// refusing a silent one. opts.rekey defaults false, so a fresh estate reads exactly as before. Exported for
// add-operational.ts's "run the full re-key instead" escape hatch, the one caller outside this file.
export function renderCeremonyEntry(engine: EngineClient, opts: { rekey: boolean; currentPosture?: PostureRead } = { rekey: false }): HTMLElement {
  const card = h("div", { class: "card card--warn measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Key ceremony"),
      badge("trust", "Trust anchor"),
    ),
  );

  // The re-key continuity warning renders BEFORE the generate control, so a fully two-recipient estate
  // always gets this signal before it can act.
  if (opts.rekey) card.appendChild(rekeyContinuityWarning());

  card.appendChild(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "The break-glass key is generated here, in your browser. The private half is the only recovery key you keep, and it is never sent to the engine or the vendor. If you lose it, your backups cannot be recovered unless your engine holds an operational key that opens them.",
    ),
  );

  const { container, disclosure, strictCheck } = renderPostureChoice(opts.currentPosture ?? "strict");
  card.appendChild(container);
  card.appendChild(disclosure);

  const ownerGate = canDo("owner");
  const generateBtn = h(
    "button",
    { "data-busy-label": "Generating in this browser", "data-dp": "keys.button.generate",
      class: "btn btn--primary",
      type: "button",
    },
    "Generate keys",
  ) as HTMLButtonElement;
  const progress = h("div");

  if (ownerGate) {
    generateBtn.addEventListener("click", () => void runCeremonyAndRender(engine, card, generateBtn, progress, strictCheck, opts.rekey));
  } else {
    refuseWithReason(generateBtn, gateReason("owner"));
  }

  card.appendChild(h("div", { style: "margin-top:var(--space-4)" }, generateBtn));
  // The gate reason rendered VISIBLY (a title attribute is hover-only and unreachable by
  // keyboard or touch); the title stays as a secondary cue.
  if (!ownerGate) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")));
  card.appendChild(progress);
  return card;
}

// custodyLegend is the no-custody legend, doubling as the PER-FILE download surface: each file reads
// from the in-memory ceremony result, so a blocked auto-download is never the only copy (only
// identity.key auto-downloads). Stays here / goes to the engine / goes nowhere makes the ABSENCE of
// any break-glass-private upload path visible.
//
// On a re-key (rekey true) the engine keeps its configuration keys (engine src/admin/attach.ts): the
// two configuration lines move out of "Goes to your engine" into their own "Not changed" column, so the
// legend never claims an install that does not happen. A first install (rekey false) states the real
// condition on each line instead of an unconditional install.
function custodyLegend(result: CeremonyResult, rekey: boolean): HTMLElement {
  const op = result.operational;
  const legend = h("div", { class: "custody-legend" });
  legend.appendChild(legendCol("Stays in this browser", [
    { label: "identity.key (break-glass private)", download: { name: "identity.key", content: () => identityFile(result.breakGlass) } },
    "the recovery sheet (buttons below)",
  ], "trust"));
  legend.appendChild(legendCol("Goes to your engine", [
    // The signer private is a plain label, not a download: it installs straight to the engine below, as the
    // operational private does. A signer.key file would leave a forgery-capable key on this machine.
    "SIGNER_PRIVATE, installs straight to your engine",
    { label: "recipient.pub", download: { name: "recipient.pub", content: () => recipientFile(result.breakGlass) } },
    // signer.pub belongs in BOTH columns by purpose. It stays here because the custody claim this legend
    // makes is about where key material travels, and this one does go to the engine. The label carries the
    // other half: offline verify and restore refuse to start without a pinned signer. From engine 0.3.7 the
    // bucket carries a copy the sheet's fingerprint can pin, but it is always the CURRENT signer's key, and a
    // bucket no such engine has written to has none. So a copy has to live in the offline kit, or an offline
    // restore of a run sealed before a later re-key is impossible.
    { label: "signer.pub (keep a copy in your offline kit too: a run sealed before a later re-key, or a bucket with no copy, cannot be restored without it)", download: { name: "signer.pub", content: () => signerPublicFile(result.signer) } },
    // Honest parity with the onboarding legend: list the operational PRIVATE (not just its
    // public half), since the default posture wires OPERATIONAL_PRIVATE, a decryption-capable
    // key, into the engine. The break-glass-only branch reinforces that the engine then holds
    // nothing that can decrypt. This is opt-OUT, not opt-in, so the copy must not imply the operator chose it.
    ...(op
      ? [
          { label: "operational.pub", download: { name: "operational.pub", content: () => recipientFile(op) } },
          "OPERATIONAL_PRIVATE, the read-back key; it can decrypt archives",
        ]
      : ["(no operational key, the engine holds nothing that can decrypt an archive)"]),
    // The configuration keys, made in both postures and never offered as files (keygen.ts CeremonyResult).
    // On a re-key they are not sent (see the "Not changed" column below).
    ...(rekey
      ? []
      : [
          "CONFIG_RECIPIENT_PRIVATE. It installs to your engine only if your engine does not hold one. It opens only the sealed configuration export of this engine. It cannot open an archive.",
          "CONFIG_WRAP_KEY. It installs to your engine only if your engine does not hold one. It encrypts the credentials that this console stores.",
        ]),
  ], "info"));
  if (rekey) {
    legend.appendChild(legendCol("Not changed", [
      "Your configuration recovery key and your configuration wrap key. Your engine keeps the keys that it holds. To get new configuration keys, deploy a new engine.",
    ], "trust"));
  }
  legend.appendChild(legendCol("Goes to the vendor", ["nothing"], "ok"));
  return legend;
}

function renderCeremonyResult(engine: EngineClient, result: CeremonyResult, rekey = false): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Keys generated"),
      badge("ok", "Ceremony complete"),
    ),
  );

  card.appendChild(custodyLegend(result, rekey));
  card.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "identity.key was downloaded automatically; fetch any file again from its row while this ceremony stays in memory.",
    ),
  );

  // The chosen custody scheme + custodian sign-off, tracked here so the recovery sheet
  // produced below carries the operator's selection (public metadata only). It starts
  // "undecided" and updates as the operator uses the custody step.
  let custodyMeta: CustodyMetadata = { scheme: "undecided", signoffs: [] };

  // The recovery sheet (public only; print-clean). Both buttons read the LIVE custodyMeta
  // so a sheet produced after the operator chooses a scheme records that scheme.
  card.appendChild(recoverySheetRow(result, () => custodyMeta));

  // The wiring block: the exact out-of-band wrangler commands. Each private value the
  // engine holds (the signer, the operational private in that posture and the two
  // configuration keys) is shown concealed (keyField). There is deliberately NO
  // command for the break-glass private key. Eager, because it is
  // the required next step (save files -> wire engine -> verify presence). rekey is
  // threaded so the install carries confirmRekey on a deliberate, warned re-key.
  card.appendChild(renderWiring(engine, result, rekey));

  // Reference and optional-step content demoted behind collapsed disclosures.
  for (const d of custodyDisclosures(result, engine, (meta) => { custodyMeta = meta; })) card.appendChild(d);

  // Clear in-memory key material on confirmed save: a button that drops the
  // ceremony from memory once the operator confirms the files are stored offline.
  card.appendChild(h("div", { style: "margin-top:var(--space-5)" }, memoryClearButton(engine, card)));

  return card;
}

// custodyDisclosures is the reference + optional-step content demoted behind collapsed disclosures,
// keeping the card to its eager-section budget: the fingerprints are a runbook reference, and
// the tiered offline custody split is an optional protection step. onMeta receives the chosen scheme +
// custodian sign-off so the recovery sheet records it (public metadata only).
function custodyDisclosures(result: CeremonyResult, engine: EngineClient, onMeta: (meta: CustodyMetadata) => void): HTMLElement[] {
  return [
    collapsedSection("Public key fingerprints", renderFingerprintSection(result)),
    collapsedSection(
      "Protect your break-glass key (optional)",
      // The tiered offline custody menu (blueprint 7.3), with the M-of-N split performed in-browser.
      // The downloadText adapter maps to this screen's local blob-download helper (no network). sendShare
      // wires the one sanctioned exception: emailing a single share via the operator's own engine (the
      // engine refuses gracefully if outbound email is not configured).
      renderCustodyStep({
        result,
        onChange: onMeta,
        // As in ./custody.ts: the "key-ceremony" surface tag is the client-diag evidence channel for a refused
        // or unavailable download, and sendShare is the custody-share email. Both sides are kept.
        downloadText: (name, content) => downloadText(name, content, "text/plain", "key-ceremony"),
        sendShare: (input) => engine.sendCustodyShare(input),
      }),
    ),
  ];
}

// recoverySheetRow renders the open + download recovery-sheet buttons. Both read the LIVE custodyMeta
// (via getMeta) so a sheet produced after the operator chooses a scheme records that scheme.
function recoverySheetRow(result: CeremonyResult, getMeta: () => CustodyMetadata): HTMLElement {
  const sheetBtn = h("button", { "data-dp": "keys.button.sheet", class: "btn btn--secondary btn--sm", type: "button" }, "Open printable recovery sheet");
  sheetBtn.addEventListener("click", () => openRecoverySheetWith(result, getMeta()));
  const downloadSheetBtn = h("button", { "data-dp": "keys.button.download-sheet", class: "btn btn--ghost btn--sm", type: "button" }, "Download recovery-sheet.txt");
  downloadSheetBtn.addEventListener("click", () => downloadText("recovery-sheet.txt", recoverySheet(result, sheetParams(result, getMeta())), "text/plain", "recovery-sheet"));
  return h("div", { class: "recovery-actions", style: "margin-top:var(--space-3)" }, sheetBtn, downloadSheetBtn);
}

// memoryClearButton drops the ceremony from memory once the operator confirms the files are stored
// offline, then re-renders the entry card in place.
function memoryClearButton(engine: EngineClient, card: HTMLElement): HTMLElement {
  const clearBtn = h(
    "button",
    { "data-dp": "keys.button.clear#1", class: "btn btn--secondary btn--sm", type: "button" },
    svgIcon(ICON_LOCK, { size: 14 }),
    "I have saved identity.key offline; clear it from memory",
  );
  clearBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Clear key material from memory",
      body: "Confirm you have saved identity.key (the break-glass private) to offline storage. This clears the in-memory key material in this browser tab. The downloaded files remain on your disk.",
      confirmLabel: "Clear from memory",
    });
    if (!ok) return;
    clearSensitiveState();
    toast({ message: "In-memory key material cleared." });
    // Re-render through the state-aware wrapper (not the state-blind first-time card): if the operator just
    // installed the keys, the engine now has a signer, so a further "Generate keys" from here is a re-key and
    // must show the continuity warning / route to the add-operational card, never the unqualified first-time card.
    const fresh = renderCeremonyEntryOrAddOperational(engine);
    card.replaceWith(fresh);
  });
  return clearBtn;
}

// renderFingerprintSection shows the public fingerprints from the ceremony result.
// Public fingerprints are safe to record and share; they are used to confirm the
// correct key is present on the engine after wiring. Never shows a private value.
// Rendered as a disclosure BODY (the collapsedSection summary carries the heading).
function renderFingerprintSection(result: CeremonyResult): HTMLElement {
  const wrap = h("div");
  wrap.appendChild(
    h("p", { class: "field__hint" },
      "Record these in your recovery sheet and runbook. They identify which key is present on the engine without revealing any private material.",
    ),
  );
  const fp = h("div", { class: "fingerprints", style: "margin-top:var(--space-3)" });
  fp.appendChild(fpRow("break-glass", result.breakGlass.fingerprint));
  if (result.operational) fp.appendChild(fpRow("operational", result.operational.fingerprint));
  fp.appendChild(fpRow("signer", result.signer.fingerprint));
  wrap.appendChild(fp);
  return wrap;
}

// presenceCheck builds the "Check engine for presence" button + its status line, and the closure that
// polls GET /admin/status for the signer + break-glass keys. The closure is returned so the token-apply
// onApplied can re-run it. Pulled out of renderWiring to keep that function under the length budget.
function presenceCheck(engine: EngineClient): { recheck: HTMLButtonElement; presence: HTMLElement; doCheck: () => Promise<void> } {
  const presence = h("span", { class: "field__hint", style: "margin-left:var(--space-2)", role: "status", "aria-live": "polite" });
  const recheck = h("button", { "data-dp": "keys.button.recheck", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, svgIcon(ICON_REFRESH, { size: 14 }), "Check engine for presence") as HTMLButtonElement;
  const doCheck = async (): Promise<void> => {
    presence.textContent = "Checking.";
    try {
      const s = await engine.status();
      const missing: string[] = [];
      if (!s.signerConfigured) missing.push("signer private");
      if (!s.breakGlassConfigured) missing.push("break-glass public");
      presence.textContent = missing.length === 0
        ? "The engine reports the signer and break-glass keys present."
        : `Not yet reported present: ${missing.join(", ")}. The engine can take a moment.`;
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: as above, "Checking." is only ever replaced here.
        presence.textContent = "Your session ended before the check finished. Sign in again to re-check.";
        return goSignedOut();
      }
      // As above: only a fetch that threw with no status at all is an unreachable engine.
      presence.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check presence.";
    }
  };
  recheck.addEventListener("click", () => void doCheck());
  return { recheck, presence, doCheck };
}

// wranglerFallbackSection is the IaC path for an operator who prefers Wrangler, kept deeply collapsed
// (never primary): it uses the operator's own Cloudflare login, so it needs no token.
//
// On a re-key (rekey true) the engine already holds CONFIG_RECIPIENT_PRIVATE, CONFIG_RECIPIENT_PUBLIC and
// CONFIG_WRAP_KEY (engine src/admin/router-keys.ts POST /keys/add-config-recovery refuses to replace one it
// holds). Wrangler has no such refusal, so these three commands, and the new values they would carry, are
// left out of the page entirely on this path: printing them would let an operator go around the engine's own
// guard, strand the configuration exports the engine sealed to the old recipient and make every stored
// credential unreadable under a new wrap key.
function wranglerFallbackSection(result: CeremonyResult, rekey: boolean): HTMLElement {
  const fallback = h("div", { class: "stack-sm" });
  fallback.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "wrangler uses your own Cloudflare login, so it needs no token. Run these from the engine directory. Each secret takes effect without a redeploy."));
  fallback.appendChild(codeBlock("npx wrangler secret put SIGNER_PRIVATE"));
  fallback.appendChild(keyField({ label: "SIGNER_PRIVATE value", value: result.signer.privateB64 }));
  fallback.appendChild(commandWithValue("npx wrangler secret put BREAK_GLASS_PUBLIC", result.breakGlass.recipientPublicB64));
  if (result.operational) {
    fallback.appendChild(commandWithValue("npx wrangler secret put OPERATIONAL_PUBLIC", result.operational.recipientPublicB64));
    fallback.appendChild(codeBlock("npx wrangler secret put OPERATIONAL_PRIVATE"));
    fallback.appendChild(keyField({ label: "OPERATIONAL_PRIVATE value", value: result.operational.identityB64 }));
  }
  if (rekey) {
    fallback.appendChild(
      h("p", { class: "field__hint", style: "margin:0" },
        "Do not set CONFIG_RECIPIENT_PRIVATE, CONFIG_RECIPIENT_PUBLIC or CONFIG_WRAP_KEY on an engine that holds them. A new configuration recovery key cannot open the configuration exports that your engine sealed before.",
      ),
    );
    fallback.appendChild(
      h("p", { class: "field__hint", style: "margin:0" },
        "A new configuration wrap key makes all stored credentials unreadable. To get new configuration keys, deploy a new engine.",
      ),
    );
  } else {
    // The configuration keys, as the in-console install writes them: the recovery private first, then its
    // public, then the wrap key. The two private values stay concealed like SIGNER_PRIVATE.
    fallback.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "Set the three CONFIG_ secrets only on an engine that does not hold them."));
    fallback.appendChild(codeBlock("npx wrangler secret put CONFIG_RECIPIENT_PRIVATE"));
    fallback.appendChild(keyField({ label: "CONFIG_RECIPIENT_PRIVATE value", value: result.configRecipient.identityB64 }));
    fallback.appendChild(commandWithValue("npx wrangler secret put CONFIG_RECIPIENT_PUBLIC", result.configRecipient.recipientPublicB64));
    fallback.appendChild(codeBlock("npx wrangler secret put CONFIG_WRAP_KEY"));
    fallback.appendChild(keyField({ label: "CONFIG_WRAP_KEY value", value: result.configWrapKeyB64 }));
  }
  return collapsedSection("Advanced: apply with Wrangler instead", fallback);
}

// installNote states the engine's OWN answer about the configuration keys (KeyInstallResult.configured)
// in one short sentence, truthfully for each outcome: "installed" needs no note (it is the plain
// success the button already reports); "kept" names which key or keys the engine already held; "repaired"
// says the engine completed a partial pair from the half it held; "kept-partial" says the engine still
// holds only half a pair and cannot complete it, and names the fix. Returns "" when nothing needs saying.
function installNote(configured: { configRecipient: ConfigRecipientOutcome; configWrapKey: "installed" | "kept" }): string {
  const wrapNote = configured.configWrapKey === "kept" ? " It kept its configuration wrap key." : "";
  switch (configured.configRecipient) {
    case "installed":
      return wrapNote === "" ? "" : `Keys installed.${wrapNote}`;
    case "kept":
      return wrapNote === ""
        ? "Keys installed. Your engine kept its configuration recovery key."
        : "Keys installed. Your engine kept its configuration recovery key and its configuration wrap key.";
    case "repaired":
      return `Keys installed. Your engine held half its configuration recovery key and completed it from that half.${wrapNote}`;
    case "kept-partial":
      return `Keys installed. Your engine holds half its configuration recovery key and could not complete it. Add the configuration keys to finish it.${wrapNote}`;
  }
}

// lastFailingRunlogDestination remembers the first destination id a re-key hand-over left pending the
// attended re-sign, across renders of this module (a tab switch away and back, not just this one render):
// the attended re-sign section (keys/runlog-resign.ts) reads it to pre-select the destination it already
// knows is failing, rather than opening on "Default destination" when a specific one needs attention. A
// hand-over with nothing pending leaves it unchanged, so an earlier failing destination is not forgotten
// just because a LATER re-key's hand-over happened to need no attention.
let lastFailingRunlogDestination: string | null = null;
export function getLastFailingRunlogDestination(): string | undefined {
  return lastFailingRunlogDestination ?? undefined;
}

// handoverNote states what the engine's re-key hand-over did with each destination's backup RUNLOG
// (KeyInstallResult.runlogHandover), in plain present-tense sentences. It rides only on a confirmed re-key:
// a first install has no prior signer, so there is nothing to hand over and the field is absent. Returns ""
// when there is nothing to say (no summary at all).
function handoverNote(summary: RunlogHandoverSummary | undefined): string {
  if (!summary) return "";
  if (summary.skipped === "outgoing-signer-unreadable") {
    return "Your previous signer could not be read, so no destination RUNLOG was handed over. Each one waits for the attended re-sign before its next backup.";
  }
  const resigned = summary.outcomes.filter((o) => o.outcome === "re-signed").length;
  const current = summary.outcomes.filter((o) => o.outcome === "already-current").length;
  const absent = summary.outcomes.filter((o) => o.outcome === "absent").length;
  const pending = summary.pending.length;
  const parts: string[] = [];
  if (resigned > 0) parts.push(`handed ${resigned} over to the new signer`);
  if (current > 0) parts.push(`${current} already signed under it`);
  if (absent > 0) parts.push(`${absent} with no RUNLOG yet`);
  const base = parts.length > 0 ? `Destination RUNLOGs: ${parts.join(", ")}.` : "";
  const pendingNote = pending > 0
    ? ` ${pending} did not verify under either signer and wait for the attended re-sign. New runs to them are held until then.`
    : "";
  return `${base}${pendingNote}`.trim();
}

function renderWiring(engine: EngineClient, result: CeremonyResult, rekey = false): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-5)" });
  wrap.appendChild(h("h3", { class: "drawer-section__title" }, "Install your keys to your engine"));
  wrap.appendChild(
    h("p", { class: "field__hint" }, `No terminal. Paste a one-shot Cloudflare token; your engine writes its own secrets (the signer private, the break-glass public, ${result.operational ? "the operational pair, " : ""}the configuration recovery key and the configuration wrap key), then you revoke it. An engine that already holds a configuration key keeps it. An engine that holds only half its configuration recovery key completes it, or keeps that half if it cannot. The break-glass private is generated here and never sent to the engine or to us; you download and keep it.`),
  );
  if (rekey) {
    wrap.appendChild(
      h("p", { class: "field__hint" }, "Your engine checks each destination's backup RUNLOG under your current signer, then hands it to the new signer. New runs are held until this finishes. A RUNLOG that does not verify under either signer stops the install first."),
    );
  }

  // The in-console install: the same path the onboarding ceremony uses (engine.installKeys writes
  // the engine's own secrets from a one-shot token), so there is no customer CLI on the primary path.
  // Re-check confirms presence after.
  const { recheck, presence, doCheck } = presenceCheck(engine);

  // keptNote reports the engine's OWN answer about the configuration keys (KeyInstallResult.configured),
  // never an assumption: it shows alongside "Keys installed" rather than replacing it, whenever that
  // answer is not a plain fresh install of both keys. configRecipient can be "repaired" (the engine held
  // a lone private and completed it from that half) or "kept-partial" (the engine holds only half and
  // could not complete it, so it is NOT a working recovery key); installNote below states each truthfully.
  const keptNote = h("p", { class: "field__hint", style: "margin-top:var(--space-2)", hidden: true });
  // handoverEl states the re-key hand-over's outcome per destination (handoverNote above). It rides only
  // on a confirmed re-key; a first install never sets it, because there is no prior signer to hand over.
  const handoverEl = h("p", { class: "field__hint", style: "margin-top:var(--space-2)", hidden: true });
  let lastInstall: { configured: { configRecipient: ConfigRecipientOutcome; configWrapKey: "installed" | "kept" }; runlogHandover?: RunlogHandoverSummary } | null = null;

  wrap.appendChild(
    renderTokenApply({
      applyLabel: "Install keys to your engine",
      tokenPurpose: "install your keys",
      busyLabel: "Installing",
      doneLabel: "Keys installed",
      apply: (token) => engine.installKeys({
        token,
        signerPrivate: result.signer.privateB64,
        breakGlassPublic: result.breakGlass.recipientPublicB64,
        ...(result.operational ? { operationalPublic: result.operational.recipientPublicB64, operationalPrivate: result.operational.identityB64 } : {}),
        configRecipientPublic: result.configRecipient.recipientPublicB64,
        configRecipientPrivate: result.configRecipient.identityB64,
        configWrapKey: result.configWrapKeyB64,
        // A DELIBERATE re-key (the estate already had a signer, and the owner was warned on the entry card):
        // the engine's already-present guard on POST /keys/install refuses an install over an existing signer
        // UNLESS this flag is set, so a silent overwrite is impossible while this warned re-key still lands.
        ...(rekey ? { confirmRekey: true } : {}),
      }).then((installed) => { lastInstall = installed; }),
      onApplied: () => {
        clearSensitiveState();
        void doCheck();
        const said = lastInstall ? installNote(lastInstall.configured) : "";
        keptNote.textContent = said;
        keptNote.hidden = said === "";
        const handedOver = lastInstall ? handoverNote(lastInstall.runlogHandover) : "";
        handoverEl.textContent = handedOver;
        handoverEl.hidden = handedOver === "";
        const firstPending = lastInstall?.runlogHandover?.pending[0];
        if (firstPending !== undefined) lastFailingRunlogDestination = firstPending;
      },
    }),
  );
  wrap.appendChild(keptNote);
  wrap.appendChild(handoverEl);
  wrap.appendChild(h("div", { style: "margin-top:var(--space-3)" }, recheck, presence));

  // Where backups go is a separate, no-terminal task on the Destinations screen.
  wrap.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Where backups go is set on the ",
      h("button", { "data-dp": "keys.button.navigate-destinations", class: "linklike", type: "button", on: { click: () => navigate("/destinations") } }, "Destinations screen"),
      " (verified live, no terminal).",
    ),
  );

  // The wrangler path stays for an operator who prefers IaC, but deeply collapsed (never primary).
  wrap.appendChild(wranglerFallbackSection(result, rekey));

  return wrap;
}
