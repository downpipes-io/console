// The Posture tab of the Keys and break-glass screen (the default tab and the trust anchor): the presence
// posture read (from GET /admin/status; presence is the binding being set, never that the value works), the
// key ceremony entry and result (the ceremony runs in THIS browser; the break-glass private is only ever
// offered as the downloaded identity.key, with deliberately no command and no field that puts it on the
// engine), the no-CLI wiring block (the engine writes its own secrets from a one-shot token), and the strict
// break-glass-only posture switch. Moved verbatim from the keys coordinator for size; it imports the shared
// leaf (./shared.ts) only, so it never imports another tab module (which would form a cycle).
//
// NO-CUSTODY: the break-glass PRIVATE is generated here and never sent anywhere; the signer private (the one
// private the engine legitimately holds) is concealed behind a reveal toggle. House style: Australian English,
// no em dashes, precise claims.

import type { EngineClient, StatusReport } from "../../api.ts";
import { codeBlock, keyField } from "../../components/code-block.ts";
import { renderCustodyStep } from "../../components/custody-step.ts";
import { blockError, engineAnswered, errorDetail, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { confirmModal } from "../../components/modal.ts";
import { badge, type StatusTone, statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { type CeremonyResult, identityFile, isCeremonyResult, type KeyMaterial, recipientFile, runKeyCeremony, runOperationalOnlyCeremony, signerPrivateFile, signerPublicFile } from "../../keygen.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import type { CustodyMetadata } from "../../lib/custody.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { classifyError, isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL, ICON_LOCK, ICON_REFRESH } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { POSTURE_ACK_STATEMENTS, type PostureChoice } from "../../lib/posture-ack-statements.ts";
import { clearSensitiveState, getCeremony, getCeremonyRekey, setCeremony } from "../../lib/store.ts";
import { recoverySheet } from "../../recovery-sheet.ts";
import { canDo, collapsedSection, gateReason, refuseWithReason } from "../common.ts";
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
// The engine has always defined a "keys-rekey" channel alongside "onboarding" (posture-ack-statements.ts),
// and the console never called it, so the acknowledgement could only ever be captured during the onboarding
// fork. Three populations were therefore silently unrecorded: an engine stood up with scripts/deploy.sh,
// which installs the operational pair without any acknowledgement at all; a returning operator, because the
// onboarding fork correctly refuses to force a choice against a posture that is already fixed and records
// nothing on that path; and every customer of a future statement version, because a bumped statement can
// only be accepted somewhere, and until now there was nowhere.
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
      .then((s: StatusReport) => body.replaceChildren(ackBody(engine, s.operationalConfigured.private === true)))
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
    // Honest failure: the engine rejects a statement it does not recognise, which is what a console/engine
    // version skew looks like. Say that rather than a generic error, because the fix is to update, not retry.
    outcome.textContent = "The engine did not record it. If your console and engine are on different versions, update them and try again.";
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
      meaningRow("Signer", "the one private key the engine legitimately holds: it signs runs, it cannot decrypt archives. Required for engine ready."),
      meaningRow("Break-glass public", "the engine can wrap archive keys to this public key but never unwrap. Required for engine ready."),
      meaningRow("Operational key (public)", "the read-back recipient new runs are wrapped to."),
      meaningRow("Operational key (private)", "the UNATTENDED-proof key: present means the engine can run scheduled restore tests, automated drills and in-account retention pruning on its own. Absent = strict break-glass-only custody. Verify-at-seal and the canary still run in-account with no key, and an in-console restore still works with your break-glass key supplied to the browser; what moves offline is the unattended work."),
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

  const recovery: StatusTone = s.operationalConfigured.private ? "ok" : "info";
  const recoveryLabel = s.operationalConfigured.private
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
  // never that the value parses or verifies.
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

// strictCustodyDisclosure is where a customer opts INTO an operational key by clearing the box. Strict
// break-glass-only custody is the default, and what the operational key buys is the UNATTENDED work: scheduled restore tests,
// automated drills and in-account retention pruning, each of which needs a key at a moment when nobody
// is present to supply one. It is NOT what makes the archives verified. Verify-at-seal reaches the same
// keyed tier from the run's own per-run key while the seal path still holds it, and the canary runs with
// no skipped checks, so a strict estate is continuously proven in-account. An in-console restore also
// still works, with the break-glass key supplied to the browser and wiped after.
//
// Saying otherwise here is not a wording preference: this copy is read at the moment the posture is
// CHOSEN, and overstating the cost pushes a customer away from the stricter posture for a reason that
// stopped being true. Returns the checkbox so the caller reads its checked state at generate.
function strictCustodyDisclosure(): { disclosure: HTMLElement; strictCheck: HTMLInputElement } {
  // Checked by default: strict custody is the default posture, so the operational key is what a
  // customer opts into rather than what they must know to decline. The element id is deliberately
  // unchanged, since other tooling keys on it; what changed is the default state and the label's
  // direction, not the identity of the control.
  const strictCheck = h("input", { type: "checkbox", id: "ceremony-strict", checked: true }) as HTMLInputElement;
  const disclosure = h(
    "details",
    { class: "disclosure" },
    // The shared h2.disclosure__heading, as above: the summary is a section heading.
    h("summary", h("h2", { class: "disclosure__heading" }, "Key posture: strict break-glass-only custody (no key in the engine that can read an archive)")),
    h(
      "div",
      { class: "disclosure__body" },
      h(
        "div",
        { class: "checkbox-row" },
        strictCheck,
        h("label", { for: "ceremony-strict" }, "Keep strict custody: no operational key (reopening a past run then needs you present)"),
      ),
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
          "Without it the live engine can never read an archive, even if fully compromised. Your engine still verifies every run as it seals it, and the canary still proves the write, seal, read, decrypt and restore path hourly against its own test data. What stops is anything that reopens a run the engine sealed EARLIER with nobody present: scheduled restore tests, drills and retention pruning, so storage grows until you prune offline. Restoring from this console keeps working, with you present and supplying your break-glass key in the browser, and you prove past runs restorable the same way at an attended verification. Your engine also keeps its own configuration recovery: the config export is sealed to a dedicated key that opens that export and nothing else, installed in either posture, so a wiped engine still auto-recovers its configuration with no key present that can read an archive.",
      ),
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-2)" },
        // THIS LINE USED TO BE THE OVERSTATEMENT THE COMMENT ABOVE THIS FUNCTION FORBIDS. It said posture was
        // fixed at generation and that changing it meant "re-keying, a new key set, every secret re-applied,
        // and a fresh recovery sheet". All four clauses are false against this same file: renderAddOperationalEntry
        // (below) writes ONLY the operational pair over POST /admin/keys/add-operational and states "No new
        // identity.key is needed", and posture-switch.ts removes it over POST /admin/keys/break-glass-only with no
        // keygen at all. So the copy read at the moment of the choice priced the SAFE option as the expensive one,
        // which is exactly backwards: keeping strict custody now is the reversible direction, and the operational
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
  return { disclosure, strictCheck };
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
    // A browser that cannot generate a key pair
    // produces NO KEY MATERIAL AT ALL: there is nothing to download, nothing to save, and no backup taken
    // afterwards could ever be recovered. Until now this catch rendered err.message into a field__error that
    // only the operator ever saw, and reported NOTHING anywhere, so a support pack from a locked-down browser
    // carried zero evidence of the most consequential failure the console has. The reporter takes no error, so
    // the message below stays on the screen where the operator needs it and never enters the pack.
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
      host.replaceChildren(pickReturningOwnerCard(engine, s));
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
      host.replaceChildren(renderCeremonyEntry(engine));
    });
  return host;
}

