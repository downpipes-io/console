// reload-handoff.ts -- the ONE closed-class fact that must survive the ONE reload the console itself performs.
//
// THE PROBLEM IT EXISTS FOR. The diagnostics ring is in-memory only, deliberately: there is no sessionStorage in
// it, so a shared workstation cannot carry one operator's error classes into another operator's pack. That rule
// is right, and it has one consequence that was fatal to this: the post-apply console build check records
// `confirmed` and then, ~1.5 seconds later, calls location.reload() to finish the update. The reload destroys the
// ring. So on the HAPPY PATH the confirmed row is written and then annihilated, ALWAYS, and the claim that "the
// absence of a console-build-check row after an applied console update is itself a fact" was simply false:
// absence was the GUARANTEED state after a successful apply, byte-identical to "the check never ran" and to "the
// pack came from a different tab".
//
// WHY THIS IS NOT A HOLE IN THE NO-SESSIONSTORAGE RULE. The rule protects against carrying an operator's evidence
// across a session boundary. What crosses here is not a session boundary: it is a reload THIS FLOW ITSELF
// TRIGGERED, seconds ago, in the same tab, for the same operator, as the last step of an update they asked for.
// And what crosses is not a record: it is ONE MEMBER OF ONE FROZEN CLOSED UNION, written by one call site,
// re-admitted on read by SET MEMBERSHIP against that union, and DELETED the instant it is drained. A value that
// is not a member of CLIENT_DIAG_BUILD_CHECK_CLASSES cannot survive the read, so there is no field here a
// customer value, a version string, a URL or a token could occupy. sessionStorage is per-tab and dies with the
// tab, so the second operator at a shared workstation inherits nothing.
//
// It carries the build-check class ONLY. It is not a general-purpose ring persister and must not become one: the
// moment it carries a second kind of thing, the rule it is an exception to stops meaning anything.

import { CLIENT_DIAG_BUILD_CHECK_CLASS_SET, type ClientDiagBuildCheckClass } from "./vocab.ts";
import { recordConsoleBuildCheck } from "./ring.ts";

// One fixed key. Not derived from anything: not from a route, not from a version, not from an operator.
const KEY = "dp.buildcheck.handoff";

// safeStorage returns sessionStorage or null. Reading `sessionStorage` THROWS outright in a browser with
// third-party storage blocked and in a sandboxed frame, and this is a diagnostics path: it must never be the
// thing that breaks an update the operator is in the middle of.
function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

// stashBuildCheck holds ONE closed class across the reload the caller is about to perform. Best-effort by
// design: if storage is unavailable the fact is lost, which is exactly the state we were already in, and no
// worse. It never throws.
export function stashBuildCheck(buildCheckClass: ClientDiagBuildCheckClass): void {
  const s = safeStorage();
  if (s === null) return;
  try {
    s.setItem(KEY, buildCheckClass);
  } catch {
    /* a full or refused quota must never break the update flow */
  }
}

// drainBuildCheckHandoff is called ONCE at boot, before anything else can record. It reads the stashed value,
// DELETES IT IMMEDIATELY (so a second pack from the same tab cannot double-count the same check, and a reload
// that is not ours cannot replay it), admits it only by SET MEMBERSHIP, and pushes it into the fresh ring.
//
// Anything that is not a frozen member is dropped and not recorded: it fails CLOSED, never coerced to the
// nearest member and never to a catch-all. So a hostile or corrupted storage entry cannot put a value in the
// pack, it can only fail to put a class in it.
export function drainBuildCheckHandoff(): void {
  const s = safeStorage();
  if (s === null) return;
  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
    s.removeItem(KEY);
  } catch {
    return;
  }
  if (raw === null || !CLIENT_DIAG_BUILD_CHECK_CLASS_SET.has(raw)) return;
  recordConsoleBuildCheck(raw as ClientDiagBuildCheckClass);
}
