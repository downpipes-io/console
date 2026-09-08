// The Canary screen's rendered SECTIONS: the status hero block, the flight-watch poller, the
// per-destination eight-aspect proof, the "what one green canary proves" pitch, the owner settings
// card and the recent-flight ring. Each renders the redaction-safe engine view. Every server string
// enters the DOM via the typed h() builder / textContent (no innerHTML over server data).

import type { CanaryAspectResult, CanaryCheck, CanaryView, EngineClient } from "../api.ts";
import { isPendingResult } from "../api.ts";
import { noteQuiet } from "../components/feedback.ts";
import { disabledWithReason, field } from "../components/field.ts";
import { confirmModal } from "../components/modal.ts";
import { badge, type StatusTone, statusWithLabel } from "../components/status.ts";
import { toast } from "../components/toast.ts";
import { recordContractSkew } from "../lib/client-diag/ring.ts";
import { h, svgIcon, text } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { relativeTime } from "../lib/format.ts";
import { ICON_EXTERNAL } from "../lib/icons.ts";
import { ailingCauseLine, CANARY_COPY } from "./canary-copy.ts";
import { destStateLabel, toneForAspect, toneForStatus } from "./canary-tone.ts";
import { canCap, canDo, capGateReason, collapsedSection, gateReason } from "./common.ts";

// Flight-watch poll timing. FLIGHT_TIMEOUT_MS must stay at or above the engine's own canary
// run timeout; if the engine ceiling changes, raise this in step or the client gives up early.
const FLIGHT_INITIAL_DELAY_MS = 1200;
const FLIGHT_POLL_INTERVAL_MS = 1600;
const FLIGHT_TIMEOUT_MS = 30_000;
const FLIGHT_SETTLE_DELAY_MS = 1500;
const FLIGHT_TIMEOUT_RELOAD_DELAY_MS = 200;

// fact renders one quiet label/value pair for the hero strip.
function fact(label: string, value: string): HTMLElement {
  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:2px" },
    h("span", { style: "font-size:var(--text-xs);color:var(--text-muted)" }, label),
    h("span", { style: "font-size:var(--text-sm);color:var(--text)" }, value),
  );
}

function cadenceLabel(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "Every 60 minutes" : `Every ${seconds / 3600} hours`;
  return `Every ${Math.round(seconds / 60)} minutes`;
}

// CanaryCallbacks groups the three hero callbacks the owning screen passes down: reload (a full
// screen refresh), rerender (a light figure + status repaint during a flight) and simulate (the
// client-side death preview). Passing them as one config object keeps renderStatusBlock under the
// parameter limit.
export interface CanaryCallbacks {
  reload(): void;
  rerender(v: CanaryView): void;
  simulate(): void;
}

// The break-glass-only "ailing by posture" rail used to live here. It is gone because the state it
// described is gone: a break-glass-only flight now reads its own cell back with that flight's per-run
// master, so it decrypts, restores and verifies like any other, and ailing once again means only that a
// check could not complete. Every ailing flight is therefore a genuine check problem and reads as one.

