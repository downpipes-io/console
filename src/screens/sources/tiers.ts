// The on-engine source tiers of the Sources screen: the "Needs attention" drift tier
// (configured sources whose binding the engine no longer exposes, shown in an error
// state with re-attach), and the "Attached, not yet protected" tier (the bulk protect:
// tick, share a schedule, create) with its owner-level detach. Moved here verbatim from
// the screen module for size; it imports the shared leaf, the add-source wizard (drift
// re-attach), the deploy-token help, and the bulk-summary/friendly-name helpers the
// Downpipes coordinator already exports. Australian English, no em dashes, precise
// claims.

import { type EngineClient, isOwnerActionQueuedResult, type SourceDiscovery } from "../../api.ts";
import { type DataColumn, dataTable } from "../../components/data-table.ts";
import { closeAllOverlays } from "../../components/dialog.ts";
import { field } from "../../components/field.ts";
import { confirmModal, openModal } from "../../components/modal.ts";
import { statusWithLabel } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { verdictSurface } from "../../components/verdict.ts";
import { type BulkCreateOutcome, runBulkCreate } from "../../lib/bulk-create.ts";
import { recordFanoutDegraded } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { clearDraft, loadDraft, saveDraft } from "../../lib/draft.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL, ICON_INFO } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { surfacePendingChange, surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { canCap, capGateReason, refuseWithReason } from "../common.ts";
import { assembleBulkDownpipes } from "../sources-downpipes/bulk-assemble.ts";
import { destinationFanout } from "../sources-downpipes/destination-fanout.ts";
import { openBulkSummary } from "../sources-downpipes.ts";
import { openAddSourceWizard } from "./add-source.ts";
import { errMsg, type MissingSource, type ProtectType, pickIcon, pickTypeLabel, selectableSourceList, sourceTypeBadge } from "./shared.ts";
import { attachTokenHelp } from "./token-help.ts";

// TierContext bundles the refresh callback and the two gate flags the tier renderers share,
// so each renderer stays within the four-parameter guardrail. refresh re-fetches the screen
// after a mutation; opGate is operator-level (protect/re-attach); ownerGate is owner-level
// (detach, which changes the engine's bindings).
export interface TierContext {
  refresh: () => void;
  opGate: boolean;
  ownerGate: boolean;
}

// driftTier is the "Needs attention" section: each configured source whose backing binding
// is no longer present on the engine, shown in an explicit error state (a row table matching
// the /downpipes layout; the danger State cell carries the urgency, the section stays calm
// and consistent with the others per the calm-density budget). Each row names the missing
// binding, its type and the downpipe(s) whose next run it breaks, and offers re-attach so
// recovery is one step from where the problem is seen. This is the surface for the
// silent-drop that used to hide a broken source.
export function driftTier(engine: EngineClient, missing: readonly MissingSource[], found: SourceDiscovery, ctx: TierContext): HTMLElement {
  const sec = h("section");
  sec.appendChild(h("h3", { class: "section-title" }, `Needs attention (${missing.length})`));
  sec.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:0" },
      missing.length === 1
        ? "A source is configured but its binding is not present on the engine, so its next backup fails. This happens when a deploy did not carry the binding, or the resource was deleted. Re-attach it to restore protection."
        : "These sources are configured but their bindings are not present on the engine, so their next backups fail. This happens when a deploy did not carry the binding, or the resource was deleted. Re-attach each to restore protection.",
    ),
  );
  sec.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/binding-drift", target: "_blank", rel: "noreferrer noopener" },
      "About binding drift, and how to prevent it",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
  sec.appendChild(reattachAllPanel(engine, missing, found, ctx));
  sec.appendChild(driftTable(engine, missing, found, ctx));
  return sec;
}

