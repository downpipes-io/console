// Validate that the localStorage copy of the setup draft (SETUP_FIRST_BACKUP_KEY,
// "downpipes.setup.first-backup") is removed when the session ends.
//
// src/lib/store.ts clearSessionData() runs on explicit sign-out and on a server-initiated end of session
// (idle or absolute expiry, an admin's terminate), and it removes this key alongside the other session
// data. Left behind, it would let a later caller in the same browser profile resume a prior operator's
// in-progress setup answers.
//
// Run with `node test/validate-setup-draft-session-end.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { clearSessionData, connect } from "../src/lib/store.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const KEY = "downpipes.setup.first-backup";

function main(): void {
  const store = (globalThis as unknown as { localStorage: Storage }).localStorage;

  console.log("\n-- clearSessionData removes the setup draft's localStorage copy --");
  connect("https://engine.example.com");
  store.setItem(KEY, JSON.stringify({ bucket: "archive", createdDownpipeIds: ["dp-1"] }));
  ok("the copy is present before the session ends", store.getItem(KEY) !== null);
  clearSessionData();
  ok("the copy is gone once the session is cleared", store.getItem(KEY) === null);

  console.log("\n-- CONTROL: clearSessionData is idempotent with no copy present --");
  store.removeItem(KEY);
  clearSessionData();
  ok("no copy, no throw, still absent", store.getItem(KEY) === null);

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