// renderStatusBlock builds the status side of the hero: the badge, the headline line, the key facts
// and the controls. The bird FIGURE is a separate, persistent element (owned by render()) so it can
// transition between poses; this block is the part that re-renders on each update. rerender repaints
// the figure + this block during a flight (the disclosures below stay put); simulate runs the
// client-side death preview. `preview` marks the death demo's interim take-off state, so it never
// reads as a live flight under the demo banner.
export function renderStatusBlock(engine: EngineClient, view: CanaryView, root: HTMLElement, cb: CanaryCallbacks, preview = false): HTMLElement {
  const flying = view.inFlight;
  const st = view.status;
  const tone: StatusTone = flying ? "info" : toneForStatus(st);
  const label = flying ? (preview ? "Preview" : "In flight") : CANARY_COPY.states[st].label;
  const line = flying
    ? preview
      ? "Preview: the bird takes off, then one byte strays, so you can watch exactly how a death reads. Nothing is sent to the engine."
      : "The canary is flying right now: writing its known data, sealing it, reading it back, restoring it and verifying every byte."
    : CANARY_COPY.states[st].line;

  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (the canary's live
  // status). No behaviour; no effect on the genuine console.
  const heroBadge = badge(tone, label, { dot: tone !== "neutral" });
  heroBadge.dataset.tourId = "canary-status";
  const status = h(
    "div",
    { style: "display:flex;flex-direction:column;gap:var(--space-3)" },
    heroBadge,
    h("p", { style: "color:var(--text);margin:0;max-width:46ch" }, line),
  );
  // Which destinations failed, named, shown only on a death (the aggregate is dead if ANY did).
  const deadNote = deadDestNote(view, flying);
  const ailingNote = ailingDestNote(view, flying);
  if (deadNote) status.appendChild(deadNote);
  if (ailingNote) status.appendChild(ailingNote);

  // Quiet facts: destinations, last flight, next flight, the flight number.
  const aliveCount = view.dests.filter((d) => d.status === "alive").length;
  const facts = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--space-5) var(--space-6)" });
  facts.appendChild(fact("Destinations", view.dests.length === 0 ? "none yet" : `${view.flyingToAll ? "all " : ""}${view.dests.length}${aliveCount < view.dests.length ? ` (${aliveCount} alive)` : ""}`));
  facts.appendChild(fact("Last flight", view.lastRunAt ? relativeTime(view.lastRunAt) : "not yet"));
  if (view.config.enabled) facts.appendChild(fact("Next flight", flying ? "in flight now" : view.nextRunAt ? relativeTime(view.nextRunAt) : "due shortly"));
  facts.appendChild(fact("Cadence", cadenceLabel(view.config.intervalSeconds)));
  status.appendChild(facts);

  // Controls: fly now (operator and up) and a safe, client-side death preview.
  status.appendChild(renderControls(engine, view, root, cb));

  return status;
}

// deadDestNote names the failed destinations on a death (the aggregate is dead if ANY did),
// returning null while in flight or when every destination is alive.
// ailingDestNote names WHY an ailing destination is ailing. It mirrors deadDestNote, which
// has always named the dead ones: an ailing flight proves nothing either way, and until the engine classified
// the fault there was nothing specific to say, so this screen said nothing at all. An expired credential and a
// black-holed endpoint produced identical copy and sent the operator looking in the wrong place.
//
// Only destinations that actually reported a recognised cause are named. A flight with none renders nothing
// rather than a fabricated reason, which is the same rule deadDestNote follows for deadReason.
function ailingDestNote(view: CanaryView, flying: boolean): HTMLElement | null {
  if (flying) return null;
  const ailing = view.dests.filter((d) => d.status === "ailing");
  if (ailing.length === 0) return null;
  const named = ailing
    .map((d) => ({ label: d.label, line: ailingCauseLine(d.lastCheck?.ailingCause) }))
    .filter((x): x is { label: string; line: string } => x.line !== null);
  if (named.length === 0) return null;
  // One line per distinct reason, so two destinations failing the same way read as one fact rather than two.
  const byLine = new Map<string, string[]>();
  for (const n of named) byLine.set(n.line, [...(byLine.get(n.line) ?? []), n.label]);
  return noteQuiet(text([...byLine].map(([line, labels]) => `${labels.join(", ")}: ${line}`).join(" ")));
}

function deadDestNote(view: CanaryView, flying: boolean): HTMLElement | null {
  const deadDests = view.dests.filter((d) => d.status === "dead");
  if (flying || deadDests.length === 0) return null;
  const which = deadDests.length >= view.dests.length ? "Every destination failed" : `${deadDests.length} of ${view.dests.length} destinations failed`;
  // Group by each destination's OWN reason (mirrors ailingDestNote below): destinations dying for
  // DIFFERENT reasons must not be flattened to deadDests[0]'s reason, or a customer reading "endpoint
  // unreachable" against a destination that actually failed a signature check is sent looking in the
  // wrong place. One line per distinct reason, so destinations sharing a reason still read as one fact.
  // AND AN ABSENT REASON IS NOT A CORRUPTION FINDING. The fallback here used to read "a byte strayed from
  // the known data", which is the most specific and most alarming thing this screen can say, asserted from
  // no evidence at all: deadReason is nullable on the wire, and a flight that died for a reason the engine
  // did not report rendered as a byte-level corruption claim against a named destination. That is the exact
  // rule ailingDestNote's comment above already says this function follows, and it did not.
  const fallback = "the engine did not report why";
  const byReason = new Map<string, string[]>();
  for (const d of deadDests) {
    const reason = d.lastCheck?.deadReason ?? fallback;
    byReason.set(reason, [...(byReason.get(reason) ?? []), d.label]);
  }
  const detail = [...byReason].map(([reason, labels]) => `${labels.join(", ")}: ${reason}`).join(" ");
  return noteQuiet(text(`${which}. ${detail}`));
}

