// The destination lever ACTION handlers (verify / make-default / remove with the orphan-guard force path /
// replace / the console-lever and deploy-fallback wiring), split out of destination-cards.ts so the card and
// drawer RENDERERS stay presentational (guardrail: file size + function size). No module-level mutable state
// is shared: every handler crosses calls via explicit (engine, st, reload) arguments.
//
// No-custody invariants kept: every string a handler surfaces names something the owner set or an engine
// verdict, never a credential; every server string enters the DOM via textContent / the typed h() builder.

import type { DestinationList, DestinationStatus, EngineClient, OwnerActionResult } from "../api.ts";
import { isOwnerActionQueuedResult } from "../api.ts";
import { typeToConfirm } from "../components/confirm.ts";
import { sessionEnded, stepUpAwareText } from "../components/error-view.ts";
import { noteQuiet, skeletonRows } from "../components/feedback.ts";
import { confirmModal } from "../components/modal.ts";
import { requireChange } from "../components/require-change.ts";
import { toast } from "../components/toast.ts";
import type { ChangeRef } from "../lib/change-ref.ts";
import { h } from "../lib/dom.ts";
import { isStepUpRequired, isUnauthorised } from "../lib/errors.ts";
import { goSignedOut } from "../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../lib/pending-change-toast.ts";
import { collapsedSection } from "./common.ts";
import { destinationForm } from "./destination-form.ts";
import { type DestinationFormOpts, loadFormContext } from "./destination-form-fields.ts";
import { providerKind } from "./destination-provider-kind.ts";

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
// future backup lands, which is why the engine gates it behind a fresh identity check; unlike Replace and
// Remove, this lever needs its own confirm so the operator is never taken straight into a passkey prompt
// with nothing said first. It stays a named function rather than an inline options object because
// makeDefault is the single wiring and this is the sentence it opens with.
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
// IT IS THE ONLY WIRING: both the card lever and the drawer lever call this same function, so they can
// never diverge on the confirmation, the change reference, or what they say about a queued result. The
// engine change-controls dest-default (owner-action.ts), so with Require Change Number ON, only a lever
// that collects and passes a change reference can record one; a lever with its own separate handler could
// silently drop that field and be refused at the engine with no way to supply it. The `btn` argument
// exists only because the card lever owns a button it must re-enable; that is the one genuine difference
// between the two callers.
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
      toast({ message: `Could not set the default. ${ownerMutationRefusalText(err)}`, tone: "warn" });
    } finally {
      // PAINT FIRST, THEN LEAVE, on every path, including the hand-off to goSignedOut: the nav bridge is a
      // no-op until app.ts installs it, so a frozen lever is what the operator would be left looking at
      // otherwise. On the success path reload rebuilds the card and this destination is the default by then,
      // so the lever is not rendered again anyway.
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
    // st.id === undefined routes to the singular clear (setDestination(null), below), which carries only
    // the in-use check: it never runs the orphan guard, so its text must never say "only proven copy".
    body: lastOne
      ? "This is your only destination: backups will fail until a new one is set (or the deploy-time configuration takes over). The engine refuses the removal while this destination holds the only proven copy of a run. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again."
      : st.id === undefined
        ? "The engine refuses the removal while a downpipe still writes to this destination. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again."
        : st.isDefault
          ? "It is the default, so another destination is promoted to default. The engine refuses the removal while this destination holds the only proven copy of a run. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again."
          : "The engine refuses the removal while a downpipe still writes to this destination, or while it holds the only proven copy of a run. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is removed and you can start again.",
    confirmLabel: "Remove",
    variant: "danger",
  }).then(async (okd) => {
    if (!okd) return;
    // Change management (owner opt-in): removing a destination is a change-controlled action, so collect a
    // change reference after the removal is confirmed (a no-op when the policy is off). On cancel, do nothing.
    const cr = await requireChange(engine, "Remove this destination", "destination-delete");
    if (!cr.proceed) return;
    // done reads the removal's notice, when the response carries one: the sentence the engine returns
    // naming what the removal cost (a force dropped runs, or older runs the run history no longer holds).
    // Warn tone: it reports a loss, not a plain success. With no notice, "Destination removed." keeps the
    // toast's success default. Typed over BOTH result shapes this closure can see: the multi-destination
    // remove (DestinationList, which carries notice) and the legacy singular clear via setDestination
    // (DestinationStatus, which never does) when st.id is absent.
    const done = (res: OwnerActionResult<DestinationList> | OwnerActionResult<DestinationStatus>): void => {
      if (res.status === "queued") {
        surfaceQueuedOwnerAction("Removing this destination");
        return;
      }
      const notice = "notice" in res.value ? res.value.notice : undefined;
      if (notice !== undefined && notice !== "") {
        toast({ message: notice, tone: "warn" });
      } else {
        toast({ message: "Destination removed." });
      }
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
      toast({ message: `Could not remove the destination. ${ownerMutationRefusalText(err)}`, tone: "warn" });
    };
    const fail = (err: unknown): void => {
      if (isUnauthorised(err)) {
        goSignedOut();
        return;
      }
      // The engine's orphan guard refused this non-force removal because the destination is the
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
// is the only proven copy of one or more backed-up runs. The reason is surfaced verbatim
// by the transport, so we key on its stable phrase. An "in use by N downpipe(s)" refusal is deliberately
// NOT matched: those downpipes must be reassigned first; force does not clear them.
function isOrphanGuardError(err: unknown): boolean {
  return errMsg(err).toLowerCase().includes("only proven copy");
}

// engineRefusalText peels the transport's envelope off an owner-mutation failure so the ENGINE's own
// sentence can be shown WHOLE. A destination-removal refusal names a run count, every affected downpipe
// (up to five, then a plain "and N more"), and the exact step that clears it; cutting it short drops the
// closing instruction and, on some refusals, the warning that force loses runs. parseJsonOrOwnerAction
// folds a non-2xx reason in as `<verb>: <reason>: <status>` (unlike the plain-parseJson path, which
// discards the body and throws `<verb>: <status>`), so the reason is present here and only needs
// unwrapping.
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
  return body === "" ? null : body;
}

// ownerMutationRefusalText is what a PLAIN refusal toast (not the force-remove dialogue) puts after its
// lead sentence, for the two owner mutations on this file that route through parseJsonOrOwnerAction and so
// can carry an engine sentence in the same envelope engineRefusalText unwraps: remove and set-default. It
// shows the ENGINE's own sentence alone, never spliced behind the transport's verb and status (an "in use
// by N downpipe(s)" refusal names the downpipes to reassign; that instruction belongs in front of the
// operator on its own, not trailing a fragment such as "remove destination: ... : 400").
//
// Step-up is checked FIRST and bypasses engineRefusalText entirely: a cancelled or refused ceremony's
// message is `<verb>: stepup-required: 401`, which matches the same three-part shape engineRefusalText
// unwraps, and would otherwise read the ceremony's internal marker as if it were the engine's sentence.
// stepUpAwareText already gives that state its own classified advice.
//
// Anything else with no engine sentence to unwrap (a network failure, a 500 with no body) falls back to
// stepUpAwareText's plain text, so the toast is never left empty.
function ownerMutationRefusalText(err: unknown): string {
  if (isStepUpRequired(err)) return stepUpAwareText(err);
  return engineRefusalText(err) ?? stepUpAwareText(err);
}

// orphanRunCount reads the at-risk run count straight off the engine's own orphan-guard sentence (for
// example "6 backed-up run(s)"), never a console-computed figure: the console holds no run count of its
// own for a destination. The pattern is strict (the exact phrase the guard's refusal always leads with),
// so a differently-worded engine sentence answers null rather than matching some other number in it.
//
// EXPORTED SO IT CAN BE GRADED against the engine's own refusal text directly, rather than only through
// the rendered dialogue.
export function orphanRunCount(refusal: unknown): number | null {
  const text = engineRefusalText(refusal);
  if (text === null) return null;
  const m = /\bonly proven copy of (\d+) backed-up run\(s\)/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// forceLossSentence is the loss line the force-remove dialogue leads with. It mirrors the engine's own
// words for the count ("downpipes then cannot restore those 6 run(s)") rather than composing a fresh
// sentence around a parsed number: nothing here should read as the console's own claim about what force
// costs. When the count cannot be parsed from the engine's sentence, this falls back to that sentence on
// its own rather than inventing a number.
function forceLossSentence(refusal: unknown): string | null {
  const count = orphanRunCount(refusal);
  if (count !== null) return `Downpipes then cannot restore those ${count} run(s).`;
  return engineRefusalText(refusal);
}

// offerForceRemove runs the highest-consequence destination action behind a type-to-confirm gate.
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
// GENERIC ADVICE ORDERING. The advice deliberately does not lead with "wait for the replicate pass": that
// pass runs only for a downpipe configured with two or more destinations, so for a downpipe writing to one
// -- which is what the create wizard produces -- waiting cannot end. It does not lead with reassignment
// either: on a downpipe that pins nothing, there is no per-downpipe control to change, so reassignment
// reads as repointing the default, which walks silently past this very guard.
// test/validate-orphan-guard-reason-on-screen.ts asserts this file's exact copy, so keep any change to
// this wording in sync with that validator.
function offerForceRemove(
  engine: EngineClient,
  st: DestinationStatus,
  change: ChangeRef | undefined,
  done: (res: OwnerActionResult<DestinationList>) => void,
  fail: (err: unknown) => void,
  refusal?: unknown,
): void {
  if (st.id === undefined) return;
  const id = st.id;
  const matchValue = st.label !== undefined && st.label !== "" ? st.label : id;
  // The loss line leads: what force costs, in the engine's own count, before the operator ever reaches
  // the type-to-confirm field. It renders only when there is something to say (the engine's sentence
  // unwrapped to something at all).
  const loss = forceLossSentence(refusal);
  void typeToConfirm({
    title: "Force-remove this destination?",
    impactSentence:
      "This destination is the only proven copy of one or more backed-up runs. Force-removing it DROPS those copies: their bytes stay in the bucket but become unaddressable with its credentials gone, so those runs can no longer be restored. This cannot be undone.",
    extra: [
      ...(loss !== null ? [h("p", { class: "field__hint" }, loss)] : []),
      // The engine's sentence is shown whole (engineRefusalText no longer cuts it), and it can run well
      // past what fits in view alongside the ceremony copy below. Its own bounded, scrollable box keeps
      // the loss line above and the type-to-confirm field below always reachable without scrolling past
      // a long quote first; tabindex + role/aria-label keep the box itself reachable by keyboard.
      ...(engineRefusalText(refusal) !== null
        ? [
            h(
              "p",
              { class: "field__hint field__hint--scroll", tabindex: "0", role: "region", "aria-label": "The engine's refusal message" },
              `The engine refused with: ${engineRefusalText(refusal)}`,
            ),
          ]
        : []),
      h(
        "p",
        { class: "field__hint" },
        "Prefer the step the engine names above. Copies are made by the replicate pass, which runs only for a downpipe configured with two or more destinations, so a downpipe writing to one destination has to be given a second before any wait can help. Use force only when you accept losing those copies.",
      ),
    ],
    // The ceremony note comes AFTER the type-to-confirm field, not before it: the loss is what the
    // operator weighs before typing the match value, and the passkey step is what happens once they have
    // and pressed Force-remove, so it reads last, in the order it happens.
    after: [
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
// EXPORTED SO IT CAN BE GRADED. Being "visible here" is not the same as being checked: every cell drives
// the form builder directly, so nothing on its own exercises the status-to-opts hop, and a mutation that
// deletes a line from this spread (for example azureEntra) can survive the whole Azure suite undetected.
// That hop is what keeps a destination from losing its Entra principal on edit, so exporting this
// function lets a dedicated assertion cover it rather than relying on the eye.
export function buildReplaceOpts(st: DestinationStatus, reload: () => void): DestinationFormOpts {
  // The store the destination being replaced already uses, so Replace opens on the SAME provider: an S3
  // destination's Replace opens on S3-compatible with its own bucket, never on Cloudflare R2 with R2's
  // first discovered bucket selected. providerKind reads only st.endpointHost and st.envKind, never a live
  // engine call, so this never guesses a NAMED vendor the host does not actually carry: a host it does not
  // recognise reads back as "s3", the form's generic S3-compatible choice, the identical reading the
  // Destinations badge and the Map already give the same status.
  const provider = providerKind(st);
  return {
    confirmReplace: true,
    onSaved: reload,
    ...(st.id !== undefined ? { editId: st.id } : {}),
    ...(st.label !== undefined ? { initialLabel: st.label } : {}),
    initialProvider: provider,
    ...(st.bucket !== undefined ? { initialBucket: st.bucket } : {}),
    // The endpoint field exists only on the S3-compatible/GCS/Azure variant of the form (R2's endpoint is
    // derived from the account id, never typed), so it is carried only when Replace is opening on one of
    // those, and built back into the https:// URL shape the field's own validator (endpointShapeError)
    // requires from the bare host DestinationStatus stores.
    ...(provider !== "r2" && st.endpointHost !== undefined ? { initialEndpoint: `https://${st.endpointHost}` } : {}),
    ...(st.region !== undefined ? { initialRegion: st.region } : {}),
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
      noteQuiet(h("p", "A destination saved here joins this one. This deploy-time destination stays the default until you make the new one the default.")),
    );
  }
  wrap.appendChild(card);

  // One line naming what the header's "Add a destination" button actually opens in THIS
  // state, and what it costs: this disclosure is the only add surface a deploy-bound
  // destination has, because a second destination cannot itself be deploy-time
  // configuration. Said once, beside the control it describes, matching
  // multiple-destinations.mdx's "Add your destinations first" step.
  wrap.appendChild(
    noteQuiet(
      h(
        "p",
        "Adding a destination here keeps this deploy-time binding and adds the new one beside it, verified live the same way as any other. You will need an R2 API token key pair (or equivalent S3-compatible credentials) to set one up.",
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
      // Saving here ADDS a destination: the engine seeds the deploy-time binding as the default
      // (ensureDeployDestSeeded) and the new one joins as a non-default member, so there is nothing
      // replaced to confirm.
      formHost.replaceChildren(destinationForm(engine, fctx, { confirmReplace: false, onSaved: reload }));
    });
  });
  wrap.appendChild(details);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
