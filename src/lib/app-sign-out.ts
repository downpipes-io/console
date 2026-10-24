// The sign-out path shared by the shell account menu, the Settings and Access "Sign out" buttons, and the
// palette's auth.sign-out (via the nav bridge), so a sign-out always ends what it can and the session does
// not survive Back.
import { toast } from "../components/toast.ts";
import { recordReadDegraded } from "./client-diag/ring.ts";
import { endEngineSession, SIGN_OUT_UNCONFIRMED_MESSAGE, SIGN_OUT_WAIT_MS } from "./sign-out.ts";
import { getEngine, signOut as storeSignOut } from "./store.ts";

/** The parts of the app shell sign-out drives. */
export interface SignOutShell {
  setCaller(caller: null, pending: boolean): void;
  setEngine(engine: { host: null }): void;
}

/** The part of the router sign-out drives. */
export interface SignOutRouter {
  navigate(path: string): void;
}

/**
 * performSignOut asks the engine to end the passkey session FIRST (before the store drops the engine
 * client), so the __Host- cookie is removed server-side and not just forgotten locally. Local sign-out never
 * waits on the answer: the console clears its own state and navigates to the sign-in at once; only the
 * warning waits, for at most the cap, and the request is aborted there. When the engine does not confirm
 * (transport failure, refusal, no answer) the session cookie may still be good, so a warning toast tells the operator and a diagnostics row records the failed
 * teardown. A token or Access session has no cookie to clear (the call is a harmless no-op); the Access
 * edge session, if any, is cleared at the edge, not here.
 */
export function performSignOut(shell: SignOutShell, router: SignOutRouter): void {
  const ending = endEngineSession(getEngine(), SIGN_OUT_WAIT_MS, (err) => recordReadDegraded("passkey-logout", err));
  storeSignOut();
  shell.setCaller(null, false);
  shell.setEngine({ host: null });
  // Return to the live sign-in (the passkey login), not the Access-only signed-out end state, so the
  // operator can sign straight back in with a passkey, Access or the token.
  router.navigate("/passkey");
  const warn = (): void => {
    toast({ message: SIGN_OUT_UNCONFIRMED_MESSAGE, tone: "warn", durationMs: 0 });
  };
  // endEngineSession never rejects; the catch is a second guard so a rejection still shows the warning.
  void ending.then((outcome) => {
    if (outcome === "unconfirmed") warn();
  }, warn);
}