// renderControls builds the hero controls: fly-now (operator and up; disabled-with-reason otherwise
// and while a flight is in progress) and the safe client-side death preview (hidden while flying).
function renderControls(engine: EngineClient, view: CanaryView, root: HTMLElement, cb: CanaryCallbacks): HTMLElement {
  const flying = view.inFlight;
  const controls = h("div", { style: "display:flex;flex-wrap:wrap;gap:var(--space-2)" });
  if (view.config.enabled) {
    const canFly = canCap("run.trigger");
    // data-tour-id is an inert hook the public tour's try-it beat spotlights (the visitor genuinely
    // flies a canary from the guided walk; the faked engine makes it safe and reversible).
    const btn = h("button", { "data-dp": "canary-sections.button.controls", class: "btn btn--secondary", type: "button", dataset: { tourId: "canary-fly" } }, flying ? "Canary in flight..." : "Fly the canary now");
    if (!canFly || flying) {
      (btn as HTMLButtonElement).disabled = true;
      if (!canFly) btn.setAttribute("title", capGateReason("run.trigger"));
    } else {
      btn.addEventListener("click", () => {
        // Show the take-off immediately (the figure transitions up), then watch it land or die.
        cb.rerender({ ...view, inFlight: true });
        engine
          .runCanary()
          .then(() => {
            toast({ message: "Canary away. Watch it fly; it lands or dies in a moment." });
            startFlightWatch(engine, root, view.runSeq, cb.rerender, cb.reload);
          })
          .catch((err) => {
            cb.rerender(view);
            toast({ message: isUnauthorised(err) ? "Your session needs refreshing." : "Could not start the flight.", tone: "warn" });
          });
      });
    }
    controls.appendChild(btn);
  }
  // Preview a death: a pure client-side demonstration so the operator can watch the bird fly, fail and
  // die (the skeleton) without waiting for, or causing, a real one. It never calls the engine.
  if (!flying) {
    const dbtn = h("button", { "data-dp": "canary-sections.button.dbtn", class: "btn btn--ghost btn--sm", type: "button", dataset: { tourId: "canary-preview" } }, "Preview a death");
    dbtn.setAttribute("title", "A simulation. It does not affect the live canary.");
    dbtn.addEventListener("click", cb.simulate);
    controls.appendChild(dbtn);
  }
  return controls;
}

// startFlightWatch polls the canary while a flight is in progress so the operator actually SEES the
// bird flapping, then settling to alive (it landed safely) or dead (it died). It keeps the bird
// airborne until a NEW flight has completed (runSeq advanced and no longer in flight), then lets the
// settled pose sit a beat before a full reload refreshes the proof and history. Best-effort: a poll
// error or a 30-second timeout falls back to a reload. It re-paints only the hero card. The screen
// root is passed in so a tick that fires after the operator navigated away (root.isConnected is
// false) returns without polling the engine or mutating a detached tree, matching sources-downpipes.
export function startFlightWatch(engine: EngineClient, root: HTMLElement, fromSeq: number, rerenderHero: (v: CanaryView) => void, reload: () => void): void {
  let elapsed = 0;
  const tick = (): void => {
    if (!root.isConnected) return; // the screen left the DOM: stop polling and mutating it
    void engine
      .getCanary()
      .then((v) => {
        if (!root.isConnected) return; // navigated away while the request was in flight
        const settled = !v.inFlight && v.runSeq > fromSeq;
        if (settled) {
          rerenderHero(v); // the real landed-or-died pose
          window.setTimeout(reload, FLIGHT_SETTLE_DELAY_MS); // let it register, then refresh the rest of the screen
          return;
        }
        rerenderHero({ ...v, inFlight: true }); // keep it airborne until the flight lands
        elapsed += FLIGHT_POLL_INTERVAL_MS;
        if (elapsed > FLIGHT_TIMEOUT_MS) {
          // The CLIENT ceiling expired while the engine still had the run in flight. The animation ends,
          // the screen reloads, and the operator reports "flights end abruptly" against a run that is in fact
          // still going. This is a client watch ceiling that has DRIFTED from the engine's run ceiling, which is
          // pure version skew, and it is indistinguishable from a run that genuinely died.
          recordContractSkew("watch-timeout-drift", "flight-watch");
          window.setTimeout(reload, FLIGHT_TIMEOUT_RELOAD_DELAY_MS);
          return;
        }
        window.setTimeout(tick, FLIGHT_POLL_INTERVAL_MS);
      })
      .catch(() => {
        if (!root.isConnected) return; // do not reload (which re-fetches) on a detached screen
        window.setTimeout(reload, FLIGHT_POLL_INTERVAL_MS);
      });
  };
  window.setTimeout(tick, FLIGHT_INITIAL_DELAY_MS);
}

