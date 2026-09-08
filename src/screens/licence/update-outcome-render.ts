// Bridges the pure RecordedSettleOutcome mapping (shared.ts) to the design's exact copy (update-outcome-
// copy.ts) and the one DOM node the destination gate needs (design/updates/UPDATE-UX-015-DESIGN.md s2/s4).
// Split out on its own (not folded into shared.ts, which is at its max-lines budget; not folded into
// update-outcome-copy.ts, which stays deliberately DOM-free) so both the live apply flow (update-apply-
// flow.ts) and the pending card (update-pending-body.ts) -- and, for the destination gate, the proactive body
// (update-available-body.ts) too -- share ONE implementation each, with no import cycle between those three
// (update-available-body.ts already imports FROM update-apply-flow.ts, so the destination-gate node cannot
// live in either of them without creating one). House rules: Australian English, no em dashes, no AI
// attribution.

import { banner } from "../../components/feedback.ts";
import { navigate } from "../../lib/nav.ts";
import type { RecordedSettleOutcome } from "./shared.ts";
import { appliedTerminalLine, appliedUnconfirmedTerminalLine, rollbackFailedTerminalLine, rolledBackTerminalLine, EXPIRED_CLEARED_LINE, STALL_LINE, DESTINATION_GATE_CONSOLE_LINE } from "./update-outcome-copy.ts";

// terminalLineForOutcome maps a RecordedSettleOutcome to the design s2 terminal sentence: the exact applied
// [+confirmation-pending/+reload]/rolled-back/expired-cleared sentences, or the honest stall line for a
// genuinely non-definitive outcome (pending/unknown) -- the caller decides separately whether "stall" means
// starting the silent background poll (the live apply flow) or simply leaving the resume controls available
// (the pending card). ONE mapping, shared by both s2 renderers, so the two surfaces can never drift on what a
// given recorded outcome says. consoleApplied lets a caller fold in the s2 reload suffix when it
// independently knows the console component also landed in the SAME live apply (the recorded record alone
// cannot say this: it only tracks the engine canary). Pure + DOM-free so the validator pins each mapping.
export function terminalLineForOutcome(o: RecordedSettleOutcome, opts: { consoleApplied?: boolean } = {}): string {
  switch (o.kind) {
    case "applied":
      return appliedTerminalLine(o.toVersion, { confirmationPending: o.confirmationPending, ...(opts.consoleApplied !== undefined ? { consoleApplied: opts.consoleApplied } : {}) });
    case "rolled-back":
      return rolledBackTerminalLine(o.reason);
    // Two of the engine's outcomes. Both used to fall through to the default arm and render STALL_LINE,
    // so the live flow's last word on a failed rollback was "still verifying" over an engine that had
    // finished settling and was serving the rejected build.
    case "rollback-failed":
      return rollbackFailedTerminalLine(o.onVersion, o.target);
    case "applied-unconfirmed":
      return appliedUnconfirmedTerminalLine(o.toVersion);
    case "expired-cleared":
      return EXPIRED_CLEARED_LINE;
    default:
      return STALL_LINE;
  }
}

// destinationGateNode is the s4 destination-gate notice: the update card's apply control replaces itself
// with this ONE line + a link to /destinations (design s4), shown PROACTIVELY (status.destConfigured is
// false, before any token is even collected) and REACTIVELY (a live apply refused with the engine's exact s4
// reason -- caught after the token was already spent once, the gate still fires, just one step later than
// the proactive path would have). Preview stays available either way: a dry-run deploys nothing, so it can
// never be blocked by a missing destination.
export function destinationGateNode(): HTMLElement {
  return banner({
    tone: "info",
    message: DESTINATION_GATE_CONSOLE_LINE,
    action: { label: "Add a destination", onClick: () => navigate("/destinations") },
  });
}
