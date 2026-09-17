#!/usr/bin/env node
// Custody-claim parity gate: pins the "Install your keys" card's custody tagline to what
// installKeysHandler actually submits and where it goes, so the claim and the code cannot silently
// diverge.
//
// THE FAILURE MODE THIS CLOSES. A custody tagline can claim the console submits nothing while its own
// handler (steps.ts installKeysHandler) POSTs signerPrivate, and in the operational posture
// operationalPrivate, in the body of the request its own Install button fires. Nothing else checks the
// claim against the code in one place, so the two can drift apart silently on the single highest-stakes
// screen in the product: the key ceremony.
//
// GROUNDED AT SOURCE. installKeys (client-keys.ts) sends the body over
// t.gatedFetch("/admin/keys/install", ...) -- a RELATIVE path off Transport.base -- and every real call
// site that builds a Transport does so via connect(location.origin, ...) (lib/store.ts): getEngine() ??
// connect(location.origin) (carousel-cards-connect-keys.ts), and the drift guard that reconnects on an
// origin mismatch (store.ts) uses the same location.origin. So the destination is always the console's OWN
// hosting origin, which for this product is the customer's in-account engine -- never a Maelstrom
// endpoint. The corrected wording states that directly: "The keys your engine needs install to your own
// engine, never to us. Your break-glass private key is not one of them."
//
// THREE CHECKS, PINNING BOTH DIRECTIONS OF DRIFT.
//   1. BANNED PHRASE: the "console submits nothing" claim family must never appear in the card deck or the
//      handler. Catches the exact regression: copy reverting to the false claim while the handler still
//      submits real key bytes. (Proven: reintroducing the banned phrase alone fails this gate.)
//   2. HANDLER PIN: the corrected tagline's "install to your own engine" half is grounded in
//      installKeysHandler literally still submitting the signer private in the same call. If that literal
//      submission is ever removed without the tagline being re-checked, this gate fails rather than let a
//      true-when-written claim quietly outlive the code (the failure mode posture-claims-gate.mjs exists to
//      close on a different pair of claims). (Proven: deleting the pinned literal alone fails this gate,
//      independent of check 1.)
//   3. SAME-ORIGIN PIN: the "never to us" half is grounded in the install call staying a relative path off
//      Transport.base (same-origin by construction, per the connect(location.origin) sites above), never
//      an absolute URL naming some other host.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blankComments } from "./source-text.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const TAGLINE_FILE = join(ROOT, "src/screens/onboarding/carousel-cards-configure-ready.ts");
const HANDLER_FILE = join(ROOT, "src/screens/onboarding/steps.ts");
const CLIENT_FILE = join(ROOT, "src/lib/api/client-keys.ts");

// Check 1: the banned claim family and close paraphrases of it.
const FALSE_CLAIM = /console\s+never\s+submits\s+a\s+secret/i;

// Check 2a: the exact corrected string this gate verifies against the handler. A DIFFERENT custody string
// on this card is not necessarily wrong, but it is UNVERIFIED by this gate -- update this constant
// alongside a deliberate, re-verified reword: read the handler and the transport before changing the
// claim, not after.
//
// The tagline avoids enumerating a posture-dependent list of keys, because installKeysHandler spreads the
// operational pair in conditionally (`...(result.operational ? {...} : {})`): a customer who chooses
// offline-key-only at the fork, the posture that leads the fork and the one the product recommends, has no
// operational key to install. A tagline naming "signer and operational keys" would tell that customer an
// operational key of theirs is about to be installed when none exists. Naming what installs without
// enumerating a posture-dependent list, and stating the negative that actually matters to custody, avoids
// that failure; check 3 below pins the negative.
const CORRECTED_CLAIM = 'custody: "The keys your engine needs install to your own engine, never to us. Your break-glass private key is not one of them.",';

// Check 2b: the literal that grounds "install to your own engine" -- installKeysHandler submitting the
// signer private, unconditionally, in the same POST the card's Install button fires.
const HANDLER_SUBMITS_SIGNER_PRIVATE = "signerPrivate: result.signer.privateB64";

// Check 3: the install call is a relative path off Transport.base (same-origin), never an absolute URL.
const RELATIVE_INSTALL_PATH = /gatedFetch\(\s*"\/admin\/keys\/install"/;
const ABSOLUTE_URL_NEAR_INSTALL = /https?:\/\/[^\s"'`]+\/admin\/keys\/install/;

function readClean(path) {
  return blankComments(readFileSync(path, "utf8"));
}

let failures = 0;
function fail(msg) {
  console.error(`FAIL custody-claim-parity: ${msg}`);
  failures++;
}

const tagline = readClean(TAGLINE_FILE);
const handler = readClean(HANDLER_FILE);
const client = readClean(CLIENT_FILE);

if (FALSE_CLAIM.test(tagline)) fail(`${TAGLINE_FILE} asserts the console submits nothing (R-83's original wording), while the handler it describes submits real key bytes.`);
if (FALSE_CLAIM.test(handler)) fail(`${HANDLER_FILE} asserts the console submits nothing.`);

if (!tagline.includes(CORRECTED_CLAIM)) {
  fail(
    `the "install" card's custody tagline in ${TAGLINE_FILE} no longer matches the wording this gate verifies against the handler.\n` +
      "    If this is a deliberate, true reword, update CORRECTED_CLAIM in this gate to match, having re-verified the\n" +
      "    claim at source (steps.ts installKeysHandler + client-keys.ts installKeys) the way R-83 itself was closed.",
  );
}

if (!handler.includes(HANDLER_SUBMITS_SIGNER_PRIVATE)) {
  fail(
    `${HANDLER_FILE} no longer submits the signer private (expected literal: ${HANDLER_SUBMITS_SIGNER_PRIVATE}).\n` +
      '    The "install" card\'s tagline claims keys install to your own engine; if the handler stopped submitting\n' +
      "    them, that claim needs re-checking against the code before this gate can pass again.",
  );
}

if (!RELATIVE_INSTALL_PATH.test(client)) {
  fail(`${CLIENT_FILE} no longer posts the key install to a relative "/admin/keys/install" path off Transport.base.`);
}
if (ABSOLUTE_URL_NEAR_INSTALL.test(client)) {
  fail(`${CLIENT_FILE} appears to post the key install to an absolute URL, which would no longer be same-origin.`);
}

if (failures > 0) {
  console.error(`\ncustody-claim-parity: ${failures} finding(s).`);
  process.exit(1);
}
console.log("ok   custody-claim-parity: the install card's custody tagline matches installKeysHandler's actual submission, and the install call stays same-origin.");