// pickReturningOwnerCard chooses the entry card from the LIVE status. It closes the re-key state-blindness:
// the previous branch only special-cased the break-glass-only state, so a FULLY TWO-
// RECIPIENT estate fell through to the generic, state-blind renderCeremonyEntry with no signal that "Generate
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
  if (s.signerConfigured && s.breakGlassConfigured && !s.operationalConfigured.private) return renderAddOperationalEntry(engine);
  if (s.signerConfigured) return renderCeremonyEntry(engine, { rekey: true });
  return renderCeremonyEntry(engine, { rekey: false });
}

// ---- Add an operational key only (state-aware; break-glass-only -> operational) ----------------------
//
// The targeted upgrade for an estate that already has a signer and a break-glass key: it installs ONLY an
// operational pair, via POST /keys/add-operational (engine/src/admin/router-keys.ts), so it never touches
// the signer or the break-glass key. Honest, in-place, at the moment it matters, of the four facts the
// break-glass-to-operational transition investigation found missing from the old, state-blind flow:
//   1. archives sealed before this stay break-glass-only recoverable, forever; new archives gain
//      operational recoverability too (the recipient set is baked into each archive at seal time).
//   2. drills, scheduled restore tests and retention pruning resume automatically, on their next run, with no
//      further action, and in-console restore stops needing the break-glass key each time. It was never off:
//      the break-glass path supplies a per-run master from the browser, so saying it "resumes" would imply a
//      capability the estate did not have.
//   3. no new identity.key is needed: the break-glass key is untouched.
//   4. no signer rotation happens, so every existing run stays verifiable and restorable through this
//      console exactly as before (contrast the full "Generate keys" ceremony, which reissues both).
function renderAddOperationalEntry(engine: EngineClient): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Add an operational key"),
      badge("info", "Break-glass-only today"),
    ),
  );

  card.appendChild(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "Your engine already has a signer and a break-glass key, and holds no key that can read your archives. This adds an operational key only, so your engine can prove backups restore on its own. Your signer and break-glass key are not touched.",
    ),
  );

  const facts = h("ul", { class: "stack-sm", style: "margin-top:var(--space-3);padding-left:1.2em" });
  facts.appendChild(h("li", { class: "field__hint" }, "Archives sealed before you add this key stay recoverable with your break-glass identity.key only, forever. Archives sealed afterwards gain operational recoverability too."));
  facts.appendChild(h("li", { class: "field__hint" }, "Drills, scheduled restore tests and retention pruning resume automatically on their next run, and restoring from this console stops asking for your break-glass key each time. Nothing else to do here. Verify-at-seal and the canary were already running: they do not need this key."));
  facts.appendChild(h("li", { class: "field__hint" }, "No new identity.key is needed: your break-glass key is unchanged."));
  facts.appendChild(h("li", { class: "field__hint" }, "Your signer is unchanged, so verification of your existing runs keeps working through this console exactly as before. Generating a whole new key set would rotate the signer and break that."));
  card.appendChild(facts);

  const ownerGate = canDo("owner");
  // Named generateOperationalBtn (not generateBtn): the census keys a control by its own local variable
  // name (VAR_SUFFIXES-stripped), not by the data-dp string, so reusing "generateBtn" here would collide
  // with renderCeremonyEntry's button of the same name below and silently renumber both.
  const generateOperationalBtn = h(
    "button",
    { "data-dp": "keys.button.generate-operational",
      class: "btn btn--primary",
      type: "button",
    },
    "Generate operational key",
  ) as HTMLButtonElement;
  const progress = h("div");

  if (ownerGate) {
    generateOperationalBtn.addEventListener("click", () => void runAddOperationalAndRender(engine, card, generateOperationalBtn, progress));
  } else {
    refuseWithReason(generateOperationalBtn, gateReason("owner"));
  }

  card.appendChild(h("div", { style: "margin-top:var(--space-4)" }, generateOperationalBtn));
  if (!ownerGate) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")));
  card.appendChild(progress);

  // Escape hatch: an owner who deliberately wants the full re-key (a new signer AND break-glass pair, not
  // only the operational key) can still reach it, collapsed so it is never the default for this state.
  card.appendChild(
    collapsedSection(
      "Advanced: run the full re-key ceremony instead",
      h(
        "div",
        { class: "stack-sm" },
        h(
          "p",
          { class: "field__hint", style: "margin:0" },
          "This replaces your signer and your break-glass key as well as adding the operational key: a new identity.key to save, and specific older runs stop opening through this console afterwards (verify them with the offline reader and the matching old signer.pub instead). Most owners adding an operational key do not need this.",
        ),
        fullRekeyInsteadButton(engine, card, ownerGate),
      ),
    ),
  );

  return card;
}

