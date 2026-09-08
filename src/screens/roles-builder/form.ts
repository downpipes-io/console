// The left-hand half of the custom role builder: the builder body (the form + live preview + presets row +
// existing catalogue), the composer that wires the single BuilderState to every control, and the form sections
// (name/label, capability matrix, per-screen see/edit grid, presentation switch, landing picker, presets row).
// The single BuilderState drives everything; a re-render of the preview is triggered on every change. Moved
// verbatim from the roles-builder coordinator for size; it imports the shared leaf (./shared.ts) and the preview
// section (./preview.ts) one way, so it never forms a cycle.
//
// House style: Australian English, no em dashes, precise claims; the engine is the enforcement point.

import type { EngineClient } from "../../api.ts";
import { disabledWithReason, field } from "../../components/field.ts";
import { atMostChars, matchingPattern } from "../../components/field-bounds.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { loadDraft, saveDraft } from "../../lib/draft.ts";
import { ICON_EXTERNAL, ICON_SHIELD_CHECK } from "../../lib/icons.ts";
import {
  ALL_CAPABILITIES,
  builtinPreset,
  type Capability,
  CUSTOM_ROLE_NAME_PATTERN,
  type CustomRole,
  type CustomRoleProposal,
  OWNER_RESERVED_CAPABILITIES,
  type Presentation,
  SCREEN_WRITE_CAPABILITY,
  type SurfaceMode,
  titleCaseRole,
} from "../../lib/identity.ts";
import { capabilityPhrase } from "../capability-copy.ts";
import { catalogueCard, renderPreview, saveRow } from "./preview.ts";
import {
  BUILTIN_ROLES,
  type BuilderState,
  CAPABILITY_LABELS,
  canSetScreenEdit,
  composeProposal,
  creatorCapabilities,
  demoteEditsLosingWriteCap,
  draftHasContent,
  emptyBuilderState,
  nonHiddenScreens,
  ROLE_DRAFT,
  SURFACE_SCREENS,
  screenLabel,
  stateFromDraft,
  stateFromPreset,
} from "./shared.ts";

// groupDocLink is a group-level documentation link for a raw checkbox/radio group
// that is not a field(): the same .field__doc anchor field() renders, placed on the group as a whole. It
// opens in a new tab so the composer is not lost, and the external-link interstitial governs the hop,
// exactly as the per-field doc links do.
function groupDocLink(href: string, label: string): HTMLElement {
  return h("a", { class: "field__doc linklike", href, target: "_blank", rel: "noreferrer noopener" }, label, svgIcon(ICON_EXTERNAL, { size: 13 }));
}

// ---------------------------------------------------------------------------
// The builder body: the form (left) + the live preview (right), the presets row, and the existing
// catalogue. The single BuilderState drives everything; a re-render of the preview is triggered on every
// change, so the preview always reflects the current composition + the engine's verdict.
// ---------------------------------------------------------------------------

export function builderBody(engine: EngineClient, existing: CustomRole[], reload: () => void): HTMLElement {
  const wrap = h("div", { class: "stack" });

  // The existing-catalogue names, so the form can flag a name clash early (the engine still enforces).
  const existingNames = new Set(existing.map((r) => r.name));

  // The composer host: a fresh composer (form + preview) is rendered into it on first paint and again
  // whenever a preset is chosen, so picking a preset re-seeds the WHOLE form in place (not via a route
  // change that would discard the seed). The catalogue below it is stable.
  const composerHost = h("div");
  const renderInto = (state: BuilderState): void => {
    composerHost.replaceChildren(composer(engine, state, existingNames, { reload, seedState: renderInto }));
  };
  // Restore an in-progress composed role (browser-back / referrer-Back no longer
  // discards an unsaved role); else start fresh.
  const draft = loadDraft<CustomRoleProposal>(ROLE_DRAFT);
  renderInto(draft && draftHasContent(draft) ? stateFromDraft(draft) : emptyBuilderState());

  wrap.appendChild(composerHost);

  // The existing catalogue (read for everyone; delete is access.policy-gated, the engine enforces).
  wrap.appendChild(catalogueCard(engine, existing, reload));
  return wrap;
}

