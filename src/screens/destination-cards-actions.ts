// The destination lever ACTION handlers (verify / make-default / remove with the orphan-guard force path /
// replace / the console-lever and deploy-fallback wiring), split out of destination-cards.ts so the card and
// drawer RENDERERS stay presentational (guardrail: file size + function size). No module-level mutable state
// is shared: every handler crosses calls via explicit (engine, st, reload) arguments.
//
// No-custody invariants kept: every string a handler surfaces names something the owner set or an engine
// verdict, never a credential; every server string enters the DOM via textContent / the typed h() builder.

import type { DestinationStatus, EngineClient } from "../api.ts";
import { isOwnerActionQueuedResult } from "../api.ts";
import { typeToConfirm } from "../components/confirm.ts";
import { sessionEnded, stepUpAwareText } from "../components/error-view.ts";
import { noteQuiet, skeletonRows } from "../components/feedback.ts";
import { confirmModal } from "../components/modal.ts";
import { requireChange } from "../components/require-change.ts";
import { toast } from "../components/toast.ts";
import type { ChangeRef } from "../lib/change-ref.ts";
import { h } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { goSignedOut } from "../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../lib/pending-change-toast.ts";
import { collapsedSection } from "./common.ts";
import { destinationForm } from "./destination-form.ts";
import { type DestinationFormOpts, loadFormContext } from "./destination-form-fields.ts";

// ---------------------------------------------------------------------------
// The lever HANDLERS, shared between the deploy-time card and the drawer footer so neither
// path re-implements the make-default / verify / remove / replace logic.
// ---------------------------------------------------------------------------

// verifyDestination runs the owner-only live re-probe (the engine re-checks the EFFECTIVE
// destination exactly as a run resolves it) and reports the outcome honestly, then reloads.
export function verifyDestination(engine: EngineClient, st: DestinationStatus, reload: () => void): void {
  void engine
    .verifyDestination(st.id)
    .then((res) => {
      if (res.ok) {
        toast({ message: res.ms !== undefined ? `Destination reachable and authorised (${res.ms}ms).` : "Destination reachable and authorised." });
      } else {
        toast({ message: res.reason ? `Destination did not verify: ${res.reason}` : "Destination did not verify (no reason reported).", tone: "warn" });
      }
      reload();
    })
    .catch((err) => {
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: `Could not verify the destination (${errMsg(err)}).`, tone: "warn" });
    });
}

// confirmMakeDefault is the confirmation Make default runs. Repointing the default decides where every
// future backup lands, which is why the engine gates it behind a fresh identity check, and it was the only
// lever on the destination card that fired straight from a click: Replace and Remove both confirm, and the
// operator met the passkey prompt on this one with nothing said. It stays a named function rather than an
// inline options object because makeDefault is now the single wiring and this is the sentence it opens with.
function confirmMakeDefault(name: string): Promise<boolean> {
  return confirmModal({
    title: "Make this the default destination?",
    body: `New runs with no destination of their own will be written to '${name}' from the next tick. Runs already stored elsewhere stay where they are and need that bucket reachable to restore. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is changed and the current default stays where it is.`,
    confirmLabel: "Make default",
    variant: "primary",
  });
}

// makeDefault repoints the default destination. Dual control may queue it for a second owner,
// in which case the default is UNCHANGED until they approve, said honestly (never "is now the default").
//
// IT IS THE ONLY WIRING, and that is the point of the `btn` argument rather than a second listener. The card
// lever used to be its own inline handler beside renderConsoleLevers's button, and the two diverged on the
// one thing an operator cannot see: the drawer lever collected a change reference and the card lever called
// setDefaultDestination with the id alone. The engine change-controls dest-default (owner-action.ts), so an
// estate with Require Change Number ON had one Make default that recorded a CR and one that could not
// record anything, refused at the engine with no field to supply the reference in. The card lever's only
// genuine difference was that it owns a button it must re-enable, so that is all it passes now.
export function makeDefault(engine: EngineClient, st: DestinationStatus, reload: () => void, btn?: HTMLButtonElement): void {
  const id = st.id;
  if (id === undefined) return;
  const name = st.label ?? st.bucket ?? "this destination";
  // Change management (owner opt-in): repointing the default destination is a change-controlled action, so
  // collect a change reference first when the policy requires one (a no-op otherwise). On cancel, do nothing.
  void (async () => {
    if (!(await confirmMakeDefault(name))) return;
    const cr = await requireChange(engine, `Make '${name}' the default destination`, "destination-set-default");
    if (!cr.proceed) return;
    if (btn) btn.disabled = true;
    try {
      const res = await engine.setDefaultDestination(id, cr.change ?? undefined);
      if (isOwnerActionQueuedResult(res)) {
        surfaceQueuedOwnerAction(`Making '${name}' the default`);
        return;
      }
      toast({ message: `'${name}' is now the default.` });
      reload();
    } catch (err) {
      if (isUnauthorised(err)) {
        goSignedOut();
        return;
      }
      toast({ message: `Could not set the default. ${stepUpAwareText(err)}`, tone: "warn" });
    } finally {
      // PAINT FIRST, THEN LEAVE, on every path rather than on the three that were easy to see. That includes
      // the hand-off to goSignedOut, because the nav bridge is a no-op until app.ts installs it and a frozen
      // lever is what the operator would be left looking at. On the success path reload rebuilds the card and
      // this destination is the default by then, so the lever is not rendered again anyway.
      if (btn) btn.disabled = false;
    }
  })();
}

