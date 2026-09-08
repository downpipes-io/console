// Modal area of the validate-components suite: the modal action error-surfacing
// contract.

import {
  _actionErrorMessage,
  _testRunNonBusyAction,
  _testRunBusyAction,
  type BusyButtonState,
} from "../src/components/modal.ts";

type Ok = (label: string, cond: boolean) => void;

export async function runModalDrawer(ok: Ok): Promise<void> {

// ===========================================================================
// 6. MODAL -- ACTION ERROR SURFACING
// ===========================================================================
// When a non-busy action's onClick rejects, the error must be surfaced to the
// operator (via toast in production) and the modal must stay open. The two
// testable properties are:
//   a. _actionErrorMessage extracts a human-readable string from any thrown value.
//   b. _testRunNonBusyAction calls notifyError on rejection and returns false;
//      on success it returns true and does NOT call notifyError.
//
// Negative controls confirm the error is NOT swallowed: notifyError must fire on rejection.

console.log("\n-- modal action error surfacing --");

// 6a. _actionErrorMessage: Error instance uses .message.
ok("errorMessage: Error instance yields .message", _actionErrorMessage(new Error("something broke")) === "something broke");
ok("errorMessage: Error with empty message yields ''", _actionErrorMessage(new Error("")) === "");

// 6b. _actionErrorMessage: non-Error values are stringified.
ok("errorMessage: string value passthrough", _actionErrorMessage("network timeout") === "network timeout");
ok("errorMessage: number value stringified", _actionErrorMessage(503) === "503");
ok("errorMessage: null stringified", _actionErrorMessage(null) === "null");
ok("errorMessage: undefined stringified", _actionErrorMessage(undefined) === "undefined");
// Negative controls.
ok("errorMessage: Error result is NOT the whole Error object string", !_actionErrorMessage(new Error("x")).startsWith("Error:"));
ok("errorMessage: number result is NOT empty string", _actionErrorMessage(404) !== "");

// 6c. _testRunNonBusyAction: a rejected onClick is NOT swallowed; notifyError is called.
{
  let surfaced: string | null = null;
  const result = await _testRunNonBusyAction(
    async () => { throw new Error("engine unreachable"); },
    (msg) => { surfaced = msg; },
  );
  ok("rejected non-busy action returns false (modal stays open)", result === false);
  ok("rejected non-busy action calls notifyError (not swallowed)", surfaced !== null);
  ok("surfaced message matches the thrown Error.message", surfaced === "engine unreachable");
  // Negative control: if the error were swallowed, surfaced would still be null.
  ok("negative: surfaced is NOT null (error was not swallowed)", surfaced !== null);
}

// 6d. _testRunNonBusyAction: a non-Error rejection (bare string) is surfaced.
{
  let surfaced: string | null = null;
  await _testRunNonBusyAction(
    async () => { throw "forbidden"; },
    (msg) => { surfaced = msg; },
  );
  ok("bare-string rejection surfaced correctly", surfaced === "forbidden");
}

// 6e. _testRunNonBusyAction: a resolving onClick does NOT call notifyError.
{
  let surfaced: string | null = null;
  const result = await _testRunNonBusyAction(
    async () => { /* success */ },
    (msg) => { surfaced = msg; },
  );
  ok("non-busy success: result is true (modal would close)", result === true);
  ok("non-busy success: notifyError NOT called on success", surfaced === null);
  // Negative control: a spurious error call on success would make surfaced non-null.
  ok("non-busy success negative: surfaced remains null", surfaced === null);
}

// 6f. _testRunNonBusyAction: return false (keep-open signal) does NOT call notifyError.
{
  let surfaced: string | null = null;
  const result = await _testRunNonBusyAction(
    async () => false,
    (msg) => { surfaced = msg; },
  );
  // The test helper resolves (not throws) so it returns true; the keep-open logic
  // is enforced in runAction (which checks result === false) not in the error path.
  ok("non-busy false-return: notifyError NOT called (false is not a rejection)", surfaced === null);
  ok("non-busy false-return: result is true from helper (onClick resolved, did not throw)", result === true);
}

// 6g. BUSY path: the spinner branch must, on a
// rejection, restore the busy flag, the original label and the disabled state and
// surface the error (modal stays open); on a successful (non-false) result it must
// signal a close; a `false` result keeps the modal open with the control restored.
console.log("\n-- modal busy-path control recovery --");

function freshBusyBtn(): BusyButtonState {
  return { busy: "false", textContent: "Delete", disabled: false };
}

// 6g-i. busy rejection: control restored + error surfaced + NOT closed.
{
  const btn = freshBusyBtn();
  let surfaced: string | null = null;
  const r = await _testRunBusyAction(btn, "Deleting", async () => { throw new Error("engine unreachable"); }, (m) => { surfaced = m; });
  ok("busy reject: modal does not close", r.closed === false);
  ok("busy reject: errored flag set", r.errored === true);
  ok("busy reject: busy flag restored to false", btn.busy === "false");
  ok("busy reject: label reverted to the original", btn.textContent === "Delete");
  ok("busy reject: button re-enabled", btn.disabled === false);
  ok("busy reject: error surfaced (not swallowed)", surfaced === "engine unreachable");
  // Negative control: a swallowed error would leave surfaced null and closed true.
  ok("busy reject negative: did NOT close on error", r.closed !== true);
}

// 6g-ii. busy success (non-false result): the modal should close.
{
  const btn = freshBusyBtn();
  let surfaced: string | null = null;
  const r = await _testRunBusyAction(btn, "Deleting", async () => { /* resolves */ }, (m) => { surfaced = m; });
  ok("busy success: modal closes", r.closed === true);
  ok("busy success: not errored", r.errored === false);
  ok("busy success: notifyError NOT called", surfaced === null);
}

// 6g-iii. busy false-return (keep-open): control restored, modal stays open, no error.
{
  const btn = freshBusyBtn();
  let surfaced: string | null = null;
  const r = await _testRunBusyAction(btn, "Deleting", async () => false, (m) => { surfaced = m; });
  ok("busy false-return: modal stays open", r.closed === false);
  ok("busy false-return: not errored", r.errored === false);
  ok("busy false-return: busy flag restored", btn.busy === "false");
  ok("busy false-return: label reverted", btn.textContent === "Delete");
  ok("busy false-return: button re-enabled", btn.disabled === false);
  ok("busy false-return: notifyError NOT called", surfaced === null);
}


}
