// Validate that overwriteNote (src/screens/restore-flow/plan.ts) escapes HTML in a record name.
// The dry run's overwrite check names up to 20 live KV keys or R2 objects an apply would
// replace (RestoreOverwriteCheck.existingSample), and these names come from the archive, not from a
// fixed vocabulary, so a hostile-shaped record name must render as literal text, never as markup.
//
// Run with `node test/validate-overwrite-note-escaping.ts`.

import { installDomShim, qs, qsa, textOf } from "./dom-shim.ts";

installDomShim();

import { overwriteNote } from "../src/screens/restore-flow/plan.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const HOSTILE = "<img src=x onerror=alert(1)>";

function main(): void {
  console.log("\n-- a hostile record name in the overwrite check renders as text, never as markup --");
  {
    const note = overwriteNote({ checked: 2, existing: 1, absent: 1, unknown: 0, existingSample: [HOSTILE] }, false);
    document.body.appendChild(note);
    ok("no img element was parsed from the name", qsa(note, "img").length === 0);
    const item = qs(note, ".skipped-list li");
    ok("the list item is present", item !== null);
    ok("the raw string is preserved as literal text in the item", item !== null && textOf(item).includes(HOSTILE));
    note.remove();
  }

  console.log("\n-- CONTROL: an ordinary record name renders unchanged --");
  {
    const note = overwriteNote({ checked: 1, existing: 1, absent: 0, unknown: 0, existingSample: ["kv:config:settings"] }, false);
    document.body.appendChild(note);
    ok("the ordinary name reads back unchanged", textOf(note).includes("kv:config:settings"));
    note.remove();
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
