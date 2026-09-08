// The read-only "what's in this update" release-metadata block for an AVAILABLE, verified update. Moved
// verbatim from update.ts for size; copy, markup and the text-only rendering are
// unchanged. House rules: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { badge } from "../../components/status.ts";
import { banner } from "../../components/feedback.ts";
import {
  riskClassLabel,
  riskClassTone,
  riskClassNeedsCare,
  changelogTypeLabel,
  releasedAgoLine,
} from "./shared.ts";
import { detailRow } from "./detail-rows.ts";
import type { UpdateStatus, ChangelogEntry, RequiredStep } from "../../api.ts";

// renderReleaseMetadata renders the signed channel's rich release description for an AVAILABLE update: the
// risk-class badge (routine/migration/breaking, the migration/breaking one made visually distinct with a warn
// banner), the changelog (grouped, type-prefixed), the impact notes, the required steps (a blocking step is
// flagged so it cannot be sleep-walked past), the compat note + "released N days ago". It renders ONLY when an
// update is available and verified (otherwise there is nothing honest to show), and only the fields the channel
// actually set (each is optional + additive, an older channel without them simply omits that part). Every
// string is set as text (h() is textContent-first), so a channel-supplied line can never inject markup; the
// whole channel is signature-verified by the engine before any of this is surfaced. Returns null when there is
// nothing to render (so the caller appends nothing, §7a calm density, no empty block).
export function renderReleaseMetadata(upd: UpdateStatus): HTMLElement | null {
  if (upd.updateAvailable !== true || !upd.verified) return null;
  // The risk-class badge always shows for an available+verified update (the engine always sends a normalised
  // riskClass then), so the block always has at least that. The rest renders only when its field is present.
  const block = h("div", { class: "stack-sm", style: "margin-top:var(--space-4)" });
  block.appendChild(riskClassHeader(upd));
  const released = releasedAgoLine(upd.releasedAt);
  if (released) block.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, released));
  const changelog = changelogSection(upd);
  if (changelog) block.appendChild(changelog);
  const impact = impactSection(upd);
  if (impact) block.appendChild(impact);
  const steps = requiredStepsSection(upd);
  if (steps) block.appendChild(steps);
  // Compat note (the human note paired with minEngineVersion). The hard compat VERDICT (apply blocked) is shown
  // at the apply control via compatBlockedReason; this is just the descriptive note when present.
  if (typeof upd.compat === "string" && upd.compat !== "") block.appendChild(detailRow("Compatibility", upd.compat));
  // Build provenance BEFORE the apply: when the signed channel carries a provenance block, say so
  // with the two identifiers that matter at review time (the source commit and the CI run); when it does
  // not, say that too -- an unattested release is a fact the operator reviews, not a blank. The full
  // link set (Rekor, attestation files) lives in the Provenance section below on this same screen.
  const provLine = provenanceLine(upd);
  if (provLine) block.appendChild(provLine);
  return block;
}

// provenanceLine renders the one-line pre-apply provenance summary, or null on an older engine that does
// not report the field at all (nothing honest to say either way then). Text only, like every other row.
function provenanceLine(upd: UpdateStatus): HTMLElement | null {
  if (!("provenance" in upd) && !("channelBase" in upd)) return null;
  const p = upd.provenance;
  if (p === undefined) {
    return detailRow("Build provenance", "not published for this release; the signed channel digest still gates the apply, verified in this account before any deploy");
  }
  // Runtime string narrowing before slice/render: the legacy artefacts[] path passes the parsed
  // block through raw, and a signed-but-garbled value must degrade to absence, never throw.
  const s = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const commit = s(p.commit);
  const runId = s(p.runId);
  const rekor = s(p.rekorLogIndex);
  const bits: string[] = [];
  if (commit !== undefined) bits.push(`commit ${commit.slice(0, 12)}`);
  if (runId !== undefined) bits.push(`CI run ${runId}`);
  if (rekor !== undefined) bits.push(`Rekor ${rekor}`);
  return detailRow("Build provenance", bits.length > 0 ? `attested build (${bits.join(", ")}); full links in the Provenance section below` : "attested build; full links in the Provenance section below");
}