// ComposerCallbacks groups the composer's two collaborators that are not part of the model: reload
// re-reads the catalogue after a save, seedState re-renders the whole composer in place from a chosen
// preset.
interface ComposerCallbacks {
  reload: () => void;
  seedState: (s: BuilderState) => void;
}

// composer renders the presets row + the two-column form/preview for ONE BuilderState. The single
// state object drives everything; rerender() repaints only the live preview on each field change.
function composer(
  engine: EngineClient,
  state: BuilderState,
  existingNames: Set<string>,
  cb: ComposerCallbacks,
): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-5)" });

  // The creator's own effective capability set: the no-privilege-escalation guard intersects the
  // proposed capabilities with this, so a creator can grant only what they hold. Resolved from the
  // caller's role (the engine recomputes the authoritative set server-side; this mirror gates the UI).
  const creatorCaps = creatorCapabilities();

  // The preview host, re-rendered on every change so it tracks surface + capabilities + the verdict.
  const previewHost = h("div");
  const rerender = (): void => {
    previewHost.replaceChildren(renderPreview(state, creatorCaps));
    // Persist the in-progress role on every change (rerender runs after each edit).
    const snapshot = composeProposal(state);
    if (draftHasContent(snapshot)) saveDraft<CustomRoleProposal>(ROLE_DRAFT, snapshot);
  };

  // --- Presets row: the six built-ins as clone-and-tweak starting points (re-seed the composer) ---
  wrap.appendChild(presetsRow(cb.seedState));

  // --- The two-column composer + preview ---
  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:var(--space-5);align-items:start" });
  grid.appendChild(formColumn(state, existingNames, rerender));
  grid.appendChild(previewColumn(engine, state, creatorCaps, existingNames, previewHost, cb.reload));
  wrap.appendChild(grid);

  // Initial preview paint.
  rerender();
  return wrap;
}

// formColumn assembles the left form column: the standing no-custody note, the name/label fields, the
// capability matrix, the per-screen see/edit grid, the presentation switch and the landing picker. The
// surface grid and landing picker both depend on the live surface/capabilities, so a capability or
// visibility change redraws both in place (redrawSurfaceDependent) without rebuilding the whole column
// (which would drop focus).
function formColumn(state: BuilderState, existingNames: Set<string>, rerender: () => void): HTMLElement {
  const creatorCaps = creatorCapabilities();
  const form = h("section", { class: "card", "aria-labelledby": "builder-form-h", style: "display:grid;gap:var(--space-5)" });
  form.appendChild(h("h2", { id: "builder-form-h", class: "card__title", style: "font-size:var(--text-lg)" }, "Compose the role"));
  // The standing no-custody fact, once: a role is metadata only (the guardrail details live at
  // their point of use in the matrix, grid and presets below).
  form.appendChild(
    h("p", { class: "field__hint", style: "margin:0" }, "A custom role carries a name, label, capability list, per-screen visibility, a presentation and a landing screen only. No secret, key or value is ever part of a role."),
  );

  // Name + label.
  form.appendChild(identityFields(state, existingNames, rerender));

  // The two host elements are tracked so they can be swapped without rebuilding the whole column.
  let surfaceGridEl: HTMLElement;
  let landingEl: HTMLElement;
  const redrawSurfaceDependent = (): void => {
    const freshSurface = surfaceGrid(state, redrawSurfaceDependent);
    surfaceGridEl.replaceWith(freshSurface);
    surfaceGridEl = freshSurface;
    const freshLanding = landingPicker(state, rerender);
    landingEl.replaceWith(freshLanding);
    landingEl = freshLanding;
    rerender();
  };

  // The capability matrix: unticking a write capability demotes any screen that relied on it (handled in
  // demoteEditsLosingWriteCap), so a capability change redraws the surface-dependent controls.
  form.appendChild(capabilityMatrix(state, creatorCaps, redrawSurfaceDependent));

  // The per-screen see/edit grid.
  surfaceGridEl = surfaceGrid(state, redrawSurfaceDependent);
  form.appendChild(surfaceGridEl);

  // Presentation switch + landing picker.
  form.appendChild(presentationSwitch(state, rerender));
  landingEl = landingPicker(state, rerender);
  form.appendChild(landingEl);
  return form;
}