// removeDestination confirms the removal (naming the consequence: the last one, the default, or
// a fallback to the default), then runs it. A queued result means dual control deferred it to a
// second owner, so the destination is STILL LIVE and receiving backups (the most dangerous false
// success in C6): say so honestly, never "removed". close dismisses the drawer before the reload.
export function removeDestination(engine: EngineClient, st: DestinationStatus, count: number, reload: () => void, close?: () => void): void {
  const lastOne = st.id !== undefined && count <= 1;
  void confirmModal({
    title: "Remove this destination?",
    body: lastOne
      ? "This is your only destination: backups will fail until a new one is set (or the deploy-time configuration takes over). Runs already in its bucket need that bucket reachable to restore. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again."
      : st.isDefault
        ? "It is the default, so another destination is promoted to default. Runs already in its bucket need that bucket reachable to restore. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again."
        : "New runs that would have used it fall back to the default. Runs already in its bucket need that bucket reachable to restore. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again.",
    confirmLabel: "Remove",
    variant: "danger",
  }).then(async (okd) => {
    if (!okd) return;
    // Change management (owner opt-in): removing a destination is a change-controlled action, so collect a
    // change reference after the removal is confirmed (a no-op when the policy is off). On cancel, do nothing.
    const cr = await requireChange(engine, "Remove this destination", "destination-delete");
    if (!cr.proceed) return;
    const done = (res: { status: "result" | "queued" }): void => {
      if (res.status === "queued") {
        surfaceQueuedOwnerAction("Removing this destination");
        return;
      }
      toast({ message: "Destination removed." });
      close?.();
      reload();
    };
    // failPlain is the terminal error surface (used by the force path too, so a force failure does not
    // re-offer force and loop).
    const failPlain = (err: unknown): void => {
      if (isUnauthorised(err)) {
        goSignedOut();
        return;
      }
      toast({ message: `Could not remove the destination. ${stepUpAwareText(err)}`, tone: "warn" });
    };
    const fail = (err: unknown): void => {
      if (isUnauthorised(err)) {
        goSignedOut();
        return;
      }
      // DEST-3: the engine's orphan guard refused this non-force removal because the destination is the
      // only proven copy of some backed-up runs. Rather than a dead-end toast, offer a gated force-remove
      // so a permanently stuck guard is clearable from the console. Only this refusal is force-clearable;
      // an "in use by N downpipe(s)" refusal needs reassignment first and falls through to failPlain.
      if (st.id !== undefined && isOrphanGuardError(err)) {
        // The refusal itself is passed on rather than only classified. The engine's sentence carries
        // the at-risk RUN COUNT, the downpipe names, and which step actually clears the guard on this
        // estate; the console's own copy below can only be generic. Escalating without it replaced a
        // specific instruction with a general one at the exact moment the operator is deciding
        // whether to destroy the last copy of a backup.
        offerForceRemove(engine, st, cr.change ?? undefined, done, failPlain, err);
        return;
      }
      failPlain(err);
    };
    void (st.id !== undefined ? engine.removeDestination(st.id, cr.change ?? undefined).then(done, fail) : engine.setDestination(null, cr.change ?? undefined).then(done, fail));
  });
}

// isOrphanGuardError detects the engine's orphan-guard refusal: a non-force remove of a destination that
// is the only proven copy of one or more backed-up runs (DEST-2/DEST-3). The reason is surfaced verbatim
// by the transport, so we key on its stable phrase. An "in use by N downpipe(s)" refusal is deliberately
// NOT matched: those downpipes must be reassigned first; force does not clear them.
function isOrphanGuardError(err: unknown): boolean {
  return errMsg(err).toLowerCase().includes("only proven copy");
}