// fullRekeyInsteadButton swaps the add-operational card for the existing, unchanged first-time ceremony
// card, for the rare owner who deliberately wants the full re-key from this state. Pulled out of
// renderAddOperationalEntry to keep that function under the length budget.
function fullRekeyInsteadButton(engine: EngineClient, card: HTMLElement, ownerGate: boolean): HTMLButtonElement {
  const fullRekeyInsteadBtn = h(
    "button",
    { "data-dp": "keys.button.full-rekey-instead",
      class: "btn btn--secondary btn--sm",
      type: "button",
    },
    "Run the full re-key ceremony instead",
  ) as HTMLButtonElement;
  // The escape hatch is a DELIBERATE re-key from a break-glass-only estate (which already has a signer), and
  // its collapsed section already warned that this replaces the signer. Render the ceremony card in re-key
  // mode so it repeats the signer-continuity warning and its install carries confirmRekey.
  if (ownerGate) fullRekeyInsteadBtn.addEventListener("click", () => card.replaceWith(renderCeremonyEntry(engine, { rekey: true })));
  else refuseWithReason(fullRekeyInsteadBtn, gateReason("owner"));
  return fullRekeyInsteadBtn;
}

// runAddOperationalAndRender runs the browser-only operational-key ceremony (no-custody, async post-quantum
// keygen): no download (the operational private is not a recovery credential, so unlike identity.key it is
// never offered as a file, only installed straight to the engine below), and swaps the entry card for the
// wiring card. A failure restores the button and shows the reason in place, exactly like the full ceremony.
async function runAddOperationalAndRender(
  engine: EngineClient,
  card: HTMLElement,
  generateBtn: HTMLButtonElement,
  progress: HTMLElement,
): Promise<void> {
  generateBtn.dataset.busy = "true";
  generateBtn.textContent = "Generating in this browser";
  generateBtn.disabled = true;
  progress.replaceChildren(h("p", { class: "field__hint" }, "Generating the operational key pair in this browser."));
  try {
    const operational = await runOperationalOnlyCeremony();
    const fresh = renderAddOperationalWiring(engine, operational);
    card.replaceWith(fresh);
    toast({ message: "Operational key generated in this browser." });
  } catch (err) {
    // The same honest capture the full ceremony and the rotation both use, on its own surface tag,
    // so a browser that cannot generate keys is visible in the pack for THIS action specifically.
    reportKeygenFault("add-operational-key");
    generateBtn.dataset.busy = "false";
    generateBtn.textContent = "Generate operational key";
    generateBtn.disabled = false;
    progress.replaceChildren(
      h("p", { class: "field__error" }, `Key generation failed in the browser (${err instanceof Error ? err.message : String(err)}). Nothing was sent anywhere.`),
    );
  }
}