// previewColumn assembles the right column: the live preview host (re-rendered on every change) and the
// Save action. The creatorCaps intersection is the no-privilege-escalation guard the Save flow mirrors.
function previewColumn(engine: EngineClient, state: BuilderState, creatorCaps: ReadonlySet<Capability>, existingNames: Set<string>, previewHost: HTMLElement, reload: () => void): HTMLElement {
  const previewCol = h("section", { class: "card", "aria-labelledby": "builder-preview-h", style: "display:grid;gap:var(--space-4)" });
  const previewHead = h("div", { class: "card__header", style: "margin-bottom:0" });
  previewHead.appendChild(h("h2", { id: "builder-preview-h", class: "card__title", style: "font-size:var(--text-lg)" }, "What this role will see"));
  previewHead.appendChild(badge("info", "live"));
  previewCol.appendChild(previewHead);
  previewCol.appendChild(previewHost);
  previewCol.appendChild(saveRow(engine, state, creatorCaps, existingNames, reload));
  return previewCol;
}

// ---- identity fields (name + label) ---------------------------------------

function identityFields(state: BuilderState, existingNames: Set<string>, rerender: () => void): HTMLElement {
  const sec = h("div", { style: "display:grid;gap:var(--space-3)" });
  // A name clash is a valid, permitted state (overwrite is a supported path that the Save flow
  // confirms as a danger action), so it is a warn-toned hint, never the field error treatment.
  const clashHint = h("p", { class: "field__hint", role: "status", style: "color:var(--warn-fg)", hidden: true }, "This name exists; saving overwrites it.");
  const nameField = field({
    id: "builder-name",
    label: "Role name",
    value: state.name,
    placeholder: "kv-restorer",
    hint: "Lowercase letters, digits and hyphen, 1 to 64 chars (not leading/trailing hyphen). Must not match a built-in role name.",
    // The Save gate already runs the engine's own validateCustomRole over the whole proposal, so the
    // builder could never SAVE a bad name. It could hold one indefinitely: the box took a 65th
    // character under a hint stating 1 to 64, and said nothing on the way out of the field. The
    // field now states its own bound where the operator is looking. The pattern is the same
    // CUSTOM_ROLE_NAME_PATTERN the engine enforces, so this cannot be looser than the engine.
    required: true,
    validate: matchingPattern({
      pattern: CUSTOM_ROLE_NAME_PATTERN,
      rule: "The role name must be 1 to 64 characters of lowercase letters, digits and hyphen, and cannot start or end with a hyphen.",
      remedy: "Rename it in that shape, for example kv-restorer.",
    }),
    doc: { href: "https://docs.downpipes.io/identity-access/custom-roles", anchor: "composing-and-saving-a-role" },
    autocomplete: "off",
    onInput: (v) => {
      // THE SHADOW COPY THAT SILENTLY RENAMED THE ROLE. This used to write
      // `state.name = v.trim().toLowerCase()`, and the Save gate composes its proposal from `state`, never
      // from this control. So an operator who typed "KV-Restorer" got the field's own red error (the pattern
      // above is lowercase-only, under a hint that says so) AND a successfully saved role called
      // "kv-restorer": an error on screen and a different name in the catalogue, with nothing anywhere
      // saying the two were related. That is the custodian-name shape, and it is worse here because the
      // altered value is the role's IDENTITY: the normalised name is the storage key
      // (engine/src/sched/scheduler-do-rbac-mutations.ts:515), so a create in different casing silently
      // OVERWRITES the existing role of that name.
      //
      // The typed value now goes to `state` as typed (trimmed only), so previewRole's mirror of the engine's
      // CUSTOM_ROLE_NAME_PATTERN refuses the save for the same reason the field is already showing. The
      // clash hint keeps comparing on the normalised form, because that is what a save would collide with.
      state.name = v.trim();
      clashHint.hidden = !existingNames.has(state.name.toLowerCase());
      rerender();
    },
  });
  const labelField = field({
    id: "builder-label",
    label: "Display label",
    value: state.label,
    placeholder: "KV restorer",
    hint: "A human-readable name shown in the role catalogue (1 to 128 characters).",
    required: true,
    validate: atMostChars({
      noun: "The display label",
      max: 128,
      remedy: "Shorten the name shown in the role catalogue, for example KV restorer.",
    }),
    doc: { href: "https://docs.downpipes.io/identity-access/custom-roles", anchor: "composing-and-saving-a-role" },
    autocomplete: "off",
    onInput: (v) => {
      state.label = v;
      rerender();
    },
  });
  sec.appendChild(nameField.el);
  sec.appendChild(clashHint);
  sec.appendChild(labelField.el);
  return sec;
}

