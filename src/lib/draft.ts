// In-progress form/selection drafts that survive a navigation hop or a refresh (the
// navigation design,: "never silently discard the operator's work"). A
// thin typed wrapper over sessionStorage, scoped per engine host so two engines in
// two tabs never cross-fill.
//
// THE HONESTY RULE (hard): a draft holds ONLY non-sensitive in-progress input, which
// accounts/bindings are ticked, a half-typed downpipe name, a store type and the ids
// the operator already pasted from the dashboard. A SECRET, TOKEN, KEY or PASTED
// CREDENTIAL never enters a draft (nor the URL); those stay in memory and are
// intentionally lost on navigation, with a discard guard where the loss is
// destructive. Callers are responsible for never putting a secret in the value; this
// module deliberately offers no "secure" mode, because there is no secure browser
// store and pretending otherwise would be the dishonesty the product refuses.

import { recordStorageBlocked } from "./client-diag/ring.ts";
import { getEngineUrl } from "./store.ts";

const PREFIX = "dp-draft:";

// hostScope keys drafts to the connected engine host so a draft from one engine never
// rehydrates against another. A missing/unparseable URL falls back to a stable label.
function hostScope(): string {
  const url = getEngineUrl();
  if (!url) return "noengine";
  try {
    return new URL(url).host;
  } catch {
    return "noengine";
  }
}

function keyFor(id: string): string {
  return `${PREFIX}${hostScope()}:${id}`;
}

// saveDraft stores a JSON-serialisable draft under a stable id (e.g. "sources-selection",
// `restore-plan:${runId}`). Best-effort: a storage exception (private mode, quota) is
// swallowed so a draft never breaks a flow. NEVER pass a secret in the value.
export function saveDraft<T>(id: string, value: T): void {
  try {
    sessionStorage.setItem(keyFor(id), JSON.stringify(value));
  } catch (err) {
    // sessionStorage unavailable or full: the draft simply does not survive the hop. This swallow is the
    // "the console keeps losing my half-filled wizard" case, and the quota arm and the policy arm of it are
    // two different answers (clear the site data, or change the browser policy), so the class is recorded. The
    // draft id is NOT recorded: it can carry a run id.
    recordStorageBlocked("session", "write", "draft", err);
  }
}

// loadDraft reads a draft, or null when absent / unparseable / storage unavailable. The
// optional validate guard lets a caller reject a structurally stale draft (e.g. after a
// field rename in an older schema); without it the parsed value is asserted as T unchecked.
export function loadDraft<T>(id: string, validate?: (v: unknown) => v is T): T | null {
  try {
    const raw = sessionStorage.getItem(keyFor(id));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (validate) return validate(parsed) ? parsed : null;
    return parsed as T;
  } catch (err) {
    // A blocked store and an unparseable draft both land here, and only the first is the browser's doing: the
    // classifier admits a JSON SyntaxError as `other`, never as a storage denial, so a corrupt draft cannot
    // masquerade as a locked-down profile.
    if (!(err instanceof SyntaxError)) recordStorageBlocked("session", "read", "draft", err);
    return null;
  }
}

// clearDraft removes a draft (on a successful save/submit, so a completed flow does
// not rehydrate stale input next time).
export function clearDraft(id: string): void {
  try {
    sessionStorage.removeItem(keyFor(id));
  } catch (err) {
    // Nothing to do; an unremovable draft is harmless (it is overwritten on next save).
    recordStorageBlocked("session", "remove", "draft", err);
  }
}