// operationalPresenceCheck mirrors presenceCheck (below), but polls for the OPERATIONAL key specifically
// rather than the signer + break-glass pair, since that is the one binding this flow ever installs. Named
// recheckOperational (not recheck): the census keys a control by its own local variable name, so reusing
// "recheck" here would collide with presenceCheck's button of the same name and silently renumber both.
function operationalPresenceCheck(engine: EngineClient): { recheck: HTMLButtonElement; presence: HTMLElement; doCheck: () => Promise<void> } {
  const presence = h("span", { class: "field__hint", style: "margin-left:var(--space-2)", role: "status", "aria-live": "polite" });
  const recheckOperational = h("button", { "data-dp": "keys.button.recheck-operational", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, svgIcon(ICON_REFRESH, { size: 14 }), "Check engine for presence") as HTMLButtonElement;
  const doCheck = async (): Promise<void> => {
    presence.textContent = "Checking.";
    try {
      const s = await engine.status();
      presence.textContent = s.operationalConfigured.private
        ? "The engine reports the operational key present. Drills, scheduled restore tests and retention pruning resume on their next run, and in-console restore no longer asks for your break-glass key."
        : "Not yet reported present. The engine can take a moment.";
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: this line says "Checking." until something replaces it, and only
        // this handler ever does.
        presence.textContent = "Your session ended before the check finished. Sign in again to re-check.";
        return goSignedOut();
      }
      // AN ANSWER IS NOT AN UNREACHABLE ENGINE. The 401 is answered above; everything else used to take the
      // reachability line below, including a 429, a 503 with no ENGINE binding and a step-up the operator
      // dismissed, none of which the network has anything to do with. This read is step-up gated, so the
      // dismissed-prompt case is not hypothetical here.
      presence.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check presence.";
    }
  };
  recheckOperational.addEventListener("click", () => void doCheck());
  return { recheck: recheckOperational, presence, doCheck };
}

