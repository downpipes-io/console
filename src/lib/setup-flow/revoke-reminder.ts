// The deploy-token revoke reminder, kept OUTSIDE the setup tab. A deploy token pasted at Apply can edit the
// engine's Worker, and the engine does not keep it, so only the user can revoke it in Cloudflare. The setup draft
// lives in the tab (sessionStorage), so a reminder kept only there ended with the tab or with "Leave setup". This
// record lives in localStorage for this console's origin, so Overview keeps asking until the user confirms the
// revoke there or in setup.
//
// It holds a count and a date, never a token or any part of one. It is not session data (it describes a
// credential in the Cloudflare account, not the signed-in person), so the sign-out purge leaves it: the next
// Owner on this browser needs the same reminder. Storage can be absent or blocked; every access is guarded,
// and a blocked store leaves the in-tab reminder as the only one.

const KEY = "downpipes.setup.deploy-token-revoke";

export interface RevokeReminder {
  // How many times a pasted deploy token reached the engine. Each paste can be a different token.
  tokens: number;
  // When the first of them was used (ISO 8601).
  since: string;
}

export function readRevokeReminder(): RevokeReminder | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<RevokeReminder>;
    if (typeof v.tokens !== "number" || !Number.isInteger(v.tokens) || v.tokens < 1 || typeof v.since !== "string") return null;
    return { tokens: v.tokens, since: v.since };
  } catch {
    return null;
  }
}

// The demo (tour and training) keeps no reminder outside the tab: its tokens are sample values and nothing
// leaves the browser. startDemo (lib/demo/demo-fetch.ts) stamps data-demo-state on <html> before anything
// renders, and only the demo does. The setup model keeps no draft copy outside the tab in the demo either
// (model.ts): each page load of the demo starts a new world.
export function demoRunning(): boolean {
  try {
    return document.documentElement.dataset.demoState !== undefined;
  } catch {
    return false;
  }
}

// noteDeployTokenUsed records one more use. Called once per Apply press whose token reached the engine.
export function noteDeployTokenUsed(): void {
  if (demoRunning()) return;
  const cur = readRevokeReminder();
  const next: RevokeReminder = { tokens: (cur?.tokens ?? 0) + 1, since: cur?.since ?? new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the setup draft's reminder still stands for this tab.
  }
}

// clearRevokeReminder runs when the user confirms the revoke (setup's tick, or Overview's).
export function clearRevokeReminder(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

// revokeSentence names the tokens to revoke: one, or each of several.
export function revokeSentence(tokens: number): string {
  return tokens <= 1
    ? "Revoke the deploy token you used in setup, in the Cloudflare dashboard."
    : `You pasted a deploy token ${tokens} times in setup. Revoke each token you made, in the Cloudflare dashboard.`;
}