// ENGINE_REFUSAL_MAX bounds what is rendered from an engine-authored string. The engine's own refusal
// is already length-capped at its source, so this is a second floor rather than the only one, and it
// keeps a pathological reason from displacing the ceremony copy underneath it in the dialogue.
const ENGINE_REFUSAL_MAX = 600;

// engineRefusalText peels the transport's envelope off an owner-mutation failure so the ENGINE's own
// sentence can be shown. parseJsonOrOwnerAction folds a non-2xx reason in as `<verb>: <reason>: <status>`
// (unlike the plain-parseJson path, which discards the body and throws `<verb>: <status>`), so the reason
// is present here and only needs unwrapping.
//
// It returns null rather than a fallback when there is nothing to show: an envelope with no reason in it
// would render as a bare verb and a status code, which reads as an engine fault rather than as the
// deliberate refusal this dialogue is escalating from. The generic advice below stands on its own.
//
// Nothing branches on the CONTENT. The string is placed as a DOM text node by `h`, never as markup, and
// it is not parsed, matched or trusted for any decision.
export function engineRefusalText(err: unknown): string | null {
  // The FULL envelope or nothing: a verb (which carries no colon), the reason, and a three-digit
  // status. Matching loosely would turn `remove destination: 400` -- the shape thrown when the body
  // carried no reason at all -- into the text "remove destination", which reads as an engine fault
  // rather than as the refusal this dialogue is escalating from. readErrorReason already normalises a
  // trailing digit run off the reason, so the last group is unambiguously the HTTP status.
  const m = /^([^:]+): (.+): (\d{3})$/.exec(errMsg(err));
  const body = (m?.[2] ?? "").trim();
  if (body === "") return null;
  return body.length > ENGINE_REFUSAL_MAX ? `${body.slice(0, ENGINE_REFUSAL_MAX)}…` : body;
}

// offerForceRemove runs the highest-consequence destination action behind a type-to-confirm gate (DEST-3).
// Force-removing the only proven copy of backed-up runs DROPS those copies: the bytes stay in the bucket
// but become unaddressable, so those runs can no longer be restored. The safe alternatives are named
// first; force is the deliberate last resort. The engine still enforces dual control on top, so a queued
// result is surfaced honestly rather than as "removed".
//
// `refusal` is the engine's own reason for this escalation, shown verbatim as TEXT (never as markup, and
// never interpreted: nothing here branches on its content beyond the classifier that got us here). It is
// the only thing in this dialogue that can name how many runs are at risk, which downpipes they belong
// to, and which remedy applies on THIS estate -- the engine knows whether the replicate pass can reach
// them and the console does not, because DestinationStatus carries no run count and no fan-out width.
//
// WHY THE GENERIC ADVICE CHANGED. It used to open by preferring a wait on the replicate pass, and then
// offer reassignment. Both halves could be wrong. The pass runs only for a downpipe configured with two
// or more destinations, so for a downpipe writing to one -- which is what the create wizard produces --
// waiting cannot end. And reassignment, on a downpipe that pins nothing, has no per-downpipe control to
// change: it reads as repointing the default, which used to walk silently past this very
// guard. The exact prior wording is quoted in test/validate-orphan-guard-reason-on-screen.ts, which is
// where a literal belongs, so this file cannot both carry the old sentence and assert its absence.
function offerForceRemove(
  engine: EngineClient,
  st: DestinationStatus,
  change: ChangeRef | undefined,
  done: (res: { status: "result" | "queued" }) => void,
  fail: (err: unknown) => void,
  refusal?: unknown,
): void {
  if (st.id === undefined) return;
  const id = st.id;
  const matchValue = st.label !== undefined && st.label !== "" ? st.label : id;
  void typeToConfirm({
    title: "Force-remove this destination?",
    impactSentence:
      "This destination is the only proven copy of one or more backed-up runs. Force-removing it DROPS those copies: their bytes stay in the bucket but become unaddressable with its credentials gone, so those runs can no longer be restored. This cannot be undone.",
    extra: [
      ...(engineRefusalText(refusal) !== null ? [h("p", { class: "field__hint" }, `The engine refused with: ${engineRefusalText(refusal)}`)] : []),
      h(
        "p",
        { class: "field__hint" },
        "Prefer the step the engine names above. Copies are made by the replicate pass, which runs only for a downpipe configured with two or more destinations, so a downpipe writing to one destination has to be given a second before any wait can help. Use force only when you accept losing those copies.",
      ),
      // The ceremony is named HERE as well as in the ordinary remove this escalates from: an operator reaches
      // this dialogue after the engine has already refused once, which is several minutes and one error
      // message after they read the first warning.
      h(
        "p",
        { class: "field__hint" },
        "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and the destination stays exactly as it is.",
      ),
    ],
    matchValue,
    matchLabel: "destination name",
    confirmLabel: "Force-remove",
    busyLabel: "Removing",
  }).then((okd) => {
    if (!okd) return;
    void engine.removeDestination(id, change, true).then(done, fail);
  });
}