// aspectRows renders the eight-aspect proof for one destination's latest flight (each aspect proving
// one thing about that destination and the archive path). With no flight yet it teaches what is coming.
function aspectRows(check: CanaryCheck | null): HTMLElement {
  if (!check) {
    return noteQuiet(text("Awaiting this destination's first flight: write, delete, seal, signatures, RUNLOG freshness, byte-exact integrity, restore and restore-verify, all on known data."));
  }
  const byKey = new Map<string, CanaryAspectResult>();
  for (const a of check.aspects) byKey.set(a.key, a);
  const list = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-2)" });
  for (const spec of CANARY_COPY.aspects) {
    const got = byKey.get(spec.key);
    const outcome = got ? got.outcome : "skip";
    const { tone, label } = toneForAspect(outcome);
    const detail = got?.detail ?? spec.proves;
    list.appendChild(
      h(
        "div",
        { class: "canary-proof-row", style: "display:grid;grid-template-columns:minmax(150px,auto) auto 1fr;gap:var(--space-3);align-items:baseline;padding:var(--space-2) 0;border-top:1px solid var(--border-subtle)" },
        statusWithLabel(tone, spec.label),
        badge(tone === "neutral" ? "default" : tone, label),
        h("span", { style: "color:var(--text-muted);font-size:var(--text-sm)" }, detail),
      ),
    );
  }
  return list;
}

// renderDestinations is eager section 2: one row PER destination the canary flies to, each showing the
// destination's name, its liveness, and an expandable eight-aspect proof of its latest flight. This is
// the "which destinations it is flying to and their respective results" view.
export function renderDestinations(view: CanaryView): HTMLElement {
  const wrap = h("section", { style: "display:flex;flex-direction:column;gap:var(--space-3)" });
  // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (what a canary
  // checks each flight), set on an INLINE span wrapping the heading TEXT so the "?" sits beside the words, not at
  // the page edge. No behaviour; no effect on the genuine console.
  wrap.appendChild(h("h2", { class: "section-heading" }, h("span", { dataset: { tourId: "canary-aspects" } }, view.dests.length === 1 ? "What the last flight proved" : `Each destination, and what its last flight proved (${view.dests.length})`)));

  if (view.dests.length === 0) {
    wrap.appendChild(noteQuiet(text("The canary has no destination to fly to yet. Add a destination, and the canary will validate it every flight.")));
    return wrap;
  }

  for (const d of view.dests) {
    const tone = toneForStatus(d.status);
    const open = d.status === "dead" || d.status === "ailing" || view.dests.length === 1;
    const summary = h(
      "summary",
      { style: "cursor:pointer;list-style:none;display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) 0" },
      badge(tone, destStateLabel(d.status), { dot: tone !== "neutral" }),
      h("span", { style: "color:var(--text);font-weight:550;min-width:0" }, d.label + (d.isDefault ? " (default)" : "")),
      h("span", { style: "color:var(--text-muted);font-size:var(--text-sm);margin-left:auto;white-space:nowrap;flex:none" }, d.lastRunAt ? relativeTime(d.lastRunAt) : "not yet flown"),
    );
    const details = h("details", { class: "disclosure", style: "border-top:1px solid var(--border-subtle)" }, summary, h("div", { style: "padding-bottom:var(--space-3)" }, aspectRows(d.lastCheck)));
    if (open) (details as HTMLDetailsElement).open = true;
    wrap.appendChild(details);
  }
  return wrap;
}