// riskClassHeader builds the risk-class heading + badge (shape + label, not colour alone), plus a warn banner
// for a migration/breaking release that needs care (the brief's "visually distinct" for the release that needs it).
function riskClassHeader(upd: UpdateStatus): HTMLElement {
  const wrap = h("div", { class: "stack-sm" });
  wrap.appendChild(
    h(
      "div",
      { style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap" },
      h("h3", { class: "card__title", style: "margin:0" }, "What's in this update"),
      badge(riskClassTone(upd.riskClass) === "info" ? "info" : "warn", riskClassLabel(upd.riskClass), { dot: true }),
    ),
  );
  if (riskClassNeedsCare(upd.riskClass)) {
    wrap.appendChild(
      banner({
        tone: "warn",
        message:
          upd.riskClass === "breaking"
            ? "This is a breaking release. Read the changes and any required steps below before you apply it, it may need an action before or after the update. It is still brick-safe (verify-before-deploy, canary-gated with one-click rollback) and your data and recovery are never at risk."
            : "This release changes stored shape (a migration) and needs a closer read. Review the changes and any required steps below before applying. It is still brick-safe (verify-before-deploy, canary-gated with one-click rollback) and your data and recovery are never at risk.",
      }),
    );
  }
  return wrap;
}

// changelogSection renders the grouped changelog rows, each "<Type>: <text>", or null when none was sent.
// Bounded by the engine's parse; rendered as text only.
function changelogSection(upd: UpdateStatus): HTMLElement | null {
  if (!Array.isArray(upd.changelog) || upd.changelog.length === 0) return null;
  const wrap = h("div");
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Changes:"));
  const list = h("ul", { style: "list-style:disc;padding-left:var(--space-5);margin-top:var(--space-1);display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const e of upd.changelog as ChangelogEntry[]) {
    list.appendChild(
      h(
        "li",
        h("span", { class: "field__hint", style: "font-weight:600" }, `${changelogTypeLabel(e.type)}: `),
        h("span", { style: "color:var(--text)" }, e.text),
      ),
    );
  }
  wrap.appendChild(list);
  return wrap;
}

// impactSection renders the plain "what this affects" bullet notes, or null when none was sent. Text only.
function impactSection(upd: UpdateStatus): HTMLElement | null {
  if (!Array.isArray(upd.impact) || upd.impact.length === 0) return null;
  const wrap = h("div");
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Impact:"));
  const list = h("ul", { style: "list-style:disc;padding-left:var(--space-5);margin-top:var(--space-1);display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const line of upd.impact as string[]) list.appendChild(h("li", { style: "color:var(--text)" }, line));
  wrap.appendChild(list);
  return wrap;
}

// requiredStepsSection renders the explicit operator actions in the "what's in this update" block, or null
// when none was sent. A BLOCKING step is shown with a prominent "Required" badge here for attention; the
// ACKNOWLEDGEMENT GATE that actually keeps Update-now disabled until every blocking step is ticked lives at
// the apply control (availableUpdateBody in update-available-body.ts), so this block stays read-only.
function requiredStepsSection(upd: UpdateStatus): HTMLElement | null {
  if (!Array.isArray(upd.requiredSteps) || upd.requiredSteps.length === 0) return null;
  const wrap = h("div");
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Required steps:"));
  const list = h("ul", { style: "list-style:none;padding-left:0;margin-top:var(--space-1);display:flex;flex-direction:column;gap:var(--space-2)" });
  for (const step of upd.requiredSteps as RequiredStep[]) {
    list.appendChild(
      h(
        "li",
        { style: "display:flex;align-items:flex-start;gap:var(--space-2)" },
        step.blocking ? badge("warn", "Required", { dot: true }) : badge("default", "Step"),
        h("span", { style: "color:var(--text)" }, step.text),
      ),
    );
  }
  wrap.appendChild(list);
  return wrap;
}