// ---- the capability matrix ------------------------------------------------

function capabilityMatrix(state: BuilderState, creatorCaps: ReadonlySet<Capability>, afterChange: () => void): HTMLElement {
  const sec = h("section", { "aria-labelledby": "builder-caps-h", style: "display:grid;gap:var(--space-3)" });
  sec.appendChild(h("h3", { id: "builder-caps-h", style: "font-size:var(--text-md);margin:0" }, "Capabilities"));
  sec.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "Tick the capabilities this role grants. The key ceremony and risk-accept are owner-reserved and cannot be added. A capability your own role does not hold is shown disabled (you cannot grant more than you hold).",
    ),
  );
  sec.appendChild(groupDocLink("https://docs.downpipes.io/identity-access/roles-and-capabilities#the-role-by-capability-matrix", "About capabilities"));

  const list = h("div", { class: "stack", style: "display:grid;gap:var(--space-1)" });
  for (const cap of ALL_CAPABILITIES) {
    const ownerReserved = OWNER_RESERVED_CAPABILITIES.has(cap);
    const creatorHolds = creatorCaps.has(cap);
    const disabled = ownerReserved || !creatorHolds;

    const cb = h("input", { type: "checkbox", id: `cap-${cap}`, style: "margin-top:3px;flex:none" }) as HTMLInputElement;
    cb.checked = state.capabilities.has(cap);
    cb.addEventListener("change", () => {
      if (cb.checked) state.capabilities.add(cap);
      else {
        state.capabilities.delete(cap);
        // Removing a write capability invalidates any screen set to "edit" that relied on it: demote
        // those screens to "read" so the composed state stays self-consistent (the engine would reject
        // them otherwise). This mirrors the edit-requires-write-cap guard at the point of removal.
        demoteEditsLosingWriteCap(state);
      }
      afterChange();
    });

    const reasonNote = ownerReserved
      ? "Owner-reserved; cannot be delegated."
      : !creatorHolds
        ? "You do not hold this capability."
        : "";
    // Each capability is taught at first contact: human label + the mono id + a one-line
    // description (the same pattern the screens grid below uses), never a bare internal id.
    const meta = CAPABILITY_LABELS[cap];
    // Disabled-with-reason, not the native `disabled` attribute: an owner-reserved or
    // not-held capability still tabs onto the checkbox and hears why it is refused, via the shared
    // disabledWithReason primitive, rather than the box silently vanishing from the tab order.
    // reasonEl carries the SAME text this row already
    // showed visibly next to the label; disabledWithReason both keeps it visible and ties it in via
    // aria-describedby, so it reaches assistive tech reading the checkbox, not only a sighted user
    // scanning the row.
    const reasonEl = h("span", { class: "field__hint", id: `cap-${cap}-disabled-reason`, hidden: true });
    reasonEl.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
    disabledWithReason(cb, reasonEl)(disabled ? reasonNote : null);
    // A disabled capability row carries check-row--disabled (muted + not-allowed cursor) so
    // an owner-reserved or not-held row never looks tickable; the inline cursor:pointer is
    // dropped for those rows (an inline style would defeat the class's cursor).
    const row = h(
      "label",
      {
        class: `check-row${disabled ? " check-row--disabled" : ""}`,
        for: `cap-${cap}`,
        style: `display:flex;gap:var(--space-2);align-items:flex-start;padding:var(--space-1) 0${disabled ? "" : ";cursor:pointer"}`,
      },
      cb,
      h(
        "span",
        { style: "display:grid;gap:1px" },
        h(
          "span",
          { style: "display:flex;gap:var(--space-2);align-items:baseline;flex-wrap:wrap" },
          h("span", meta.label),
          h("span", { class: "mono field__hint" }, cap),
        ),
        h("small", { style: "color:var(--text-muted)" }, meta.desc),
        reasonEl,
      ),
    );
    list.appendChild(row);
  }
  sec.appendChild(list);
  return sec;
}