// reattachAllPanel is the ONE-ACTION recovery for the whole drift set, the fast "undo a bad wrangler
// deploy" path. Instead of re-attaching each missing source through the wizard, paste a one-shot deploy
// token once and the engine re-adds EVERY missing binding the roster can rebuild in a single call (POST
// /sources/reattach-missing), each with its ORIGINAL name + recorded native id, so every affected downpipe
// reads its source again and its next run continues the SAME backup history (no new downpipe, no orphaned
// lineage). The engine runs the same prove-before-write / verify-after harness as the per-source attach;
// the token is used once and never stored. Owner-gated: the engine gates this route on keys.ceremony
// (owner-reserved), so the console mirrors exactly that; the per-row re-attach below stays the Operator
// path. Any source the roster cannot rebuild (a legacy config saved before its native id was recorded) is
// reported so the operator re-saves it from the wizard, and a binding two downpipes disagree about is
// reported as conflicting, never written.
function reattachAllPanel(engine: EngineClient, missing: readonly MissingSource[], found: SourceDiscovery, ctx: TierContext): HTMLElement {
  const { refresh } = ctx;
  const wrap = h("div", { class: "field", style: "margin:0 0 0.75rem" });
  if (!canCap("keys.ceremony")) {
    wrap.appendChild(h("p", { class: "field__hint", style: "margin:0" }, `An Owner can re-attach all ${missing.length} in one step. ${capGateReason("keys.ceremony")}`));
    return wrap;
  }
  const tokenInput = h("input", { "data-dp": "sources.password.token#3", class: "input", type: "password", autocomplete: "off", "aria-label": "One-shot deploy token", placeholder: "paste a deploy token (used once, never stored)", style: "max-width:22rem" }) as HTMLInputElement;
  const btn = h("button", { "data-busy-label": "Re-attaching", "data-dp": "sources.button.reattach-all-panel", class: "btn btn--primary btn--sm", type: "button" }, `Re-attach all ${missing.length}`) as HTMLButtonElement;
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  let busy = false;
  btn.addEventListener("click", () => {
    if (busy) return;
    const value = tokenInput.value.trim();
    if (value === "") {
      err.textContent = "Paste the deploy token first.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    busy = true;
    btn.disabled = true;
    btn.textContent = "Re-attaching";
    void engine
      .reattachMissing(value)
      .then((res) => {
        tokenInput.value = "";
        const parts: string[] = [];
        if (res.attached.length > 0) parts.push(`${res.attached.length} source${res.attached.length === 1 ? "" : "s"} re-attached, verified safe`);
        if (res.unreconstructable.length > 0) parts.push(`${res.unreconstructable.length} could not be rebuilt (re-save them from the Sources screen so their id is recorded)`);
        if (res.conflicting.length > 0) parts.push(`${res.conflicting.length} in conflict (two downpipes disagree about the binding; open each and re-save the source it should read)`);
        if (parts.length === 0) parts.push("nothing to re-attach; all configured sources are already attached");
        toast({ message: `${parts.join("; ")}. Revoke the token now.` });
        refresh();
      })
      .catch((e: unknown) => {
        busy = false;
        btn.disabled = false;
        btn.textContent = `Re-attach all ${missing.length}`;
        if (isUnauthorised(e)) {
          goSignedOut();
          return;
        }
        err.textContent = `Could not re-attach. ${errMsg(e)}`;
        err.hidden = false;
      });
  });
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin:0 0 0.4rem" },
      "Re-attach every missing source in one step, with their original names, so each downpipe keeps its existing backup history. Paste a one-shot deploy token (the \"Edit Cloudflare Workers\" template; if any missing source is D1 or Secrets Store, add that permission by hand too); it is used once and never stored. ",
      h("button", { "data-dp": "sources.button.attach-token-help#3", class: "linklike", type: "button", on: { click: () => attachTokenHelp(found.engineAccountId ?? null) } }, "How do I create the deploy token?"),
      " Or re-attach individually below.",
    ),
  );
  wrap.appendChild(h("div", { style: "display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap" }, tokenInput, btn));
  wrap.appendChild(err);
  return wrap;
}