// toggleReplaceForm reveals (or hides) the edit form inside the host on first ask, prefilled
// from the redaction-safe status. The same form the create path uses, with confirmReplace on
// (editing live credentials has the same consequence as setting a new destination).
export function toggleReplaceForm(engine: EngineClient, st: DestinationStatus, reload: () => void, host: HTMLElement): void {
  if (!host.hidden) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (host.dataset.mounted === "true") return;
  host.dataset.mounted = "true";
  const slot = h("div", { style: "margin-top:var(--space-3)" }, skeletonRows(3));
  host.replaceChildren(
    h("h3", { class: "drawer-section__title" }, "Replace these credentials"),
    slot,
  );
  void loadFormContext(engine).then((fctx) => {
    if (fctx === null) return;
    slot.replaceChildren(destinationForm(engine, fctx, buildReplaceOpts(st, reload)));
  });
}

// buildReplaceOpts assembles the prefill spread for the replace form across lines, so a
// missing field (e.g. a future DestinationStatus addition) is visible here rather than buried
// in a single-line call.
//
// EXPORTED SO IT CAN BE GRADED, added. Being "visible here" is not the same as being
// checked: a test exercises the status-to-opts hop directly, because driving the form builder alone would
// leave a deleted azureEntra line in this spread undetected. That hop IS the fix for a destination losing its Entra
// principal on edit, so it is now asserted rather than eyeballed.
export function buildReplaceOpts(st: DestinationStatus, reload: () => void): DestinationFormOpts {
  return {
    confirmReplace: true,
    onSaved: reload,
    ...(st.id !== undefined ? { editId: st.id } : {}),
    ...(st.label !== undefined ? { initialLabel: st.label } : {}),
    ...(st.pricing !== undefined ? { initialPricing: st.pricing } : {}),
    ...(st.worm !== undefined ? { initialWorm: st.worm } : {}),
    ...(st.assumeRoleArn !== undefined ? { initialAuthRoleArn: st.assumeRoleArn } : {}),
    ...(st.azureEntra !== undefined ? { initialAzureEntra: st.azureEntra } : {}),
    ...(st.addressing !== undefined ? { initialAddressing: st.addressing } : {}),
    ...(st.storageClass !== undefined ? { initialStorageClass: st.storageClass } : {}),
  };
}

// renderConsoleLevers wires a console-set destination's quiet levers (a collection item
// carries an id; the legacy singular view sets source "console"): Make default (when it is
// not already), Replace (edit credentials and name via the same form), Remove. All
// owner-gated, disabled-with-reason. It appends the card and the replace surface to wrap.
export function renderConsoleLevers(engine: EngineClient, st: DestinationStatus, reload: () => void, count: number, ownerGate: boolean, wrap: HTMLElement, card: HTMLElement): void {
  const makeDefaultBtn = st.id !== undefined && !st.isDefault
    ? ((ownerGate
        ? h("button", { "data-dp": "destination-cards-actions.button.make-default#1", class: "linklike", type: "button" }, "Make default")
        : h("button", { "data-dp": "destination-cards-actions.button.make-default#2", class: "linklike", type: "button", disabled: true }, "Make default")) as HTMLButtonElement)
    : null;
  const replaceBtn = (ownerGate
    ? h("button", { "data-dp": "destination-cards-actions.button.replace#1", class: "linklike", type: "button" }, "Replace")
    : h("button", { "data-dp": "destination-cards-actions.button.replace#2", class: "linklike", type: "button", disabled: true }, "Replace")) as HTMLButtonElement;
  const removeBtn = (ownerGate
    ? h("button", { "data-dp": "destination-cards-actions.button.remove#1", class: "linklike", type: "button", style: "color:var(--danger-fg)" }, "Remove")
    : h("button", { "data-dp": "destination-cards-actions.button.remove#2", class: "linklike", type: "button", disabled: true }, "Remove")) as HTMLButtonElement;
  const levers = h("div", { style: "display:flex;gap:var(--space-4);flex-wrap:wrap" });
  if (makeDefaultBtn) levers.appendChild(makeDefaultBtn);
  levers.appendChild(replaceBtn);
  levers.appendChild(removeBtn);
  card.appendChild(levers);
  wrap.appendChild(card);

  // The replace surface mounts on FIRST open (no fetch until asked for) and then
  // toggles, so the posture card stays the screen's one eager section.
  const replaceHost = h("div", { hidden: true });
  wrap.appendChild(replaceHost);
  if (ownerGate) {
    if (makeDefaultBtn) {
      // The SAME handler the drawer's Make default runs, so the two levers cannot diverge on the
      // confirmation, on the change reference, or on what they say about a queued result.
      makeDefaultBtn.addEventListener("click", () => makeDefault(engine, st, reload, makeDefaultBtn));
    }
    replaceBtn.addEventListener("click", () => toggleReplaceCard(engine, st, reload, replaceHost));
    removeBtn.addEventListener("click", () => removeDestination(engine, st, count, reload));
  }
}