// ---- the per-screen see/edit grid -----------------------------------------

// surfaceGrid renders the per-screen see/edit grid. redrawSurface re-renders the grid + landing in
// place when a mode changes (so the selected-segment highlight and the landing options track the model);
// it is called on a mode change.
function surfaceGrid(state: BuilderState, redrawSurface: () => void): HTMLElement {
  const sec = h("section", { "aria-labelledby": "builder-surface-h", style: "display:grid;gap:var(--space-3)" });
  sec.appendChild(h("h3", { id: "builder-surface-h", style: "font-size:var(--text-md);margin:0" }, "What each screen shows"));
  sec.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "For each screen choose hidden, read-only, or editable. Editable is offered only where the role holds that screen's write capability; a read-only screen has no write side. This is a console hint; the engine still gates every write on the capability set.",
    ),
  );
  sec.appendChild(groupDocLink("https://docs.downpipes.io/identity-access/custom-roles#the-capability-set-is-the-authority-the-grid-is-a-hint", "About screen visibility"));

  const grid = h("div", { class: "stack", style: "display:grid;gap:var(--space-2)" });
  for (const screen of SURFACE_SCREENS) {
    grid.appendChild(surfaceRow(screen, state, redrawSurface));
  }
  sec.appendChild(grid);
  return sec;
}

function surfaceRow(screen: { id: string; label: string; desc: string }, state: BuilderState, redrawSurface: () => void): HTMLElement {
  const editable = canSetScreenEdit(screen.id, state.capabilities);
  const current = state.surface.get(screen.id) ?? "read";

  const row = h("div", { class: "card card--inset", style: "display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:var(--space-3);padding:var(--space-3)" });
  const meta = h("div", { style: "min-width:0;flex:1 1 220px" });
  meta.appendChild(h("b", { style: "display:block" }, screen.label));
  meta.appendChild(h("small", { style: "color:var(--text-muted)" }, screen.desc));
  const writeCap = SCREEN_WRITE_CAPABILITY[screen.id];
  // The Edit segment's disabled-with-reason slot: built once per row and wired to the Edit
  // radio below via disabledWithReason (segControl), which shows/hides it and ties it in via
  // aria-describedby, so the reason is announced and reachable, not just a `title` tooltip a
  // keyboard/screen-reader user never sees. Name the
  // permission in customer language (capabilityPhrase), never the raw dotted id, when this fires for a
  // missing capability. Contrast the capability MATRIX above (Capabilities section), which deliberately
  // shows the mono id alongside the human label as a teaching aid; this hint is not that surface, so it
  // gets translated the same as every other gated control.
  const editReason = h("small", { class: "field__hint", id: `surface-${screen.id}-edit-reason`, style: "display:block;margin-top:var(--space-1)", hidden: true });
  editReason.hidden = true; // property, not just the attribute -- see field.ts's own SHIM NOTE.
  meta.appendChild(editReason);
  row.appendChild(meta);
  row.appendChild(
    segControl(screen, state, redrawSurface, editable, current, editReason, writeCap == null ? "This screen has no edit mode." : `Add ${capabilityPhrase(writeCap)} to make this screen editable.`),
  );
  return row;
}

// segStyle is the per-segment style string: the base segment chrome, plus the selected-segment highlight
// and the disabled treatment as conditional fragments, so the inline class logic is read in one place.
function segStyle(selected: boolean, optionDisabled: boolean): string {
  const base = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-sm)";
  const cursor = `;cursor:${optionDisabled ? "not-allowed" : "pointer"}`;
  const active = selected ? ";background:var(--surface-raised);font-weight:var(--weight-medium)" : "";
  const dim = optionDisabled ? ";opacity:0.5" : "";
  return `${base}${cursor}${active}${dim}`;
}

