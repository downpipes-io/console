#!/usr/bin/env node
// Every place that asks for identity.key must also accept a quorum.
//
// WHY THIS EXISTS. Split custody is an internal-controls arrangement: an organisation that wants M-of-N
// sign-off before anyone can open an archive holds the break-glass key as Shamir shares rather than as one
// file. A screen that offers only a file picker does not merely inconvenience them, it locks them out of
// whatever that screen does, because the thing they hold is not identity.key and the only way to make one
// is `downpipe recombine`, which writes the complete break-glass key to somebody's disk and leaves it there.
// That is the arrangement the split exists to avoid.
//
// A file-only entry point is easy to introduce on either side of the split without noticing: the Go
// reader's unseal-export can declare its own --identity flag with no quorum route, on the
// total-account-loss command, and a console screen can mount a form whose own copy promises a quorum route
// ("resuming needs a quorum of shares again") while the form itself stays file-only, so the promise is made
// and the control cannot keep it.
//
// THE COUNTING RULE, and it is counting rather than presence for a specific reason. A per-file "does this
// file mount the card at all" check passes even when a second identity file input is added beside a first
// one that already had the card: attend.ts can mount one card for its setup form while holding two identity
// file inputs. So the property is that a file mounts at least as many reassembly cards as it has identity
// file inputs. Two ways in, two ways in.
//
// It is not a proof that each card sits beside its own input, which would need a render. It is the check
// that catches the shape both regressions above took: a second entry point added next to a first that
// already had the card.
//
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = join(ROOT, "src");

// An identity.key file picker, in the one shape this repo writes them.
const IDENTITY_INPUT = /accept:\s*"\.key/g;
// A mounted card. The import names it too, so the open paren is what distinguishes a call from a mention.
const CARD_MOUNT = /renderReassemblyCard\(/g;

// The card's own module names both, being the thing that reads the artefacts.
const EXEMPT = new Set(["src/screens/restore-flow/reassembly.ts"]);

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const scanned = files(SCAN);
// A gate that scans nothing reads exactly like a passing gate.
if (scanned.length < 100) {
  console.error(`FAIL split-custody-parity: expected this repo's source, found only ${scanned.length} files. Has the layout moved?`);
  process.exit(1);
}

const offenders = [];
let inputsSeen = 0;
let cardsSeen = 0;
for (const p of scanned) {
  const rel = relative(ROOT, p);
  if (EXEMPT.has(rel)) continue;
  const body = readFileSync(p, "utf8");
  const inputs = (body.match(IDENTITY_INPUT) ?? []).length;
  const cards = (body.match(CARD_MOUNT) ?? []).length;
  inputsSeen += inputs;
  cardsSeen += cards;
  if (inputs > cards) offenders.push({ rel, inputs, cards });
}

// The other way a counting gate lies: counting zero of the thing it counts. If no screen asks for an
// identity any more, the comparison above is vacuously true everywhere and this would report success.
if (inputsSeen === 0) {
  console.error(
    "FAIL split-custody-parity: no identity.key file input was found anywhere in src.\n" +
      "  Either the pattern this gate matches has changed, or the screens stopped accepting a break-glass\n" +
      "  key. Both mean this gate is no longer checking what it claims to check.",
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error("FAIL split-custody-parity: a screen asks for identity.key without offering the quorum route.\n");
  for (const o of offenders) {
    console.error(`  ${o.rel}: ${o.inputs} identity file input(s), ${o.cards} reassembly card(s) mounted`);
  }
  console.error(
    "\nMount renderReassemblyCard (showDownload: false) beside the file input, as break-glass.ts, attend.ts\n" +
      "and keys/custody.ts do. A file-only entry point locks out every customer holding the key as M-of-N\n" +
      "shares, because what they hold is not identity.key and making one means writing the complete\n" +
      "break-glass key to disk. Counting rather than presence is deliberate: attend.ts already mounted one\n" +
      "card while holding two file inputs, and that is exactly the regression this catches.",
  );
  process.exit(1);
}

console.log(`ok   split-custody-parity: ${inputsSeen} identity input(s) across ${scanned.length} files, all matched by ${cardsSeen} quorum route(s)`);
