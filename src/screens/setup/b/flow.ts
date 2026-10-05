// Focus Flow (concept B) routing: which URL each question owns, where "resume" lands, and the concept's small
// record of answers the foundation draft does not carry (a default the user saw and kept, such as the
// provider). The step statuses themselves come from the foundation model; nothing here decides a step done.

import type { SetupSnapshot, SetupStepId } from "../../../lib/setup-flow/index.ts";
import { DRAFT_PREFIX } from "../../../lib/storage-keys.ts";
import { onSessionCleared } from "../../../lib/store.ts";
import type { QId } from "./types.ts";

// The question URLs. A step with sub-questions resolves /setup/<step> to its first undecided question.
export const Q_ROUTE: Record<QId, { step: SetupStepId; sub: string | null }> = {
  welcome: { step: "welcome", sub: null },
  connect: { step: "connect", sub: "token" },
  provider: { step: "destination", sub: "provider" },
  bucket: { step: "destination", sub: "bucket" },
  lock: { step: "destination", sub: "lock" },
  credentials: { step: "destination", sub: "credentials" },
  pricing: { step: "destination", sub: "pricing" },
  protect: { step: "protect", sub: null },
  posture: { step: "keys", sub: "posture" },
  custody: { step: "keys", sub: "custody" },
  generate: { step: "keys", sub: "generate" },
  saved: { step: "keys", sub: "saved" },
  apply: { step: "apply", sub: "token" },
  manual: { step: "apply", sub: "manual" },
  revoke: { step: "apply", sub: "revoke" },
  backup: { step: "backup", sub: "plan" },
  run: { step: "backup", sub: "run" },
  finish: { step: "finish", sub: null },
  hardening: { step: "finish", sub: "hardening" },
  check: { step: "finish", sub: "check" },
  team: { step: "team", sub: null },
  approval: { step: "approval", sub: null },
};

export const Q_ORDER: readonly QId[] = ["welcome", "connect", "provider", "bucket", "lock", "credentials", "pricing", "protect", "posture", "custody", "generate", "saved", "apply", "manual", "revoke", "backup", "run", "finish", "hardening", "check", "team", "approval"];

// The seven numbered steps (Welcome is step 0 and carries no number). One denominator everywhere.
export const STEP_NUMBER: Partial<Record<SetupStepId, number>> = { connect: 1, destination: 2, protect: 3, keys: 4, apply: 5, backup: 6, finish: 7 };
export const STEP_NAME: Record<SetupStepId, string> = {
  welcome: "Welcome",
  connect: "Connect",
  destination: "Destination",
  protect: "Protect",
  keys: "Keys",
  apply: "Apply",
  backup: "First backup",
  finish: "Finish",
  team: "Team",
  approval: "Restore approval",
};

// qFromParams maps a route match to a question id, or null when the URL names a step without a question.
export function qFromParams(step: SetupStepId | null, sub: string | null): QId | null {
  if (step === null) return null;
  for (const q of Q_ORDER) {
    const r = Q_ROUTE[q];
    if (r.step === step && r.sub === sub) return q;
  }
  return null;
}

// qPath is a question's path without the query.
export function qPath(q: QId): string {
  const r = Q_ROUTE[q];
  return r.sub !== null ? `/setup/${r.step}/${r.sub}` : `/setup/${r.step}`;
}

// qHref is a question's URL. A Change adds ?return= so the commit goes back to where the user was.
export function qHref(q: QId, ret?: string | null): string {
  const base = qPath(q);
  if (ret === undefined || ret === null) return base;
  return `${base}?return=${encodeURIComponent(ret)}`;
}

// ---- the concept's answer record ---------------------------------------------------------------------------

// Both records are in the DRAFT_PREFIX family, so the sign-out and session-end purge removes them with the draft.
const ANSWERS_KEY = `${DRAFT_PREFIX}setup-answers-v1`;

export function loadAnswers(): Set<QId> {
  try {
    const raw = sessionStorage.getItem(ANSWERS_KEY);
    if (raw === null) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is QId => typeof x === "string" && (Q_ORDER as readonly string[]).includes(x)) : []);
  } catch {
    return new Set();
  }
}

export function saveAnswer(q: QId, on = true): void {
  const a = loadAnswers();
  if (on) a.add(q);
  else a.delete(q);
  try {
    sessionStorage.setItem(ANSWERS_KEY, JSON.stringify([...a]));
  } catch {
    // Storage blocked: the answer lasts as long as this page's memory, and the draft still holds the value.
  }
}

// ---- the custodian shares -------------------------------------------------------------------------------------
// Whether the existing split panel made the shares for the keys in this setup. The panel reports nothing
// back, so the Saved question records it when the panel delivers the encrypted key file (identity.key.enc,
// the first file of a finished split). Cleared whenever keys are made again: shares of old keys do not count.

const SPLIT_KEY = `${DRAFT_PREFIX}setup-shares-v1`;
let sharesMem: boolean | null = null;
// The memory copy goes with the session too (the storage copy is removed by the purge itself).
onSessionCleared(() => { sharesMem = null; });

