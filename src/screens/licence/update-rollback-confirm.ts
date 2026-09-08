// The paired-rollback confirm (design/updates/UPDATE-UX-015-DESIGN.md s6): before a token is spent on an
// ENGINE rollback, read the rollback plan (client-update.ts rollbackPlan, a token-free dry-run read); when it
// reports paired:true (rolling the engine back would violate the live console's persisted minEngineVersion
// floor, so the engine bundles a console rollback with it rather than stranding an incompatible pair), the
// confirm dialog shows the EXACT s6 line and the operator must proceed knowingly. Console-only rollback is
// UNCHANGED (it is always the safe direction, design s6): this helper is for an ENGINE rollback ONLY, so it
// is used by the standalone rollback control (rollback.ts) and the advanced per-component "Roll back engine"
// button (update-components-advanced.ts), never by either surface's console rollback.
//
// BEST-EFFORT BY DESIGN: rollbackPlan is a dry-run read against an engine that may predate it; ANY failure
// (an older engine's ordinary token-required refusal, a transport fault) is treated as "no plan available",
// so the confirm falls back to the plain (unpaired) body rather than blocking or erroring. House rules:
// Australian English, no em dashes.

import { confirmModal } from "../../components/modal.ts";
import { h } from "../../lib/dom.ts";
import { PAIRED_ROLLBACK_LINE } from "./update-outcome-copy.ts";
import type { EngineClient, UpdateComponentId } from "../../api.ts";

// confirmEngineRollback reads the rollback plan (best-effort) then opens the SAME danger confirm the two
// engine-rollback surfaces already used, with the s6 paired line added ONLY when the plan says paired:true.
// Returns the operator's decision exactly like confirmModal (true = proceed). `components` mirrors the
// caller's own rollback call shape (omitted for the standalone legacy route, ["engine"] for the per-component
// route), so the plan read describes the SAME target the real rollback would.
export async function confirmEngineRollback(
  engine: EngineClient,
  opts: { title: string; body: string; components?: UpdateComponentId[] },
): Promise<boolean> {
  let paired = false;
  try {
    const plan = await engine.rollbackPlan(opts.components);
    paired = plan.paired === true;
  } catch {
    // No plan available (an older engine, or a transient fault): proceed with the plain confirm below, never
    // a blocker and never a surfaced error for a read that exists purely to add one extra line of caution.
    paired = false;
  }
  const bodyNode = paired
    ? h("div", h("p", { style: "color:var(--text)" }, opts.body), h("p", { style: "color:var(--text);margin-top:var(--space-2)" }, PAIRED_ROLLBACK_LINE))
    : opts.body;
  return confirmModal({ title: opts.title, body: bodyNode, confirmLabel: "Roll back", variant: "danger" });
}