// driftTable lays the missing sources as a row table (Binding · Type · State · a re-attach
// action). The binding column carries the downpipe(s) it breaks as a subline; the State cell
// reads danger (never attached reads green); the action is the guided wizard when a discovery
// token is set and the type is bindable there, or the by-id screen otherwise (which also
// covers Secrets Store bindings and any manually-named binding). Re-attach is operator-gated,
// disabled-with-reason. Every server string (binding, downpipe names) is added via textContent.
function driftTable(engine: EngineClient, missing: readonly MissingSource[], found: SourceDiscovery, ctx: TierContext): HTMLElement {
  const { refresh, ownerGate, opGate } = ctx;
  const columns: Array<DataColumn<MissingSource>> = [
    {
      key: "binding",
      header: "Binding",
      sortable: true,
      sortValue: (m) => m.binding,
      render: (m) => {
        const breaks = m.downpipes.length > 0 ? `Breaks: ${m.downpipes.join(", ")}` : "Not yet covered by a downpipe";
        return h(
          "span",
          { class: "dp-name" },
          h("span", { class: "mono", style: "overflow-wrap:anywhere" }, m.binding),
          h("span", { class: "dp-name__sub" }, breaks),
        );
      },
    },
    {
      key: "type",
      header: "Type",
      sortable: true,
      sortValue: (m) => m.type,
      render: (m) => sourceTypeBadge(m.type),
    },
    {
      key: "state",
      header: "State",
      sortable: true,
      sortValue: (m) => m.type,
      render: () => statusWithLabel("danger", "Not attached"),
    },
    {
      key: "action",
      header: "Re-attach",
      srOnlyHeader: true,
      width: "1px",
      render: (m) => {
        const reattach = h("button", { "data-dp": "sources.button.reattach", class: "btn btn--secondary btn--sm", type: "button" }, "Re-attach") as HTMLButtonElement;
        if (opGate) {
          reattach.addEventListener("click", () => {
            if (m.type !== "secrets" && found.tokenPresent) openAddSourceWizard(engine, found, refresh, ownerGate);
            else navigate("/sources/advanced");
          });
        } else {
          // No handler on this branch, so the control can stay focusable and carry its reason
          // as text rather than as hover-only chrome.
          refuseWithReason(reattach, capGateReason("downpipe.write"));
        }
        return reattach;
      },
    },
  ];
  return dataTable<MissingSource>({
    label: "Sources needing attention",
    rows: [...missing],
    rowKey: (m) => `${m.type}:${m.binding}`,
    columns,
    filter: { placeholder: "Filter by binding   ( / )", resultLabel: "sources", getText: (m) => `${m.binding} ${m.type} ${pickTypeLabel(m.type)} ${m.downpipes.join(" ")}` },
    initialSort: { key: "binding", dir: "asc" },
  }).el;
}

// SELECTION_DRAFT keys the in-progress "protect these" selection, kept so it survives a
// navigation hop (the owner's exact complaint: ticking sources, leaving for the manual-attach
// page, and losing the lot). The draft holds only binding names + types, never a secret.
const SELECTION_DRAFT = "sources-protect-selection";

// restoreSelection rehydrates the protect-selection draft, pruned to what is still attachable,
// so a since-protected or vanished binding does not linger. Returns the live selection map.
function restoreSelection(attachable: Array<{ name: string; type: ProtectType }>): Map<string, ProtectType> {
  const attachableNames = new Set(attachable.map((b) => b.name));
  const selected = new Map<string, ProtectType>();
  const draftEntries = loadDraft<Array<[string, ProtectType]>>(SELECTION_DRAFT);
  if (Array.isArray(draftEntries)) {
    for (const entry of draftEntries) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && attachableNames.has(entry[0])) {
        selected.set(entry[0], entry[1]);
      }
    }
  }
  return selected;
}

// bulkCreateDownpipes creates the selected bindings' downpipes: the shared assembly (one downpipe per
// kv/r2/d1 binding; the ticked secrets bundle into ONE Secrets downpipe) through the shared
// many-at-once loop (one POST /admin/downpipes/bulk per slice, per-item outcomes, the single-create
// fallback against an older engine, a 401 halts honestly). destinationIds is the ordered fan-out the
// whole batch writes to (first = primary); empty follows the default destination, as before. PURE of
// the DOM (the caller drives button state + toasts off the outcome). Exported for the sources
// validator (console-src-056-17); the outcome shape is lib/bulk-create's, unchanged from the old
// per-item loop so reportBulkOutcome reads it identically.
export type { BulkCreateOutcome } from "../../lib/bulk-create.ts";
export async function bulkCreateDownpipes(
  engine: EngineClient,
  entries: Array<[string, ProtectType]>,
  cadence: number,
  destinationIds: string[] = [],
  onProgress?: (settled: number, total: number) => void,
): Promise<BulkCreateOutcome> {
  const prepared = assembleBulkDownpipes(entries, cadence, destinationIds);
  return runBulkCreate(
    { bulk: (dps) => engine.bulkAddDownpipes(dps), single: (dp) => engine.addDownpipe(dp) },
    prepared.map((p) => ({ dp: p.dp, label: p.label })),
    onProgress,
  );
}

