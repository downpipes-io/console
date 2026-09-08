// The cost calculator's standing copy: the always-visible assumptions-and-limits panel.
// Moved verbatim from view.ts for size; these are pure DOM/string builders with no instance
// state. One eager line carries the estimates framing (the ONLY standing telling besides the
// headline card's); the nine bullets sit in a collapsedSection (7a: assumptions one keystroke
// away). collapsedSection renders the body NOW, so find-in-page still works, only the visual
// weight is deferred, honouring the spec's always-available intent. House rules: Australian
// English, no em dashes, precise claims ("estimate" / "projected").

import { h } from "../../lib/dom.ts";
import { collapsedSection } from "../common.ts";
import { noteQuiet } from "../../components/feedback.ts";
import { humanBytes } from "../../lib/format.ts";
import {
  DEFAULT_DEDUP_RATIO,
  DEFAULT_OVERHEAD_BYTES,
  DEFAULT_SEG_BYTES,
} from "../../lib/cost-model.ts";
import { ratioToPct } from "./helpers.ts";

// buildAssumptionsPanel is the always-visible assumptions-and-limits panel: one eager
// estimates line plus the nine assumption bullets one keystroke away.
export function buildAssumptionsPanel(): HTMLElement {
  const wrap = h("div", { class: "cost-assumptions measure", style: "margin-top:var(--space-6)" });
  wrap.appendChild(
    noteQuiet("Estimates, not quotes: actual charges are set by your destination and your real workload. Every assumption is listed below and overridable above."),
  );

  const body = h("div");
  const list = h("ul", { class: "cost-assumptions__list" });
  for (const item of assumptionItems()) {
    list.appendChild(h("li", item));
  }
  body.appendChild(list);
  body.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Pricing presets are indicative public list prices, not contracted rates; verify against your destination's current published pricing and enter your own.",
    ),
  );
  const section = collapsedSection("Assumptions and limits", body);
  section.style.marginTop = "var(--space-3)";
  wrap.appendChild(section);
  return wrap;
}

export function assumptionItems(): string[] {
  return [
    // Item 1 is the canonical statement of the per-run snapshot model; the field
    // hints and result notes refer to it rather than re-teaching it.
    "Growth model: the default projection is per-run snapshot accumulation, the engine as it runs today. The content-address key derives from the per-run master, so dedup applies only within a run and every run stores a full snapshot: storage grows with runs per period times archive bytes per run, regardless of churn.",
    "Cross-run dedup: the churn-driven projection (a run stores only new or changed content) is offered under the growth-model control, clearly labelled; it applies only once cross-run dedup ships (a recorded SPEC-level decision, not current behaviour).",
    `Stored ratio: the default assumes stored size is ${ratioToPct(DEFAULT_DEDUP_RATIO)} per cent of logical size (within-run dedup plus compression). Your real ratio depends on your content; override it above. In observed mode the per-run archive bytes come straight from your real run history instead.`,
    "Garbage collection: the accumulate curve models retention enforcement being OFF, which is the default, so nothing is pruned and storage grows with the run count. That is a setting, not a missing capability: the engine's manifest-driven segment collection does run and does delete unreferenced segments once you enable enforcement on a retention policy, which is what the retained curve projects. The results show both side by side.",
    `Object counts are estimated from the writer's segment size (the default is ${humanBytes(DEFAULT_SEG_BYTES)}, the engine's per-segment plaintext ceiling). For many small records this is a lower bound on the true object count; override the segment size to match an observed bytes-per-object ratio.`,
    `Per-run overhead: a modest fixed ${humanBytes(DEFAULT_OVERHEAD_BYTES)} per run is assumed for manifests, the run log and signatures; refined from observed data when available.`,
    "Monthly storage is averaged at the month midpoint for the accumulate regime and at the bounded steady state for the retained regime. Projections sum each month to the chosen horizon plus the one-off initial seal.",
    "Egress: in-account drills and restores incur no egress when the destination is in-account (for example R2 same-account); an offline recovery downloads the whole recoverable archive and always incurs egress at your entered rate.",
    "All maths is deterministic and runs in your browser over sizes and counts only; it never reads a key, a secret or archive content. Your figures and pricing never leave this browser; the screen's only request is the run-history read that seeds Observed mode.",
  ];
}