// toggleReplaceCard is the card-flavoured replace toggle (a page-header title, not a drawer
// section title), mirroring toggleReplaceForm but for the deploy-time card path.
function toggleReplaceCard(engine: EngineClient, st: DestinationStatus, reload: () => void, host: HTMLElement): void {
  if (!host.hidden) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (host.dataset.mounted === "true") return;
  host.dataset.mounted = "true";
  const slot = h("div", { style: "margin-top:var(--space-3)" }, skeletonRows(3));
  host.replaceChildren(
    h("h2", { class: "page-header__title", style: "font-size:var(--text-md)" }, "Replace these credentials"),
    slot,
  );
  void loadFormContext(engine).then((fctx) => {
    if (fctx === null) return;
    slot.replaceChildren(destinationForm(engine, fctx, buildReplaceOpts(st, reload)));
  });
}

// renderDeployFallback renders the deploy-time configuration (or an env record without a
// named source): say so plainly, and keep the console-set path one disclosure away. The
// form mounts on first open so the demoted section costs nothing until asked for. It
// appends the card and the disclosure to wrap.
export function renderDeployFallback(engine: EngineClient, st: DestinationStatus, reload: () => void, wrap: HTMLElement, card: HTMLElement): void {
  // Deploy-time configuration (or an env record without a named source): say so
  // plainly, and keep the console-set path one disclosure away. The form mounts on
  // first open so the demoted section costs nothing until asked for.
  if (st.source === "deploy") {
    // The badge already names the deploy-time fact; the note carries only the
    // precedence rule, once.
    card.appendChild(
      noteQuiet(h("p", "Saving a destination here takes precedence; the deploy configuration remains the fallback.")),
    );
  }
  wrap.appendChild(card);

  // One line naming what the header's "Add a destination" button actually opens in THIS
  // state, and what it costs: this disclosure is the only add surface a deploy-bound
  // destination has, because a second destination cannot itself be deploy-time
  // configuration (DEST-ADD-BUTTON-DEPLOY-STATE). Said once, beside the
  // control it describes, matching multiple-destinations.mdx's "Add your destinations
  // first" step.
  wrap.appendChild(
    noteQuiet(
      h(
        "p",
        "Adding a destination here moves from this deploy-time binding to console-managed destinations, verified live the same way as any other. You will need an R2 API token key pair (or equivalent S3-compatible credentials) to set one up.",
      ),
    ),
  );

  const formHost = h("div");
  let mounted = false;
  const details = collapsedSection("Replace from the console", formHost) as HTMLDetailsElement;
  details.addEventListener("toggle", () => {
    if (!details.open || mounted) return;
    mounted = true;
    formHost.replaceChildren(skeletonRows(3));
    void loadFormContext(engine).then((fctx) => {
      if (fctx === null) {
        // A 401 already routed to signed-out; the disclosure body is a skeleton until something replaces it.
        formHost.replaceChildren(sessionEnded());
        return;
      }
      // An EFFECTIVE destination exists (deploy-time/env), so saving over it is a
      // replace with the same consequence as the console-set path: confirm it.
      formHost.replaceChildren(destinationForm(engine, fctx, { confirmReplace: true, onSaved: reload }));
    });
  });
  wrap.appendChild(details);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