export function sharesMade(): boolean {
  if (sharesMem !== null) return sharesMem;
  try {
    sharesMem = sessionStorage.getItem(SPLIT_KEY) === "1";
  } catch {
    sharesMem = false;
  }
  return sharesMem;
}

export function setSharesMade(on: boolean): void {
  sharesMem = on;
  try {
    if (on) sessionStorage.setItem(SPLIT_KEY, "1");
    else sessionStorage.removeItem(SPLIT_KEY);
  } catch {
    // Storage blocked: the record lasts as long as this page's memory.
  }
}

// ---- progress -------------------------------------------------------------------------------------------------

// The questions of each step on the main path, in order. The progress line fills by question inside a step,
// so four questions under "Keys, 4 of 7" still move it.
const STEP_QS: Partial<Record<SetupStepId, readonly QId[]>> = {
  connect: ["connect"],
  destination: ["provider", "bucket", "lock", "credentials"],
  protect: ["protect"],
  keys: ["posture", "custody", "saved"],
  apply: ["apply", "revoke"],
  backup: ["backup", "run"],
};

// stepShare is how far into its step the question on screen is, from 0 up to (not including) 1.
export function stepShare(q: QId, provider: string): number {
  const step = Q_ROUTE[q].step;
  const qs = (STEP_QS[step] ?? []).filter((x) => !(x === "lock" && provider === "r2"));
  const i = qs.indexOf(q === "generate" ? "saved" : q === "manual" ? "apply" : q);
  return i <= 0 || qs.length === 0 ? 0 : i / qs.length;
}

// ---- resume ------------------------------------------------------------------------------------------------

export function stepDone(s: SetupSnapshot, id: SetupStepId): boolean {
  return s.steps.find((x) => x.id === id)?.status === "done";
}

// resumeQ is the first undecided question on the main path.
export function resumeQ(s: SetupSnapshot, ans: Set<QId> = loadAnswers()): QId {
  const d = s.draft;
  if (!stepDone(s, "welcome")) return "welcome";
  if (!stepDone(s, "connect")) return "connect";
  if (!stepDone(s, "destination")) {
    if (!ans.has("provider")) return "provider";
    if (d.bucket.trim() === "") return "bucket";
    if (d.provider !== "r2" && !ans.has("lock")) return "lock";
    return "credentials";
  }
  if (!stepDone(s, "protect")) return "protect";
  if (!stepDone(s, "keys")) {
    if (!d.postureAcknowledged) return "posture";
    // Custody carries "Make my keys": the scheme is chosen and the keys made in one question.
    if (d.custody === null || !d.keysGenerated) return "custody";
    // Keys made in an earlier tab are gone after a reload: the generate view says so and makes them again.
    if (!s.runtime.ceremonyHeld) return "generate";
    return "saved";
  }
  if (!stepDone(s, "apply")) return d.applyRoute === "self-deploy" ? "manual" : "apply";
  if (d.deployTokenUsed && !d.deployTokenRevoked && !ans.has("revoke")) return "revoke";
  if (!stepDone(s, "backup")) return d.firstRun !== null ? "run" : "backup";
  return "finish";
}

// ---- a console set up before this tab ------------------------------------------------------------------------

// setupRunHere: this tab worked through setup. It pressed Start, committed an answer, made keys, or created or
// ran a downpipe in setup. The plan, the receipt and Finish read this tab's draft, so they mean something only
// in such a tab.
export function setupRunHere(s: SetupSnapshot, ans: Set<QId> = loadAnswers()): boolean {
  const d = s.draft;
  return d.started || ans.size > 0 || d.keysGenerated || d.keysSent || d.createdDownpipeIds.length > 0 || d.firstRun !== null;
}

// setupDoneElsewhere: the shell counts setup complete (the model's page-life latch) and this tab did not run
// setup. Setup then has nothing true to show from its draft: its plan would read "Not set" for a destination
// the engine holds, and its receipt would name no sources for an estate of downpipes. /setup sends such a tab
// to Overview, except for the questions that stand on their own (STANDALONE_QS).
export function setupDoneElsewhere(s: SetupSnapshot, ans: Set<QId> = loadAnswers()): boolean {
  return s.completeSeen && !setupRunHere(s, ans);
}

// STANDALONE_QS: the questions that read the engine, not the draft, so they stay open on a console set up
// elsewhere. The team invite (the "Invite your team" link after a new Owner registers lands there) and the
// engine's own check (the palette's "Check engine wiring").
export const STANDALONE_QS: ReadonlySet<QId> = new Set<QId>(["team", "check"]);

// firstOfStep is where /setup/<step> lands: the resume question when it is in this step, else the step's
// first question.
export function firstOfStep(s: SetupSnapshot, step: SetupStepId): QId {
  const r = resumeQ(s);
  if (Q_ROUTE[r].step === step) return r;
  const first = Q_ORDER.find((q) => Q_ROUTE[q].step === step);
  return first ?? r;
}

export function orderOf(q: QId): number {
  return Q_ORDER.indexOf(q);
}
