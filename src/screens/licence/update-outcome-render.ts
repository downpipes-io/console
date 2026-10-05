// Bridges the pure RecordedSettleOutcome mapping (shared.ts) to the exact copy (update-outcome-
// copy.ts) and the one DOM node the destination gate needs.
// Split out on its own (not folded into shared.ts, which is at its max-lines budget; not folded into
// update-outcome-copy.ts, which stays deliberately DOM-free) so both the live apply flow (update-apply-
// flow.ts) and the pending card (update-pending-body.ts) -- and, for the destination gate, the proactive body
// (update-available-body.ts) too -- share ONE implementation each, with no import cycle between those three
// (update-available-body.ts already imports FROM update-apply-flow.ts, so the destination-gate node cannot
// live in either of them without creating one).

import { banner } from "../../components/feedback.ts";
import { navigate } from "../../lib/nav.ts";
import type { RecordedSettleOutcome } from "./shared.ts";
import { appliedTerminalLine, appliedUnconfirmedTerminalLine, rollbackFailedTerminalLine, rolledBackTerminalLine, EXPIRED_CLEARED_LINE, STALL_LINE, DESTINATION_GATE_CONSOLE_LINE } from "./update-outcome-copy.ts";

// terminalLineForOutcome maps a RecordedSettleOutcome to the terminal sentence: the exact applied
// [+confirmation-pending/+reload]/rolled-back/expired-cleared sentences, or the honest stall line for a
// genuinely non-definitive outcome (pending/unknown) -- the caller decides separately whether "stall" means
// starting the silent background poll (the live apply flow) or simply leaving the resume controls available
// (the pending card). ONE mapping, shared by both renderers, so the two surfaces can never drift on what a
// given recorded outcome says. consoleApplied lets a caller fold in the reload suffix when it
// independently knows the console component also landed in the SAME live apply (the recorded record alone
// cannot say this: it only tracks the engine canary). Pure + DOM-free so the validator pins each mapping.
export function terminalLineForOutcome(o: RecordedSettleOutcome, opts: { consoleApplied?: boolean } = {}): string {
  switch (o.kind) {
    case "applied":
      return appliedTerminalLine(o.toVersion, { confirmationPending: o.confirmationPending, ...(opts.consoleApplied !== undefined ? { consoleApplied: opts.consoleApplied } : {}) });
    case "rolled-back":
      return rolledBackTerminalLine(o.reason);
    // The engine's "rollback-failed" and "applied-unconfirmed" outcomes must not fall through to the
    // default arm below: that would render STALL_LINE ("still verifying") over an engine that has already
    // finished settling and is serving the rejected build.
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

// destinationGateNode is the destination-gate notice: the update card's apply control replaces itself
// with this ONE line + a link to /destinations, shown PROACTIVELY (status.destConfigured is
// false, before any token is even collected) and REACTIVELY (a live apply refused with the engine's exact
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