// renderProves is the educational disclosure: what one green canary proves (the pitch).
export function renderProves(): HTMLElement {
  const ul = h("ul", { style: "margin:0;padding-left:var(--space-5);display:flex;flex-direction:column;gap:var(--space-2);color:var(--text)" });
  for (const line of CANARY_COPY.proves) ul.appendChild(h("li", line));
  return collapsedSection("What one green canary proves", ul);
}

// renderSettings is the owner disclosure: enable/disable (with an honest warning), repoint the
// destination once more than one exists, and fly-now. Non-owners see it disabled-with-reason.
// checkboxRow builds a checkbox + label row. disabledReason is the STANDING owner-gate: a
// non-owner still tabs onto the checkbox and hears why it is refused, via the shared
// disabledWithReason primitive, rather than the box silently vanishing from the tab order. A
// caller that later needs to lock the box for a transient reason (mid-save) uses the native
// `disabled` attribute directly on `.input` instead,
// the same way the cadence select above locks itself while its own save is in flight: that is a
// fleeting UI lock around a network round trip, not a permission refusal with a reason worth
// reading, and the two states never overlap in practice (a non-owner's box is aria-disabled and
// never reaches the change handler that would set the native lock at all).
function checkboxRow(id: string, labelText: string, opts: { checked: boolean; disabledReason: string | null }): { row: HTMLElement; input: HTMLInputElement; setDisabled: (reason: string | null) => void } {
  const input = h("input", { type: "checkbox", id }) as HTMLInputElement;
  input.checked = opts.checked;
  const reasonEl = h("p", { class: "field__hint", id: `${id}-disabled-reason`, hidden: true });
  reasonEl.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  const setDisabled = disabledWithReason(input, reasonEl);
  setDisabled(opts.disabledReason);
  const row = h(
    "div",
    { style: "display:flex;flex-direction:column;gap:2px" },
    h("div", { style: "display:flex;align-items:center;gap:var(--space-3)" }, input, h("label", { for: id, style: "color:var(--text)" }, labelText)),
    reasonEl,
  );
  return { row, input, setDisabled };
}

// SaveCanaryConfig persists a canary-config patch, toasting the queued-for-approval or success
// message and reloading on success, or reverting the control (onFail) and warning on failure.
type SaveCanaryConfig = (patch: { enabled?: boolean; destinationIds?: string[] | null; intervalSeconds?: number }, okMsg: string, onFail: () => void) => void;

// The cadence presets the owner may pick, all inside the engine's clamp of 300s..86400s
// (scheduler-do-canary.ts:175); 3600 is CANARY_DEFAULT_INTERVAL_SECONDS. Kept as a fixed preset set
// rather than a free number so a value outside the clamp can never be offered.
const CANARY_CADENCE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "3600", label: "Every 60 minutes (default)" },
  { value: "21600", label: "Every 6 hours" },
  { value: "86400", label: "Once a day" },
];

function makeSaveCanaryConfig(engine: EngineClient, reload: () => void): SaveCanaryConfig {
  return (patch, okMsg, onFail): void => {
    engine
      .setCanaryConfig(patch)
      .then((res) => {
        toast({ message: isPendingResult(res) ? "Change queued for approval." : okMsg });
        reload();
      })
      .catch((err) => {
        onFail();
        toast({ message: isUnauthorised(err) ? "Your session needs refreshing." : "Could not update the canary.", tone: "warn" });
      });
  };
}