// segControl builds the three-way segmented control (hidden / read / edit) as radio inputs, so it is
// keyboard accessible and the "edit" option is genuinely disabled (not just visually) when the role
// lacks the screen's write capability.
function segControl(
  screen: { id: string; label: string; desc: string },
  state: BuilderState,
  redrawSurface: () => void,
  editable: boolean,
  current: SurfaceMode,
  editReason: HTMLElement,
  editReasonText: string,
): HTMLElement {
  const group = h("div", { role: "radiogroup", "aria-label": `${screen.label} visibility`, style: "display:flex;gap:var(--space-1);flex:0 0 auto" });
  const writeCap = SCREEN_WRITE_CAPABILITY[screen.id];
  const modes: Array<{ mode: SurfaceMode; label: string }> = [
    { mode: "hidden", label: "Hidden" },
    { mode: "read", label: "Read" },
    { mode: "edit", label: "Edit" },
  ];
  for (const m of modes) {
    const id = `surface-${screen.id}-${m.mode}`;
    const optionDisabled = m.mode === "edit" && !editable;
    const radio = h("input", { type: "radio", name: `surface-${screen.id}`, id, class: "visually-hidden" }) as HTMLInputElement;
    radio.checked = current === m.mode;
    // Disabled-with-reason, not the native `disabled` attribute: the Edit option stays
    // reachable and announces WHY it is refused (via the shared disabledWithReason primitive, tied
    // into editReason above), rather than dropping out of the tab order silently. Only the Edit
    // option can be disabled here, so this
    // only fires on that iteration; every other mode is always selectable.
    if (m.mode === "edit") disabledWithReason(radio, editReason)(optionDisabled ? editReasonText : null);
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.surface.set(screen.id, m.mode);
        // If this screen is now the landing but is hidden, move the landing to a still-visible screen
        // (you cannot land on a hidden screen; the engine rejects it too).
        if (m.mode === "hidden" && state.landing === screen.id) {
          const visible = nonHiddenScreens(state);
          state.landing = visible[0] ?? "audit";
        }
        // Re-render the surface grid + landing so the selected-segment highlight and the landing options
        // track the new state; redrawSurface repaints the preview too.
        redrawSurface();
      }
    });
    const seg = h("label", { class: "seg", for: id, style: segStyle(current === m.mode, optionDisabled) }, radio, m.label);
    // Name the permission in customer language, never the raw dotted id, in this tooltip (the sixth
    // such site found: a `title` attribute, a shape no prior validator checked). A screen with no
    // write side (writeCap null, e.g. audit/reports/posture) can still land here
    // with Edit disabled, so that case gets its own honest reason rather than interpolating null.
    if (optionDisabled) seg.setAttribute("title", writeCap == null ? "This screen has no edit mode." : `Requires ${capabilityPhrase(writeCap)}.`);
    group.appendChild(seg);
  }
  return group;
}

// ---- presentation switch (technical / shiny) ------------------------------