// renderAddOperationalWiring is the install step for the operational-only ceremony: a custody legend
// scoped to just the operational pair (the signer and break-glass rows read "untouched", never repeating
// the full ceremony's legend), then the one-shot-token apply to POST /keys/add-operational.
function renderAddOperationalWiring(engine: EngineClient, operational: KeyMaterial): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Operational key generated"),
      badge("ok", "Ready to install"),
    ),
  );

  const legend = h("div", { class: "custody-legend" });
  legend.appendChild(legendCol("Untouched", ["your signer private (still only in your engine)", "your break-glass key (identity.key stays the one you already have)"], "trust"));
  legend.appendChild(legendCol("Goes to your engine", ["operational.pub", "OPERATIONAL_PRIVATE, the read-back key; it can decrypt archives sealed from now on"], "info"));
  legend.appendChild(legendCol("Goes to the vendor", ["nothing"], "ok"));
  card.appendChild(legend);
  card.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "The operational private is not a recovery credential, so it is not offered as a download here; it installs straight to your engine below.",
    ),
  );

  const { recheck, presence, doCheck } = operationalPresenceCheck(engine);

  card.appendChild(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-5)" }, "Install the operational key to your engine"));
  card.appendChild(
    h("p", { class: "field__hint" }, "No terminal. Paste a one-shot Cloudflare token; your engine writes ONLY the operational key, then you revoke the token. Your signer and break-glass key are not sent and are not changed."),
  );

  card.appendChild(
    renderTokenApply({
      applyLabel: "Add the operational key to your engine",
      tokenPurpose: "add the operational key",
      busyLabel: "Adding",
      doneLabel: "Operational key added",
      apply: (token) => engine.addOperationalKey({
        token,
        operationalPublic: operational.recipientPublicB64,
        operationalPrivate: operational.identityB64,
      }).then(() => undefined),
      onApplied: () => { void doCheck(); },
    }),
  );
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, recheck, presence));

  card.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Drills, scheduled restore tests and retention pruning resume automatically on their next run, and in-console restore stops asking for your break-glass key; there is nothing further to do here. Verify-at-seal and the canary were already running without this key.",
    ),
  );

  return card;
}

// rekeyContinuityWarning is the signer-continuity warning the re-key path shows before "Generate keys": on an
// estate that ALREADY has a signer, a new key set ROTATES the signer, so every run signed by the current
// signer stops verifying through this console. Warn-tinted, role="note" (static mount-time content, not an
// alert), never shouting: the same pattern the break-glass rotation card uses for its archive-continuity
// warning. Its presence is the "signer already present" awareness the fully-two-recipient state previously
// lacked.
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
  return box;
}

