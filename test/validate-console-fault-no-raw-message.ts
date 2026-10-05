// A throw the console's own code raises after a successful response (the "console-fault" ErrorKind,
// lib/errors.ts) can be either of two very different things, and blockError's console-fault branch
// (components/error-view.ts) must tell them apart rather than treat them alike:
//
//   a JS RUNTIME ACCIDENT (TypeError from a destructuring miss, ReferenceError, RangeError, ...): its
//   message is whatever the engine happened to put there (a property name, a variable's shape) and is
//   never written for an operator to read. This is what showed a raw
//   "(Cannot read properties of undefined (reading 'challenge'))" on a failed passkey sign-in.
//
//   a PLAIN Error a console module built ON PURPOSE to carry a real sentence (an engine refusal with no
//   trailing status, for example): refusedMessage (access-security/sessions-passkeys.ts) leans on this
//   console-fault fallback to keep the engine's own words in a 403-less refusal, and that sentence must
//   still reach the operator.
//
// classifyError's showMessage field is the discriminator (isBuiltinRuntimeError, checked by constructor,
// never by message shape): false for the four built-in error types, true for a plain Error.
// Run with: node test/validate-console-fault-no-raw-message.ts

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { blockError } from "../src/components/error-view.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean): void {
  checks += 1;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures += 1;
}

function detailFor(err: unknown): string {
  const card = blockError(err, () => {});
  return card.querySelector(".block-error__detail")?.textContent ?? "";
}

// The exact wording a failed passkey sign-in produced (and its siblings): a REAL destructuring TypeError,
// raised well after the engine answered, with no HTTP status, so classifyError's fall-through gives it
// "console-fault". A genuine property-access or reference accident is always one of these built-in TYPES,
// never a plain Error, which is why the fixtures below use the real constructors rather than `new
// Error(...)` with the same text.
const RUNTIME_ACCIDENTS: ReadonlyArray<{ name: string; err: Error }> = [
  { name: "TypeError from a destructuring miss", err: new TypeError("Cannot read properties of undefined (reading 'challenge')") },
  { name: "TypeError from a null property read", err: new TypeError("Cannot read properties of null (reading 'id')") },
  { name: "ReferenceError", err: new ReferenceError("x is not defined") },
  { name: "RangeError", err: new RangeError("Invalid array length") },
];

for (const { name, err } of RUNTIME_ACCIDENTS) {
  const detail = detailFor(err);
  ok(`${name}: the detail is not empty, so the assertion below grades something`, detail.length > 0);
  ok(`${name}: the detail does not repeat the raw exception text`, !detail.includes(err.message));
}

// THE OTHER HALF, and it is not optional: a plain Error some console module built on purpose to carry a
// real sentence (the exact shape refusedMessage's caller passes -- an engine refusal with no trailing
// status) must still reach the operator. A fix that suppressed every console-fault message, runtime
// accident or not, would pass the loop above and break this.
{
  const message = "owner-escalation guard: cannot act on an Owner";
  const detail = detailFor(new Error(message));
  ok("a plain Error carrying a deliberate sentence still shows it in the console-fault detail", detail.includes(message));
}

verdictReached(failures, checks);
console.log(`validate-console-fault-no-raw-message: ${checks} checks, ${failures} failures`);
if (failures > 0) {
  console.error(`validate-console-fault-no-raw-message: ${failures} FAILURES`);
  process.exit(1);
}
