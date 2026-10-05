#!/usr/bin/env node
// Custody-claim parity gate: pins the setup surface's custody lines (what reaches the engine at Apply) to what
// the key install actually submits and where it goes, so the claim and the code cannot silently diverge.
//
// THE FAILURE MODE THIS CLOSES. A custody line can claim the console submits nothing, or that the engine gets
// only public keys, while the install body (lib/setup-flow/install.ts installCeremonyKeys) POSTs the signer
// private, the configuration recovery private and wrap key, and in the operational posture the operational
// private. Nothing else checks the claim against the code in one place, so the two can drift apart silently on
// the single highest-stakes screen in the product: the key ceremony. (The first-run deck's "Install your keys"
// card carried the older version of this claim; the deck is retired and the claim moved with the ceremony to
// the setup surface's Custody and Generate questions, screens/setup/b/q-keys.ts.)
//
// GROUNDED AT SOURCE. installKeys (client-keys.ts) sends the body over
// t.gatedFetch("/admin/keys/install", ...) -- a RELATIVE path off Transport.base -- and every real call
// site that builds a Transport does so via connect(location.origin, ...) (lib/store.ts restoreConnection and
// lib/setup-flow/engine-probe.ts). So the destination is always the console's OWN hosting origin, which for
// this product is the customer's in-account engine -- never a Maelstrom endpoint.
//
// FOUR CHECKS, PINNING BOTH DIRECTIONS OF DRIFT.
//   1. BANNED PHRASES: the "console submits nothing" claim family, and "only the signing key and the public
//      keys" (true only while the install sent no configuration private), must never appear in the claim file
//      or the install module.
//   2. THE CLAIMS: both posture lines appear in the claim file verbatim, so a reword is re-verified here.
//   3. THE BODY PIN: the install still submits the signer private and the configuration keys (what the lines
//      say the engine gets), and never the break-glass private (what they say never leaves). Removing a
//      submitted literal, or adding the break-glass private, fails this gate on its own.
//   4. SAME-ORIGIN PIN: the install call stays a relative path off Transport.base, never an absolute URL.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blankComments } from "./source-text.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CLAIM_FILE = join(ROOT, "src/screens/setup/b/q-keys.ts");
const HANDLER_FILE = join(ROOT, "src/lib/setup-flow/install.ts");
const CLIENT_FILE = join(ROOT, "src/lib/api/client-keys.ts");

// Check 1: the banned claim family and close paraphrases of it.
const FALSE_CLAIMS = [/console\s+never\s+submits\s+a\s+secret/i, /only\s+the\s+signing\s+key\s+and\s+the\s+public\s+keys/i];

// Check 2: the exact lines this gate verifies against the install body. A DIFFERENT custody line is not
// necessarily wrong, but it is UNVERIFIED by this gate: update these alongside a deliberate, re-verified reword.
const CLAIMS = [
  'export const KEYS_TRUST_OFFLINE = "identity.key never leaves this device. At Apply, your engine gets the signing key, the configuration keys and the public keys.";',
  'export const KEYS_TRUST_OPERATIONAL = "identity.key never leaves this device. At Apply, your engine gets the signing key, the configuration keys, the public keys and the operational key, which can decrypt backups.";',
];

// Check 3: the literals that ground the lines.
const SUBMITTED = ["signerPrivate: result.signer.privateB64", "breakGlassPublic: result.breakGlass.recipientPublicB64", "configRecipientPrivate: result.configRecipient.identityB64", "configWrapKey: result.configWrapKeyB64"];
const NEVER_SUBMITTED = /breakGlass\.identityB64/;

// Check 4: the install call is a relative path off Transport.base (same-origin), never an absolute URL.
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

const claims = readFileSync(CLAIM_FILE, "utf8");
const claimsClean = blankComments(claims);
const handler = readClean(HANDLER_FILE);
const client = readClean(CLIENT_FILE);

for (const re of FALSE_CLAIMS) {
  if (re.test(claimsClean)) fail(`${CLAIM_FILE} makes a custody claim the install body contradicts (${re}).`);
  if (re.test(handler)) fail(`${HANDLER_FILE} makes a custody claim the install body contradicts (${re}).`);
}

for (const line of CLAIMS) {
  if (!claims.includes(line)) {
    fail(
      `${CLAIM_FILE} no longer carries the custody line this gate verifies against the install body:\n      ${line}\n` +
        "    If this is a deliberate, true reword, update CLAIMS in this gate to match, having re-verified the claim at\n" +
        "    source (lib/setup-flow/install.ts installCeremonyKeys + client-keys.ts installKeys).",
    );
  }
}

for (const lit of SUBMITTED) {
  if (!handler.includes(lit)) {
    fail(`${HANDLER_FILE} no longer submits ${lit.split(":")[0]} (expected literal: ${lit}). The custody lines say the engine gets it; re-check them before this gate can pass again.`);
  }
}
if (NEVER_SUBMITTED.test(handler)) fail(`${HANDLER_FILE} reads the break-glass private (breakGlass.identityB64). The custody lines say identity.key never leaves this device.`);

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
console.log("ok   custody-claim-parity: the setup surface's custody lines match what the key install submits, and the install call stays same-origin.");