// renderCeremonyEntry is the first-time ceremony card. When opts.rekey is set (an estate that already has a
// signer), it renders the signer-continuity warning before the generate control and threads the flag through
// to the install so it carries confirmRekey: the engine allows this DELIBERATE, warned re-key while still
// refusing a silent one. opts.rekey defaults false, so a fresh estate reads exactly as before.
function renderCeremonyEntry(engine: EngineClient, opts: { rekey: boolean } = { rekey: false }): HTMLElement {
  const card = h("div", { class: "card card--warn measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Key ceremony"),
      badge("trust", "Trust anchor"),
    ),
  );

  // The re-key continuity warning renders BEFORE the generate control (the previously state-blind card gave a
  // fully two-recipient estate no such signal at all).
  if (opts.rekey) card.appendChild(rekeyContinuityWarning());

  card.appendChild(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "The break-glass key is generated here, in your browser. The private half is the ONLY way to recover your backups, and it is never sent to the engine or the vendor. If you lose it, the backups cannot be recovered.",
    ),
  );

  const { disclosure, strictCheck } = strictCustodyDisclosure();
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
function custodyLegend(result: CeremonyResult): HTMLElement {
  const op = result.operational;
  const legend = h("div", { class: "custody-legend" });
  legend.appendChild(legendCol("Stays in this browser", [
    { label: "identity.key (break-glass private)", download: { name: "identity.key", content: () => identityFile(result.breakGlass) } },
    "the recovery sheet (buttons below)",
  ], "trust"));
  legend.appendChild(legendCol("Goes to your engine", [
    { label: "signer.key (signer private)", download: { name: "signer.key", content: () => signerPrivateFile(result.signer) } },
    { label: "recipient.pub", download: { name: "recipient.pub", content: () => recipientFile(result.breakGlass) } },
    // signer.pub belongs in BOTH columns by purpose. It stays here because the custody claim this legend
    // makes is about where key material travels, and this one does go to the engine. The label carries the
    // other half: offline verify and restore refuse to start without --signer, and the signer public key is
    // not stored in the archive, so a copy has to live in the offline kit or an offline restore is impossible.
    { label: "signer.pub (keep a copy in your offline kit too: restore refuses to run without it)", download: { name: "signer.pub", content: () => signerPublicFile(result.signer) } },
    // Honest parity with the onboarding legend: list the operational PRIVATE (not just its
    // public half), since the default posture wires OPERATIONAL_PRIVATE, a decryption-capable
    // key, into the engine. The break-glass-only branch reinforces that the engine then holds
    // nothing that can decrypt. ("you opted in" was dropped: it is opt-OUT, and overstated.)
    ...(op
      ? [
          { label: "operational.pub", download: { name: "operational.pub", content: () => recipientFile(op) } },
          "OPERATIONAL_PRIVATE, the read-back key; it can decrypt archives, and is in your engine by default",
        ]
      : ["(no operational key, the engine holds nothing that can decrypt)"]),
  ], "info"));
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

  card.appendChild(custodyLegend(result));
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

  // The wiring block: the exact out-of-band wrangler commands. The signer private is
  // the ONE private value the engine holds; it is shown concealed (keyField). There
  // is deliberately NO command for the break-glass private key. Eager, because it is
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

// custodyDisclosures is the reference + optional-step content demoted behind collapsed disclosures
// (the card previously stacked six eager sub-sections): the fingerprints are a runbook reference, and
// the tiered offline custody split is an optional protection step. onMeta receives the chosen scheme +
// custodian sign-off so the recovery sheet records it (public metadata only).
function custodyDisclosures(result: CeremonyResult, engine: EngineClient, onMeta: (meta: CustodyMetadata) => void): HTMLElement[] {
  return [
    collapsedSection("Public key fingerprints", renderFingerprintSection(result)),
    collapsedSection(
      "Protect your break-glass key (optional)",
      // The tiered offline custody menu, with the M-of-N split performed in-browser.
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
function wranglerFallbackSection(result: CeremonyResult): HTMLElement {
  const fallback = h("div", { class: "stack-sm" });
  fallback.appendChild(h("p", { class: "field__hint", style: "margin:0" }, "wrangler uses your own Cloudflare login, so it needs no token. Run from the engine directory, then redeploy."));
  fallback.appendChild(codeBlock("npx wrangler secret put SIGNER_PRIVATE"));
  fallback.appendChild(keyField({ label: "SIGNER_PRIVATE value", value: result.signer.privateB64 }));
  fallback.appendChild(commandWithValue("npx wrangler secret put BREAK_GLASS_PUBLIC", result.breakGlass.recipientPublicB64));
  if (result.operational) {
    fallback.appendChild(commandWithValue("npx wrangler secret put OPERATIONAL_PUBLIC", result.operational.recipientPublicB64));
    fallback.appendChild(codeBlock("npx wrangler secret put OPERATIONAL_PRIVATE"));
    fallback.appendChild(keyField({ label: "OPERATIONAL_PRIVATE value", value: result.operational.identityB64 }));
  }
  return collapsedSection("Advanced: apply with Wrangler instead", fallback);
}

function renderWiring(engine: EngineClient, result: CeremonyResult, rekey = false): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-5)" });
  wrap.appendChild(h("h3", { class: "drawer-section__title" }, "Install your keys to your engine"));
  wrap.appendChild(
    h("p", { class: "field__hint" }, `No terminal. Paste a one-shot Cloudflare token; your engine writes its own secrets (the signer private, the break-glass public${result.operational ? ", and the operational pair" : ""}), then you revoke it. The break-glass private is generated here and never sent to the engine or to us; you download and keep it.`),
  );

  // The in-console install: the same path the onboarding ceremony uses (engine.installKeys writes
  // the engine's own secrets from a one-shot token). This replaces the previous wrangler-primary
  // wiring so there is no customer CLI on the primary path. Re-check confirms presence after.
  const { recheck, presence, doCheck } = presenceCheck(engine);

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
        // A DELIBERATE re-key (the estate already had a signer, and the owner was warned on the entry card):
        // the engine's already-present guard on POST /keys/install refuses an install over an existing signer
        // UNLESS this flag is set, so a silent overwrite is impossible while this warned re-key still lands.
        ...(rekey ? { confirmRekey: true } : {}),
      }).then(() => undefined),
      onApplied: () => { clearSensitiveState(); void doCheck(); },
    }),
  );
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
  wrap.appendChild(wranglerFallbackSection(result));

  return wrap;
}
