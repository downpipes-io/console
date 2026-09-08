// The platform preflight presentation logic (GET /admin/preflight): the pure, honesty-critical
// mappings that turn the engine's live entitlement probes into the card's tones, words and
// headline verdict. These are leaf functions with no DOM and no sibling imports, extracted from
// the onboarding coordinator for size while keeping the public surface byte-identical; the
// coordinator re-exports them so external callers (the support validator) import them unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { StatusTone } from "../../components/status.ts";
import type { PreflightItem, PreflightReport, PreflightStatus } from "../../api.ts";

// preflightItemPresentation maps one preflight status to its honest tone + word. The mapping
// is deliberately closed and conservative: ONLY an engine-observed "verified" reads ok/green;
// "configured" is the cautious present-but-unproven info state; "unconfigured" is a neutral
// to-do; "failed" is danger. The console never upgrades a status (no fabricated green), and an
// unknown status from a newer engine degrades to the neutral to-do, never to a pass.
// Exported (pure, DOM-free) so the validator pins the no-fabricated-green mapping.
export function preflightItemPresentation(status: PreflightStatus): { tone: StatusTone; word: string } {
  switch (status) {
    case "verified":
      return { tone: "ok", word: "verified" };
    case "configured":
      return { tone: "info", word: "configured, unproven" };
    case "failed":
      return { tone: "danger", word: "failed" };
    case "unconfigured":
      return { tone: "neutral", word: "to do" };
    default:
      // A status this build does not know: render it as an honest to-do with the raw word,
      // never as a pass.
      return { tone: "neutral", word: String(status) };
  }
}

// preflightVerdict derives the card's headline verdict from the engine's own summary. Honest
// by construction: green requires EVERY required item verified AND zero failures; any failure
// is danger regardless of how many passes sit beside it; anything else is the cautious
// in-between. Exported (pure) so the validator pins the honesty rules.
export function preflightVerdict(summary: PreflightReport["summary"]): { tone: "ok" | "warn" | "danger"; title: string } {
  if (summary.failed > 0) {
    return { tone: "danger", title: `${summary.failed} preflight ${summary.failed === 1 ? "check" : "checks"} failed` };
  }
  if (summary.requiredVerified === summary.required) {
    return { tone: "ok", title: `All ${summary.required} required prerequisites verified` };
  }
  return { tone: "warn", title: `${summary.requiredVerified} of ${summary.required} required prerequisites verified` };
}

// orderPreflightItems returns the items with every FAILED item first (engine order preserved
// within each group), so a failure is the first thing read rather than buried below greens.
// Pure and stable; exported for the validator.
export function orderPreflightItems(items: PreflightItem[]): PreflightItem[] {
  return [...items.filter((i) => i.status === "failed"), ...items.filter((i) => i.status !== "failed")];
}