// renderDestinationPicker builds the "which destinations the canary flies to" controls: the
// fly-to-all toggle, and (when not flying to all) the per-destination checkbox list. Each control
// persists through saveConfig and reverts itself on failure. Owner-gated like the rest of settings.
function renderDestinationPicker(view: CanaryView, owner: boolean, saveConfig: SaveCanaryConfig): HTMLElement {
  if (view.allDestinations.length === 0) {
    return noteQuiet(text("The canary flies to your default destination. Add destinations and the canary fans out to validate every one of them."));
  }
  const destWrap = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-3)" });
  destWrap.appendChild(h("div", { style: "font-size:var(--text-sm);color:var(--text-muted)" }, "Destinations the canary flies to"));

  const all = checkboxRow("canary-all", `Fly to all destinations (${view.allDestinations.length}), including any added later`, {
    checked: view.flyingToAll,
    disabledReason: owner ? null : gateReason("owner"),
  });
  all.input.addEventListener("change", () => {
    all.input.disabled = true; // transient busy-lock (mid-save), not a permission refusal -- see checkboxRow.
    // On: all destinations (null). Off: pin the current effective set, so it starts with all selected.
    const pinned = view.dests.map((d) => d.destinationId).filter((x): x is string => typeof x === "string");
    saveConfig({ destinationIds: all.input.checked ? null : pinned.length > 0 ? pinned : view.allDestinations.map((d) => d.id) }, "Canary destinations updated.", () => {
      all.input.checked = view.flyingToAll;
      all.input.disabled = false;
    });
  });
  destWrap.appendChild(all.row);

  // Dangling pins (RG8): destinations the operator PINNED that no longer exist. They render no checkbox
  // below, because the list is built from allDestinations, so without this note the canary silently stops
  // proving a destination that was deliberately chosen. Named, so the operator knows which one to
  // re-create or re-pin, and worded as a loss of proof rather than a configuration error, because the
  // configuration was valid when it was made.
  const dangling = view.danglingPins ?? [];
  if (dangling.length > 0) {
    destWrap.appendChild(
      noteQuiet(
        text(
          `${dangling.length} pinned destination${dangling.length === 1 ? "" : "s"} no longer exist${dangling.length === 1 ? "s" : ""} (${dangling.join(", ")}), so the canary is not proving ${dangling.length === 1 ? "it" : "them"} any more. It still flies to the destinations below. Re-create the destination to resume proving it, or tick a replacement.`,
        ),
      ),
    );
  }

  if (!view.flyingToAll) {
    const selected = new Set(view.config.destinationIds ?? []);
    const listEl = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-2);padding-left:var(--space-5)" });
    const inputs: HTMLInputElement[] = [];
    for (const d of view.allDestinations) {
      const r = checkboxRow(`canary-d-${d.id}`, d.label + (d.isDefault ? " (default)" : ""), {
        checked: selected.has(d.id),
        disabledReason: owner ? null : gateReason("owner"),
      });
      inputs.push(r.input);
      r.input.addEventListener("change", () => {
        const checked = view.allDestinations.filter((_x, i) => inputs[i]!.checked).map((x) => x.id);
        // Transient busy-lock (mid-save), not a permission refusal -- see checkboxRow. Only an owner's
        // change handler ever runs (a non-owner's box is aria-disabled and its input events are blocked),
        // so the native lock below and re-enable never race the owner-gate's own aria-disabled state.
        inputs.forEach((i) => {
          i.disabled = true;
        });
        saveConfig({ destinationIds: checked.length > 0 ? checked : null }, "Canary destinations updated.", () => {
          inputs.forEach((i) => {
            i.disabled = false;
          });
        });
      });
      listEl.appendChild(r.row);
    }
    destWrap.appendChild(listEl);
  }
  return destWrap;
}