// reportBulkOutcome turns a BulkCreateOutcome into the operator-facing toasts + bulk-summary,
// and signals whether the caller should clear the draft. Halt (session expiry) clears nothing
// and ends in goSignedOut; a fully-successful run clears the draft; a partial failure keeps it
// so the failed bindings can be retried. PURE of the create loop. Exported for the validator.
export function reportBulkOutcome(outcome: BulkCreateOutcome, total: number): { clearDraft: boolean; signedOut: boolean } {
  const { done, queued, failures, halted } = outcome;
  if (halted) {
    toast({ message: `Stopped after ${done + queued} of ${total} (your session expired).`, tone: "warn" });
    goSignedOut();
    return { clearDraft: false, signedOut: true };
  }
  if (queued > 0 && failures.length === 0) {
    surfacePendingChange(queued === 1 ? "downpipe" : "set of downpipes");
  } else if (failures.length === 0) {
    toast({ message: `${done} downpipe${done === 1 ? "" : "s"} created. They appear in Downpipes.` });
  } else {
    // The toast is the headline only; the per-binding REASONS go to the focusable
    // bulk summary modal (the same surface the import flow uses).
    const queuedNote = queued > 0 ? `, ${queued} queued for approval` : "";
    toast({ message: `${done} created${queuedNote}, ${failures.length} failed.`, tone: "warn" });
    openBulkSummary("protect", "created", done, failures);
  }
  return { clearDraft: failures.length === 0, signedOut: false };
}

