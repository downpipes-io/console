// caller-state.ts -- the resolved caller identity and whether /admin/whoami answered, held in a LEAF
// module that imports nothing but its own type.
//
// Why it is separate from store.ts. These two facts used to live in store.ts's state object, and
// store.ts imports EngineClient, so anything that needed the caller had to reach through the whole
// API client to get it. That closed a genuine runtime import cycle that the gating madge job flags:
//
//   api.ts -> lib/api/client.ts -> lib/api/client-session.ts -> lib/nav.ts -> lib/store.ts -> api.ts
//
// client-session.ts needs the caller's auth method for one decision (whether to attach the
// terminate-other-sessions adminOp header), and reading it should not drag in the client that
// client-session is part of. A leaf breaks every path: nav.ts, store.ts and client-session.ts can all
// read the caller without any of them importing each other.
//
// store.ts keeps its getCaller/setCaller/isWhoamiAvailable/setWhoamiAvailable exports, delegating
// here, so no existing caller of the store API changes.
import type { Caller } from "./api/types/who.ts";
// The one runtime edge this leaf takes, and it is to another leaf that imports nothing: the reset below
// must clear the identity FAULT as well as the identity, or a signed-out tab would keep offering the
// remedy for a failure that belonged to the previous session.
import { setIdentityFault } from "./identity-remedy.ts";

let caller: Caller | null = null;
let whoamiAvailable = false;

/** The verified caller identity, or null before /admin/whoami has resolved (or when it could not). */
export function getCaller(): Caller | null {
  return caller;
}

// callerListeners are the "the console's AUTHORITY just changed" subscribers, and they live HERE
// because this leaf is the one place every identity resolve passes through: the boot resolve, the
// passkey sign-in handoff (app.ts buildNavBridge onAuthenticated, which is an SPA handoff and never a
// page load), any screen's refreshIdentity(), the bfcache pageshow re-resolve, and sign-out all land on
// setCaller or resetCallerState. A read whose ANSWER DEPENDS ON WHO IS ASKING must be re-taken at that
// moment, and subscribing here rather than at one of those call sites means a later entry point cannot
// be added without it. Nothing about the caller travels to a subscriber: the notification carries no
// argument, so a listener that wants the identity reads it back through getCaller().
const callerListeners = new Set<() => void>();

/**
 * Subscribe to a CHANGE of resolved authority. Returns the unsubscribe. Fires only when the resolved
 * caller actually changes (authorityKey below), so a refresh that resolves the same operator again does
 * not turn a listener into a per-refresh read.
 */
export function onCallerChanged(fn: () => void): () => void {
  callerListeners.add(fn);
  return () => {
    callerListeners.delete(fn);
  };
}

// authorityKey is the VALUE identity of a caller, so a fresh object built from an identical whoami is
// recognised as the same authority. buildCallerFromWhoami constructs a new object on every resolve, so
// a reference comparison here would fire on every refresh; these are the fields that decide what the
// caller may do and which are therefore the ones a re-read could answer differently.
function authorityKey(c: Caller | null): string {
  if (c === null) return "";
  return [c.method, c.subject ?? "", c.email ?? "", c.role, c.customRole?.name ?? ""].join("|");
}

function notifyCallerChanged(before: string): void {
  if (authorityKey(caller) === before) return;
  for (const fn of [...callerListeners]) fn();
}

export function setCaller(next: Caller | null): void {
  const before = authorityKey(caller);
  caller = next;
  notifyCallerChanged(before);
}

/** Whether /admin/whoami answered at all, which is distinct from it answering with no caller. */
export function isWhoamiAvailable(): boolean {
  return whoamiAvailable;
}

export function setWhoamiAvailable(v: boolean): void {
  whoamiAvailable = v;
}

/** Clears both, for the sign-out and reset paths that store.ts owns. */
export function resetCallerState(): void {
  const before = authorityKey(caller);
  caller = null;
  whoamiAvailable = false;
  setIdentityFault(null);
  notifyCallerChanged(before);
}