export function renderSettings(engine: EngineClient, view: CanaryView, reload: () => void): HTMLElement {
  const owner = canDo("owner");
  const body = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-4)" });
  if (!owner) body.appendChild(noteQuiet(text(gateReason("owner"))));
  // Group-level doc link (the field audit's G2): the enable toggle and the destination picker below are one
  // owner-only settings group, so the link that explains what each control does lives on the group.
  body.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/assurance-audit/canary-operate#configuration-choices", target: "_blank", rel: "noreferrer noopener" },
      "About canary settings",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  const saveConfig = makeSaveCanaryConfig(engine, reload);

  // Enable / disable.
  const en = checkboxRow("canary-enabled", view.config.enabled ? "Canary is on (recommended)" : "Canary is off", {
    checked: view.config.enabled,
    disabledReason: owner ? null : gateReason("owner"),
  });
  en.input.addEventListener("change", () => {
    const next = en.input.checked;
    const apply = (): void => {
      en.input.disabled = true; // transient busy-lock (mid-save), not a permission refusal -- see checkboxRow.
      saveConfig({ enabled: next }, next ? "Canary on." : "Canary off.", () => {
        en.input.checked = !next;
        en.input.disabled = false;
      });
    };
    if (!next) {
      void confirmModal({ title: "Turn the canary off?", body: CANARY_COPY.disableWarning, confirmLabel: "Turn off", variant: "danger" }).then((yes) => {
        if (yes) {
          apply();
        } else {
          en.input.checked = true;
        }
      });
    } else {
      apply();
    }
  });
  body.appendChild(en.row);

  // The cadence. The engine accepts intervalSeconds and clamps it to 300s..86400s; the console offers
  // that range as presets so the owner sets it here with no command line (the doc and the engine both
  // said this was possible, but the control was never wired). A current interval that is not one of the
  // presets (set directly against the API) is preserved as a leading "(current)" option so opening the
  // picker never silently proposes to change it.
  const current = String(view.config.intervalSeconds);
  const presetValues = new Set(CANARY_CADENCE_PRESETS.map((p) => p.value));
  const cadenceOptions = presetValues.has(current)
    ? [...CANARY_CADENCE_PRESETS]
    : [{ value: current, label: `${cadenceLabel(view.config.intervalSeconds)} (current)` }, ...CANARY_CADENCE_PRESETS];
  const cadence = field({
    id: "canary-cadence",
    label: "How often the canary flies",
    kind: "select",
    value: current,
    options: cadenceOptions,
    hint: "How often the known-answer flight runs between your real backups. More often catches a broken destination sooner; less often costs fewer test writes. The engine holds this between 5 minutes and once a day.",
    doc: { href: "https://docs.downpipes.io/assurance-audit/canary-operate", anchor: "configuration-choices" },
  });
  // Disabled-with-reason, not the native `disabled` attribute: a non-owner still tabs onto
  // the control and hears why it is refused, rather than the select silently vanishing from the tab
  // order.
  if (!owner) cadence.setDisabled(gateReason("owner"));
  cadence.control.addEventListener("change", () => {
    const next = Number(cadence.control.value);
    if (!Number.isFinite(next) || next === view.config.intervalSeconds) return;
    cadence.control.setAttribute("disabled", "true");
    saveConfig({ intervalSeconds: next }, `Canary cadence set to ${cadenceLabel(next).toLowerCase()}.`, () => {
      cadence.control.value = current;
      cadence.control.removeAttribute("disabled");
    });
  });
  body.appendChild(cadence.el);

  // Which destinations to fly to.
  body.appendChild(renderDestinationPicker(view, owner, saveConfig));

  return collapsedSection("Canary settings", body);
}