// attachedTier renders tier 2: bound bindings without a downpipe, with the bulk
// protect (tick, share a schedule, pick the destinations, create). This is the moved picker
// behaviour, the fastest protect path, kept on the screen that owns selection. Secrets Store
// bindings list here too: ticked secrets bundle into ONE Secrets downpipe (the product model),
// while each ticked store binding becomes its own downpipe.
export function attachedTier(engine: EngineClient, attachable: Array<{ name: string; type: ProtectType }>, found: SourceDiscovery, ctx: TierContext): HTMLElement {
  const { refresh, opGate, ownerGate } = ctx;

  // Nothing waiting: one quiet note row (glyph + muted line, the .note-quiet pattern),
  // no section heading (a standing zero heading spends an eager-section slot saying
  // nothing is there). The caller anchors it inside the Protected panel when one exists.
  if (attachable.length === 0) {
    return h(
      "div",
      { class: "note-quiet", style: "margin-top:var(--space-2)" },
      svgIcon(ICON_INFO, { size: 14 }),
      h(
        "p",
        found.tokenPresent
          ? "Nothing is waiting to be protected. Attach more from the account catalogue below."
          : "Nothing is waiting to be protected. Connect your account below to browse everything you own.",
      ),
    );
  }

  const section = h("section");
  section.appendChild(h("h3", { class: "section-title" }, `Attached, not yet protected (${attachable.length})`));

  const selected = restoreSelection(attachable);
  const persistSelection = (): void => saveDraft(SELECTION_DRAFT, [...selected.entries()]);
  const createBtn = h("button", { "data-busy-label": "Creating", "data-dp": "sources.button.create", class: "btn btn--primary btn--sm", type: "button", disabled: true }, "Protect selected") as HTMLButtonElement;
  const updateCreate = (): void => {
    if (!opGate) return; // gated below: aria-disabled carries the reason, label untouched
    const n = selected.size;
    createBtn.disabled = n === 0;
    createBtn.textContent = n === 0 ? "Protect selected" : `Protect ${n} source${n === 1 ? "" : "s"}`;
  };
  if (!opGate) {
    // Disabled-with-reason, FOCUSABLE (the shared primitive): aria-disabled keeps the button in
    // the tab order and the reason is announced as the button's DESCRIPTION, never as a hover-only
    // title (no keyboard or touch path) and never glued into its accessible name.
    createBtn.disabled = false;
    refuseWithReason(createBtn, capGateReason("downpipe.write"));
  }

  const byType: Record<ProtectType, string[]> = { kv: [], r2: [], d1: [], secrets: [] };
  for (const b of attachable) byType[b.type].push(b.name);

  const groupBlock = (type: ProtectType, label: string, names: string[]): HTMLElement | null => {
    if (names.length === 0) return null;
    return selectableSourceList({
      groupId: `attach-${type}`,
      label,
      icon: pickIcon(type),
      open: true,
      items: names.map((name) => ({ value: name, label: name, checked: selected.has(name) })),
      onToggle: (value, checked) => {
        if (checked) selected.set(value, type);
        else selected.delete(value);
        persistSelection();
        updateCreate();
      },
    });
  };

  const blocks = [
    groupBlock("kv", "KV namespaces", byType.kv),
    groupBlock("r2", "R2 buckets", byType.r2),
    groupBlock("d1", "D1 databases", byType.d1),
    groupBlock("secrets", "Secrets Store secrets", byType.secrets),
  ].filter((b): b is HTMLElement => b !== null);
  section.appendChild(h("div", { class: "catalogue-grid" }, ...blocks));
  if (byType.secrets.length > 0) {
    section.appendChild(h("p", { class: "field__hint", style: "margin:var(--space-1) 0 0" },
      "Ticked secrets bundle into one Secrets downpipe (each secret stays its own named row); every other ticked source becomes its own downpipe."));
  }

  const cadenceField = field({
    id: "src-cadence",
    label: "Schedule (shared)",
    kind: "select",
    value: "86400",
    hint: "Applied to every downpipe created in this batch. Hourly is the fastest the console offers; a due run lands at the next fifteen-minute engine tick.",
    options: [
      { value: "86400", label: "Daily (recommended)" },
      { value: "21600", label: "Every 6 hours" },
      { value: "3600", label: "Hourly" },
      { value: "604800", label: "Weekly" },
    ],
    doc: { href: "https://docs.downpipes.io/backing-up/overview", anchor: "the-fifteen-minute-floor" },
  });
  // The shared destination fan-out for the whole batch (first ticked = primary, the rest replicas;
  // none ticked = the default destination, exactly like a single create). The picker only appears
  // when MORE THAN ONE destination exists, read lazily so the tier renders without waiting on it.
  //
  // SILENT REDUNDANCY LOSS. This read used to fail open into an empty catch. Two ways that lost the
  // operator's replicas without a word: the read FAILS, so the picker never renders and the batch quietly
  // follows the single default destination; or the read is still IN FLIGHT when Protect is pressed, so the
  // same thing happens on a slow link. Either way the operator asked for N copies of every source and got
  // one, and would not find out until the day they needed the copy that was never made. So the read is now
  // AWAITED at the click (the race), and a failure is SAID OUT LOUD next to the button with a retry (the
  // silence). The read itself goes through the one engine seam, so its failure is already carried into the
  // support pack as a closed-class engine-call fault on the sources screen; what was missing was the
  // operator's own chance to notice, which is what this restores.
  let chosenDestinationIds: string[] = [];
  const destHost = h("div");
  const destWarning = h("div", { hidden: "" });
  // degradeAcknowledged records that the operator has SEEN what a create with an unreadable destination list
  // would cost them. The first Protect press against a failed read is refused and paints the warning; a
  // second press proceeds, so an estate with a single destination (which loses nothing) is never blocked and
  // an estate with replicas cannot lose them without the operator choosing to.
  let degradeAcknowledged = false;
  const paintDestWarning = (): void => {
    destWarning.replaceChildren(
      verdictSurface({
        tone: "warn",
        title: "Your destinations could not be read",
        body: degradeAcknowledged
          ? "Press Protect again to create this batch against your default destination only. No extra copies will be made."
          : "Creating now would send every downpipe in this batch to your default destination only, with no extra copies. Retry the read to choose where the copies go.",
        action: { label: "Retry", onClick: () => { destRead = readDestinations(); } },
      }),
    );
    destWarning.hidden = false;
  };
  // readDestinations resolves to whether the destinations were read. It NEVER rejects, so awaiting it at the
  // click cannot throw into the create path.
  const readDestinations = (): Promise<boolean> =>
    engine
      .listDestinations()
      .then((list) => {
        degradeAcknowledged = false;
        destWarning.hidden = true;
        destWarning.replaceChildren();
        destHost.replaceChildren();
        if ((list.destinations ?? []).length > 1) {
          destHost.appendChild(destinationFanout({ destinations: list.destinations, destLine: "", setChosenDestinationIds: (ids) => { chosenDestinationIds = ids; } }));
        }
        return true;
      })
      .catch(() => {
        // The fault record is already in the ring: the read goes through the one engine seam, which recorded
        // the failure as a closed-class engine-call fault on the sources screen. What is added here is the
        // operator's own chance to notice, in the exact terms of what they are about to lose.
        chosenDestinationIds = [];
        paintDestWarning();
        return false;
      });
  let destRead = readDestinations();
  if (opGate) createBtn.addEventListener("click", async () => {
    if (selected.size === 0) return;
    // Wait for the destination read before creating anything: a batch that starts while the read is still in
    // flight silently takes the default destination, which is the same redundancy loss on a slow link.
    const destinationsKnown = await destRead;
    if (!destinationsKnown && !degradeAcknowledged) {
      degradeAcknowledged = true;
      paintDestWarning();
      return;
    }
    const entries = [...selected.entries()];
    const cadence = Number(cadenceField.value());
    createBtn.dataset.busy = "true";
    createBtn.disabled = true;
    createBtn.textContent = "Creating";

    const outcome = await bulkCreateDownpipes(engine, entries, cadence, chosenDestinationIds, (settled, total) => {
      // Progress on the button so a thousand-source protect visibly advances batch by batch.
      if (total > 1) createBtn.textContent = `Creating ${settled} of ${total}`;
    });
    // The batch has just gone ahead against the DEFAULT destination only, because the
    // destination list could not be read, so the replicas this operator would have chosen were never created.
    // Recorded here, AFTER the create, so `count` is how many downpipes actually landed without their fan-out
    // (a create that itself failed lost no redundancy, and must not claim to have).
    //
    // Why its own kind rather than the read's engine-call row. The read failure IS already in the ring as a
    // closed-class engine-call fault on the sources screen, and that row is useless for this question twice
    // over: it cannot say the operator went on to create anyway (a read that failed and was then RETRIED
    // successfully leaves the same row), and it COALESCES, tuple for tuple, with a 500 from discoverSources or
    // listDownpipes on the same screen, so an estate that silently lost its replicas and an estate that had a
    // transient discovery blip were one row. This row exists only when the fan-out was actually skipped, and
    // an operator who deliberately chose the default never produces one.
    if (!destinationsKnown) recordFanoutDegraded(outcome.done);
    // The outcome's own total counts DOWNPIPES (the ticked secrets bundle into one), so the
    // summary agrees with what actually lands in /downpipes rather than the tick count.
    const { clearDraft: shouldClear, signedOut } = reportBulkOutcome(outcome, outcome.total);
    if (signedOut) {
      // PAINT FIRST, THEN LEAVE. reportBulkOutcome routes to signed-out when the batch HALTED on a lapsed
      // session, and the button is mid-narration ("Creating 7 of 20") with data-busy set. Whatever landed
      // before the halt is real and is named in its toast; the control must not stay counting.
      createBtn.dataset.busy = "false";
      updateCreate();
      return;
    }
    if (shouldClear) clearDraft(SELECTION_DRAFT);
    refresh();
  });

  // Detach: remove the SELECTED bindings from the engine entirely (they have no
  // downpipe here, so nothing breaks). Owner-level, since it changes the engine's
  // bindings; runs the same binding-safety checks (the engine proves it only removes these,
  // never its own). A confirm names the consequence, then a one-shot token is collected.
  const detachBtn = setupDetachButton(engine, found, selected, refresh, ownerGate);
  const updateDetach = (): void => {
    if (!detachBtn) return;
    const n = selected.size;
    detachBtn.hidden = n === 0;
    detachBtn.textContent = n === 1 ? "Detach 1 from the engine" : `Detach ${selected.size} from the engine`;
  };
  const actionsRow = h("div", { style: "display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap" }, createBtn);
  if (detachBtn) actionsRow.appendChild(detachBtn);

  updateCreate(); // reflect any restored selection in the button label on first paint
  updateDetach();
  // The bulk Protect and Detach labels both track the shared selection. The per-box
  // onToggle and the All/None buttons mutate it; a bubbling change+click listener on the
  // section re-syncs the detach label without threading a second callback through.
  section.addEventListener("change", () => updateDetach());
  section.addEventListener("click", () => updateDetach());
  section.appendChild(h("div", { class: "stack-sm", style: "margin-top:var(--space-3)" }, cadenceField.el, destHost, destWarning, actionsRow));
  return section;
}

