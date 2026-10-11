// Validate that splitFormatLines (the custody format text inside src/lib/custody.ts splitReadme) keeps its
// lines. A low-weight pin: this is the "Share format" section of RECOVER-SPLIT.txt, the
// text an operator relies on to reconstruct an M-of-N split WITHOUT the console (a compatible tool reads
// this instead). It states the field labels and the byte counts straight from the constants the ceremony
// itself uses, so a dropped or reordered line silently breaks that offline recovery path.
//
// Run with `node test/validate-split-format-lines.ts`.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { splitReadme } from "../src/lib/custody.ts";
import { ENVELOPE_FILE_MAGIC, SHARE_FILE_MAGIC } from "../src/lib/custody-files.ts";
import { GCM_IV_BYTES, GCM_TAG_BYTES } from "../src/lib/envelope.ts";
import { SECRET_BYTES, SHARE_BYTES, WRAPPING_KEY_CHECKSUM_BYTES, WRAPPING_KEY_CHECKSUM_DOMAIN } from "../src/lib/shamir.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const FIELD_LABELS = ["Lines:", "Field:", "Secret:", "x values:", "Share file:", "Recombine:", "Checksum:", "Ciphertext:"];

function main(): void {
  console.log("\n-- the Share format section of RECOVER-SPLIT.txt keeps every field line --");
  {
    const readme = splitReadme(5, 3);
    ok('the heading line is present', readme.includes("Share format (to recover without the console):"));
    for (const label of FIELD_LABELS) {
      ok(`field line "${label}" is present`, readme.includes(label));
    }
    ok("it names the version magics", readme.includes(SHARE_FILE_MAGIC) && readme.includes(ENVELOPE_FILE_MAGIC));
    ok("it names the secret and share byte counts", readme.includes(`${SECRET_BYTES}-byte`) && readme.includes(`${SHARE_BYTES} bytes`));
    ok("it names the checksum byte count and domain", readme.includes(`${WRAPPING_KEY_CHECKSUM_BYTES} bytes`) && readme.includes(WRAPPING_KEY_CHECKSUM_DOMAIN));
    ok("it names the GCM IV and tag byte counts", readme.includes(`${GCM_IV_BYTES}-byte IV`) && readme.includes(`${GCM_TAG_BYTES} bytes`));
    // The format section sits between the numbered recovery steps and the closing no-custody line, as one
    // contiguous block: the heading through the Ciphertext line, in order.
    const headIdx = readme.indexOf("Share format (to recover without the console):");
    let cursor = headIdx;
    for (const label of FIELD_LABELS) {
      const idx = readme.indexOf(label, cursor);
      ok(`field line "${label}" keeps its order in the block`, idx > cursor);
      cursor = idx;
    }
  }

  console.log("\n-- CONTROL: a threshold/total change updates the values the format section quotes --");
  {
    const readme = splitReadme(3, 2);
    ok("x values line reflects the new total", readme.includes("1 to 3."));
    ok("Secret line reflects the new threshold's polynomial degree", readme.includes("degree 1,"));
  }

  verdictReached(failures);
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