function presentationSwitch(state: BuilderState, rerender: () => void): HTMLElement {
  const sec = h("section", { "aria-labelledby": "builder-pres-h", style: "display:grid;gap:var(--space-2)" });
  sec.appendChild(h("h3", { id: "builder-pres-h", style: "font-size:var(--text-md);margin:0" }, "Presentation"));
  sec.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "A cosmetic skin only, with no authority. Technical is the full operator console; shiny is the simplified, reassurance-first surface. The engine never gates on presentation.",
    ),
  );
  sec.appendChild(groupDocLink("https://docs.downpipes.io/identity-access/custom-roles#what-you-compose", "About presentation"));
  const group = h("div", { role: "radiogroup", "aria-label": "Presentation", style: "display:flex;gap:var(--space-2)" });
  const options: Array<{ value: Presentation; label: string; desc: string }> = [
    { value: "technical", label: "Technical", desc: "Full operator console" },
    { value: "shiny", label: "Shiny", desc: "Simplified, reassurance-first" },
  ];
  for (const o of options) {
    const id = `pres-${o.value}`;
    const radio = h("input", { type: "radio", name: "presentation", id, class: "visually-hidden" }) as HTMLInputElement;
    radio.checked = state.presentation === o.value;
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.presentation = o.value;
        rerender();
      }
    });
    const card = h(
      "label",
      {
        class: "seg",
        for: id,
        style: `display:grid;gap:2px;padding:var(--space-2) var(--space-3);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer${state.presentation === o.value ? ";background:var(--surface-raised);border-color:var(--trust)" : ""}`,
      },
      radio,
      h("b", o.label),
      h("small", { style: "color:var(--text-muted)" }, o.desc),
    );
    group.appendChild(card);
  }
  sec.appendChild(group);
  return sec;
}

// ---- landing picker -------------------------------------------------------

function landingPicker(state: BuilderState, rerender: () => void): HTMLElement {
  const sec = h("section", { "aria-labelledby": "builder-landing-h", style: "display:grid;gap:var(--space-2)" });
  sec.appendChild(h("h3", { id: "builder-landing-h", style: "font-size:var(--text-md);margin:0" }, "Landing screen"));
  sec.appendChild(
    h("p", { class: "field__hint" }, "The screen a holder of this role opens on. It cannot be a screen you have hidden."),
  );
  // Only non-hidden screens are offered (you cannot land on a hidden screen).
  const visible = nonHiddenScreens(state);
  const options = visible.map((id) => ({ value: id, label: screenLabel(id) }));
  // If the current landing is no longer visible, snap it to the first visible screen.
  if (!visible.includes(state.landing)) state.landing = visible[0] ?? "audit";
  const landingField = field({
    id: "builder-landing",
    label: "Land on",
    kind: "select",
    value: state.landing,
    options,
    doc: { href: "https://docs.downpipes.io/identity-access/custom-roles", anchor: "what-you-compose" },
    onInput: (v) => {
      state.landing = v;
      rerender();
    },
  });
  // onInput (wired to the "input" event in field.ts) fires reliably on every select change,
  // so a separate "change" listener would only repeat the same state update.
  sec.appendChild(landingField.el);
  return sec;
}

// ---- presets row ----------------------------------------------------------

function presetsRow(seedState: (s: BuilderState) => void): HTMLElement {
  const sec = h("section", { class: "card", "aria-labelledby": "builder-presets-h", style: "display:grid;gap:var(--space-3)" });
  const head = h("div", { class: "card__header", style: "margin-bottom:0" });
  head.appendChild(h("h2", { id: "builder-presets-h", class: "card__title", style: "font-size:var(--text-lg)" }, "Start from a built-in preset"));
  head.appendChild(badge("default", "editable"));
  sec.appendChild(head);
  sec.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The six built-in roles, shown as editable starting points. Pick one to clone its capabilities and screen visibility, then tweak. Owner-reserved capabilities are dropped automatically (a custom role can never hold them).",
    ),
  );
  const row = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap" });
  for (const role of BUILTIN_ROLES) {
    const preset = builtinPreset(role);
    const btn = h(
      "button",
      { "data-dp": "roles-builder.button.toast", class: "btn btn--secondary btn--sm", type: "button" },
      svgIcon(ICON_SHIELD_CHECK, { size: 14 }),
      titleCaseRole(role),
    ) as HTMLButtonElement;
    btn.setAttribute("aria-label", `Start from the ${titleCaseRole(role)} preset (${preset.capabilities.length} capabilities)`);
    btn.addEventListener("click", () => {
      // Re-seed the WHOLE composer in place with the cloned preset, so name/label/caps/surface all
      // reflect the new starting point (no route change, so the seed is not discarded).
      seedState(stateFromPreset(role));
      toast({ message: `Loaded the ${titleCaseRole(role)} preset. Name your role and tweak it below.`, tone: "info" });
    });
    row.appendChild(btn);
  }
  sec.appendChild(row);
  return sec;
}