// setupDetachButton builds the owner-only "Detach from the engine" button, wired to a danger
// confirm that names the consequence and then collects a one-shot token. Returns null when the
// caller is not owner-gated (no button is shown). The label tracks the shared selection via the
// caller's updateDetach; here we only wire the click -> confirm -> promptTokenAndDetach path.
function setupDetachButton(engine: EngineClient, found: SourceDiscovery, selected: Map<string, ProtectType>, refresh: () => void, ownerGate: boolean): HTMLButtonElement | null {
  if (!ownerGate) return null;
  const detachBtn = h("button", { "data-dp": "sources.button.detach#1", class: "btn btn--ghost btn--sm", type: "button", style: "color:var(--danger-fg)" }, "Detach from the engine") as HTMLButtonElement;
  detachBtn.hidden = true;
  detachBtn.addEventListener("click", () => {
    const names = [...selected.keys()];
    if (names.length === 0) return;
    void confirmModal({
      title: names.length === 1 ? `Detach ${names[0]} from the engine?` : `Detach ${names.length} sources from the engine?`,
      body: "The data stays untouched in Cloudflare; the engine just stops being able to read these. Only unprotected sources are listed here, so no downpipe depends on them. You will paste a one-shot deploy token; the engine verifies it removes only these and keeps all its own bindings.",
      confirmLabel: "Detach",
      variant: "danger",
    }).then((okd) => {
      if (okd) promptTokenAndDetach(engine, names, found.engineAccountId ?? null, refresh);
    });
  });
  return detachBtn;
}