// renderHistory is the recent-flights disclosure: the bounded ring, newest first, each a one-line
// outcome (time, status, and the byte delta or dead reason).
export function renderHistory(view: CanaryView): HTMLElement {
  const rows = h("div", { style: "display:flex;flex-direction:column;gap:var(--space-2)" });
  const recent = [...view.history].reverse();
  if (recent.length === 0) {
    rows.appendChild(noteQuiet(text("No flights yet.")));
  }
  for (const f of recent) {
    const { tone } = toneForAspect(f.status === "alive" ? "pass" : f.status === "dead" ? "fail" : "skip");
    const n = f.results.length;
    const dead = f.results.filter((r) => r.status === "dead");
    const detail =
      f.status === "alive"
        ? `${n} destination${n === 1 ? "" : "s"}, every byte returned exactly`
        : dead.length > 0
          ? `${dead.length} of ${n} failed: ${dead[0]?.deadReason ?? "the engine did not report why"}`
          : f.status === "ailing"
            ? "a flight could not complete"
            : // A FLIGHT WHOSE AGGREGATE IS DEAD BUT WHOSE per-destination ROWS CARRY NO DEAD ENTRY fell
              // through to "in progress" here, so a FAILED verdict rendered in the history as a benign
              // running state. The aggregate is the verdict; the rows are the detail, and missing detail
              // does not soften it.
              f.status === "dead"
              ? "the flight failed and the engine did not report which destination"
              : "in progress";
    const statusCell = statusWithLabel(tone, CANARY_COPY.states[f.status]?.label.split(",")[0] ?? f.status);
    // data-tour-id is an inert hook the public page-walkthrough tour pins a "?" info-point to (an honest FAILED
    // flight in the history). Set on the first FAILED (dead) flight's STATUS cell (content-sized) so the "?" sits
    // beside the words, not across the whole row. No behaviour; no effect on the genuine console.
    if (f.status === "dead" && !rows.querySelector('[data-tour-id="canary-failure"]')) statusCell.dataset.tourId = "canary-failure";
    const flightRow = h(
      "div",
      { class: "canary-flight-row", style: "display:grid;grid-template-columns:minmax(120px,auto) minmax(90px,auto) 1fr;gap:var(--space-3);align-items:baseline;padding:var(--space-2) 0;border-top:1px solid var(--border-subtle)" },
      h("span", { style: "color:var(--text-muted);font-size:var(--text-sm)" }, relativeTime(f.at)),
      statusCell,
      h("span", { style: "color:var(--text-muted);font-size:var(--text-sm)" }, detail),
    );
    rows.appendChild(flightRow);
  }
  return collapsedSection(`Recent flights (${view.history.length})`, rows);
}

// ---- WHY THE CANARY PICKER DOES NOT USE sources-downpipes/tick-order.ts (examined) --------
// renderDestinationPicker above builds its own destinationIds twice (the fly-to-all toggle at :346, the
// per-destination checkbox at :381), and both report the ticked ids in view.allDestinations LIST order,
// never the order they were ticked. That is the same shape as the fan-out bug the tick-order helper was
// written for, so it looks like a fourth copy owed the same repair. It is not, and this note is here so
// the next reader does not have to re-derive that.
//
// The fan-out list is ORDERED: index 0 is the PRIMARY a downpipe seals to (engine
// src/sched/destinations.ts primaryDestinationId, "the first non-blank destinationIds entry"), the docs
// page backing-up/multiple-destinations states the tick-order contract in as many words, and the detail
// view badges one destination primary and the rest copy. The CANARY list is a SET. Nothing reads element
// zero: primaryDestinationId is never called on a CanaryConfig (its call sites are reconcile-pass,
// retention-pass, seal-dispatch, scheduler-do-sre-alerting, scheduler-do and seal/replicate, every one
// of them on a downpipe config), the canary's own config type is separate (engine src/canary/types.ts),
// and its only consumer is engine src/sched/scheduler-do-canary.ts, which flies every entry in turn and
// keeps a per-destination liveness. The docs agree: canary-operate says an owner may "pin an explicit
// subset", and no canary page mentions an order.
//
// One position DOES bite, and it argues for keeping list order rather than against it.
// scheduler-do-canary.ts resolveEffectiveDests ends `ids.slice(0, CANARY_MAX_DESTS)` (12, engine
// src/canary/types.ts), so a pin longer than twelve is truncated by POSITION and the tail is never
// flown. In the fly-to-all case that same function truncates `list.map(d => d.id)`, the destination
// collection's own order. Emitting the pin in list order keeps those two truncations identical, so an
// owner who pins thirteen destinations loses exactly the ones they would have lost flying to all.
// Routing this picker through the tick-order helper would make which destination goes unproven depend on
// the order the boxes were clicked, which is worse. The engine already de-duplicates while preserving
// whatever order it is sent (scheduler-do-canary.ts setCanaryConfig), so it imposes nothing either way.
//
// The only other order-sensitive read is canaryOpOf's JSON.stringify comparison of prior against next,
// which labels the audit row "pin" rather than "cadence" when the list changes. A reorder alone would
// mislabel a no-op as a pin change. List order is deterministic, so that cannot fire here.
//
// This note sits at the END of the file on purpose: the field catalogue pins controls in this file at
// lines 293, 341, 374, 412 and 446, and an inline comment would shift them all and owe a re-pin.
