// The single source of truth for the orchestrated-flow copy: every string here is NORMATIVE, byte-for-byte.
// Kept in its own pure,
// DOM-free leaf (mirrors this family's existing convention, e.g. update-release-metadata.ts, for a cohesive
// slice of copy) so the validator pins each string directly and no renderer hand-composes its own variant.
//
// One deliberate transliteration: the design doc's own prose for the stall-state sentence uses a
// typographic em dash (U+2014) between the two clauses, but house lint (lint:prose, scripts/writing-rules-
// source.mjs) bans that character anywhere in src, including inside a string literal, so it is written here
// with the ASCII "--" this family already uses for the identical reason (componentRowLine's "Console -- up
// to date", consoleReloadPromptLine's "reload to finish"). The words are unchanged; only the dash glyph is.
//
// House rules: Australian English, no em dashes, precise claims.

// ---------------------------------------------------------------------------
// s2: the in-place progress stages (each REPLACES the last; plain English, no engine jargon)
// ---------------------------------------------------------------------------
export const STAGE_CHECKING = "Checking the release…" as const;
export const STAGE_DEPLOYING_ENGINE = "Deploying the engine…" as const;
export const STAGE_PROVING = "Proving the new version…" as const;
export const STAGE_PROVING_SUBLINE = "this can take a minute" as const;
export const STAGE_UPDATING_CONSOLE = "Updating the console…" as const;

// ---------------------------------------------------------------------------
// s2: the honest stall state -- the WHOLE client retry budget is exhausted; it keeps polling by itself, no
// user action requested. See update-retry.ts pollUntilDefinitive for the polling this promises.
// ---------------------------------------------------------------------------
export const STALL_LINE = "Still verifying -- this screen keeps checking by itself." as const;

// ---------------------------------------------------------------------------
// s2/s5: the stale-pending-expired first-class outcome. Never "could not be read".
// ---------------------------------------------------------------------------
export const EXPIRED_CLEARED_LINE = "A leftover verification from an earlier attempt was cleared; nothing was changed." as const;

// appliedTerminalLine is the s2 "Updated to <version>." terminal sentence, optionally extended with the s5
// calm confirmation-pending clause (the engine kept the update; the hourly canary has not yet sung on it in
// the background; no token, no action needed) and the s2 reload suffix ("Reload to finish", when the console
// component applied too). Order is engine-fact then console-fact, the same ordering the rest of this family
// uses (engine settles first, the console applies after). version may be null on the persistence-first
// recovery path (an honestly incomplete recorded outcome), in which case the sentence degrades gracefully
// rather than interpolating "undefined".
export function appliedTerminalLine(version: string | null, opts: { confirmationPending?: boolean; consoleApplied?: boolean } = {}): string {
  let line = version ? `Updated to ${version}.` : "Updated.";
  if (opts.confirmationPending) line += " Finishing verification in the background; no action needed.";
  if (opts.consoleApplied) line += " Reloading to finish.";
  return line;
}

// rolledBackTerminalLine is the s2 "Rolled back automatically: <reason>. Nothing else was changed." terminal
// sentence. The fallback reason (an engine that recorded none) matches the voice settleOutcomeLine already
// uses elsewhere in this family, so the sentence never dangles a colon with nothing after it.
export function rolledBackTerminalLine(reason: string | null | undefined): string {
  const why = reason && reason.trim() !== "" ? reason.trim() : "the canary did not confirm the new version";
  return `Rolled back automatically: ${why}. Nothing else was changed.`;
}

// ---------------------------------------------------------------------------
// Two of the engine's outcomes, which had no copy at all until this was written and so rendered as the
// STALL_LINE above. Both sentences say what state the engine is in, and both name the remedy, because in
// each case the remedy is a control this screen already offers.
// ---------------------------------------------------------------------------

// rollbackFailedTerminalLine is the loudest sentence in this family and the state it describes is the worst
// one the update path can reach: the canary rejected the new version, the automatic rollback deploy failed
// too, and the engine is STILL RUNNING the rejected build right now. It must never be softened into the
// reassuring rolled-back voice, which is the exact lie the engine grew its own member to stop telling.
export function rollbackFailedTerminalLine(onVersion: string | null, target: string | null): string {
  const on = onVersion ? `still running ${onVersion}, the version that failed` : "still running the version that failed";
  const back = target ? ` Roll back to ${target} from here.` : " Roll back from here.";
  return `The update did not pass its check and the automatic rollback did not complete. Your engine is ${on}.${back}`;
}

// appliedUnconfirmedTerminalLine is the honest form of a promote that was ACCEPTED and never confirmed. It
// claims the deploy and no more: "applied" would claim a proof that was never obtained, and the stall line
// claimed nothing had happened when something had.
export function appliedUnconfirmedTerminalLine(version: string | null): string {
  const which = version ? `${version} was deployed` : "the new version was deployed";
  return `${which}, but the engine could not confirm which version is live. Reload the console to check it, and roll back from here if it misbehaves.`;
}

// ---------------------------------------------------------------------------
// s4: the destination gate -- the engine's exact refusal reason (matched verbatim to detect it reactively)
// and the console's own line (shown proactively + reactively), both normative.
// ---------------------------------------------------------------------------
export const DESTINATION_GATE_ENGINE_REASON = "updates verify themselves with a canary flight to your destination; add a destination first, then apply this update" as const;
export const DESTINATION_GATE_CONSOLE_LINE = "Updates verify themselves with a canary flight to your destination. Add a destination first." as const;

// ---------------------------------------------------------------------------
// s6: the paired-rollback confirm line, shown BEFORE the token is spent when the engine's rollback plan
// reports paired:true (rolling the engine back would violate the live console's floor, so the console goes
// with it rather than being stranded incompatible).
// ---------------------------------------------------------------------------
export const PAIRED_ROLLBACK_LINE = "Rolling the engine back past what this console requires; the console will be rolled back with it." as const;