// promptTokenAndDetach opens a one-shot-token modal and runs the engine's detach safety check
// for the named bindings. The token is sent once and never stored; the engine proves it
// removes only these and keeps all its own bindings (it refuses otherwise).
//
// Exported for the validator: what this sends is a detach, so a wrong list removes the wrong
// source, and it is worth driving directly rather than only through the tier's DOM.
export function promptTokenAndDetach(engine: EngineClient, names: string[], engineAccountId: string | null, refresh: () => void): void {
  const tokenInput = h("input", { "data-dp": "sources.password.token#4", class: "input", type: "password", autocomplete: "off", "aria-label": "One-shot deploy token", placeholder: "paste a deploy token (used once, never stored)" }) as HTMLInputElement;
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  const detach = h("button", { "data-busy-label": "Detaching", "data-dp": "sources.button.detach#2", class: "btn btn--primary btn--sm", type: "button", style: "color:var(--danger-fg)" }, `Detach ${names.length}`) as HTMLButtonElement;
  detach.addEventListener("click", () => {
    const value = tokenInput.value.trim();
    if (value === "") { err.textContent = "Paste the deploy token first."; err.hidden = false; return; }
    err.hidden = true;
    detach.disabled = true;
    detach.textContent = "Detaching";
    void engine
      .changeBindings(value, [], names)
      .then((res) => {
        tokenInput.value = "";
        if (isOwnerActionQueuedResult(res)) {
          surfaceQueuedOwnerAction("Detaching these sources");
          closeAllOverlays();
          refresh();
          return;
        }
        const { detached } = res.value;
        toast({ message: `${detached.length} source${detached.length === 1 ? "" : "s"} detached, verified safe. Revoke the token now.` });
        closeAllOverlays();
        refresh();
      })
      .catch((e) => {
        if (isUnauthorised(e)) {
          // PAINT FIRST, THEN LEAVE, but paint the CONTROL and not an error. Nothing was detached, so the
          // button comes back off "Detaching" rather than staying stuck mid-narration.
          //
          // It deliberately sets NO error text. A dead session is not a detach problem and must not be
          // reported as one in this modal, which the re-attach handler above already follows the same shape for: restore the control,
          // then leave without an inline message, rather than reporting a dead session as a detach problem.
          detach.disabled = false;
          detach.textContent = `Detach ${names.length}`;
          return goSignedOut();
        }
        err.textContent = errMsg(e);
        err.hidden = false;
        detach.disabled = false;
        detach.textContent = `Detach ${names.length}`;
      });
  });
  const body = h(
    "div",
    { class: "stack-sm" },
    h("p", { class: "field__hint", style: "margin:0" }, "Removing: ", h("span", { class: "mono" }, names.join(", ")), "."),
    h("div", { style: "display:flex;gap:var(--space-2);align-items:center" }, tokenInput, detach),
    h("p", { class: "field__hint", style: "margin:0" }, h("button", { "data-dp": "sources.button.attach-token-help#4", class: "linklike", type: "button", on: { click: () => attachTokenHelp(engineAccountId) } }, "How do I create the deploy token?")),
    err,
  );
  openModal({ title: "Detach with a one-shot token", body });
}
