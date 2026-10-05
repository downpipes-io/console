// The update-signer fingerprint and the declared release-signer pin, driven through the REAL
// renderProvenanceBody, for every state the engine's GET /admin/status can report:
//   - the update channel not configured (no verifying key to name: the fingerprint row is omitted)
//   - configured, fingerprint absent (an unset or malformed UPDATE_SIGNER_PUBLIC, or an uncomputed read)
//   - configured, declared pin matches the fingerprint
//   - configured, declared pin does not match (the engine's own warning renders verbatim, with where to
//     set the correction)
//
// The declared pin is relabelled "Declared release-signer pin" (it is the operator's typed value, never
// the verifying key); "Update-signer fingerprint" is the new row naming the key this engine actually
// verifies updates with.
//
// Run with: node test/validate-provenance-signer-fields.ts

import { installDomShim, markConnected, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { renderProvenanceBody } = await import("../src/screens/licence/provenance.ts");

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const FINGERPRINT = `edmldsa1:${"a".repeat(96)}`;
const DECLARED_WRONG = `edmldsa1:${"b".repeat(96)}`;
const WARNING = `RELEASE_SIGNER_PIN is only a label. The engine verifies updates with key ${FINGERPRINT}. Set RELEASE_SIGNER_PIN to that value, or clear it.`;

// render builds the minimum LicenceData the block reads and returns the rendered text.
function render(updatesExtra: Record<string, unknown>, statusExtra: Record<string, unknown>): string {
  const data = {
    licence: { tier: "community", valid: true },
    updates: { configured: false, verified: false, currentVersion: "v1.0.0", ...updatesExtra },
    status: { engineVersion: "0.1.9", ...statusExtra },
    updateState: null,
  };
  const el = renderProvenanceBody(data as never);
  markConnected(el as unknown as never);
  return textOf(el as unknown as never);
}

console.log("(1) update channel not configured: no verifying key to name, the fingerprint row is omitted");
{
  const text = render({ configured: false }, { updateSignerFingerprint: FINGERPRINT });
  ok("(1a) no 'Update-signer fingerprint' label when the channel is not configured", !text.includes("Update-signer fingerprint"));
  ok("(1b) the scheme note says the channel is not configured", text.includes("update channel not configured"));
}

console.log("\n(2) channel configured, fingerprint ABSENT: honest not-reported, in the engine's terms");
{
  const text = render({ configured: true, verified: false }, {});
  ok("(2a) the fingerprint row renders", text.includes("Update-signer fingerprint"));
  ok("(2b) it says UPDATE_SIGNER_PUBLIC is unset or malformed", text.includes("UPDATE_SIGNER_PUBLIC is unset or malformed"));
  ok("(2c) it does not fabricate a fingerprint value", !text.includes("edmldsa1:"));
}

console.log("\n(3) channel configured, fingerprint present, no declared pin: the key renders, no verdict");
{
  const text = render({ configured: true, verified: true }, { updateSignerFingerprint: FINGERPRINT });
  ok("(3a) the fingerprint renders", text.includes(FINGERPRINT));
  ok("(3b) it is named as the verifying key", text.includes("This is the key this engine verifies updates with."));
  ok("(3c) no 'Declared release-signer pin' row (nothing declared)", !text.includes("Declared release-signer pin"));
  ok("(3d) no match/mismatch verdict shown", !text.includes("Matches the verifying key") && !text.includes("RELEASE_SIGNER_PIN is only a label"));
}

console.log("\n(4) declared pin MATCHES the fingerprint: a quiet pass note, relabelled row");
{
  const text = render(
    { configured: true, verified: true },
    { updateSignerFingerprint: FINGERPRINT, releaseSignerPin: FINGERPRINT, releaseSignerPinDeclared: true, releaseSignerPinMatches: true },
  );
  ok("(4a) the row is relabelled 'Declared release-signer pin', not 'Release-signer pin'", text.includes("Declared release-signer pin"));
  ok("(4b) the declared value renders", text.includes(FINGERPRINT));
  ok("(4c) a quiet 'Matches the verifying key.' note renders", text.includes("Matches the verifying key."));
  ok("(4d) no amber warning renders on a match", !text.includes("is only a label"));
}

console.log("\n(5) declared pin does NOT match: the engine's own warning renders verbatim");
{
  const text = render(
    { configured: true, verified: true },
    { updateSignerFingerprint: FINGERPRINT, releaseSignerPin: DECLARED_WRONG, releaseSignerPinDeclared: true, releaseSignerPinMatches: false, releaseSignerPinWarning: WARNING },
  );
  ok("(5a) the declared (wrong) value still renders, as typed", text.includes(DECLARED_WRONG));
  ok("(5b) the engine's warning sentence renders verbatim", text.includes(WARNING));
  ok("(5c) the real fingerprint is named in the warning, so the operator can act on it", text.includes(FINGERPRINT));
  ok("(5d) the console adds nothing to the engine's warning", !text.includes(`${WARNING} `) && !text.includes("wrangler.toml"));
  ok("(5e) no quiet pass note on a mismatch", !text.includes("Matches the verifying key."));
}

console.log("\n(6) NEGATIVE CONTROL: releaseSignerPinMatches undefined carries no verdict");
{
  const text = render({ configured: true, verified: true }, { updateSignerFingerprint: FINGERPRINT, releaseSignerPin: FINGERPRINT });
  ok("(6a) the declared value still renders", text.includes(FINGERPRINT));
  ok("(6b) no match note and no mismatch warning when the engine sent no verdict", !text.includes("Matches the verifying key.") && !text.includes("is only a label"));
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} -- provenance signer fields (${checks} checks)`);
verdictReached(failures, checks); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exitCode = 1;
