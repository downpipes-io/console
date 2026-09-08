// Validate the key-posture acceptance statements the console shows at the onboarding fork and the
// Keys-screen posture actions. The load-bearing property: the console's statement text hashes to the
// SAME pinned SHA-384 the engine records into the tamper-evident audit log, so what the customer READ
// is provably what the engine RECORDED. The engine has its own validator asserting its copy hashes to
// the identical POSTURE_ACK_CANONICAL_HASH values, so a one-sided edit fails a gate on both sides.
//
// Run with `node test/validate-posture-ack.ts`.

import {
  POSTURE_ACK_STATEMENTS,
  POSTURE_ACK_CANONICAL_HASH,
  postureAckStatementHash,
  type PostureChoice,
} from "../src/lib/posture-ack-statements.ts";

let failures = 0;
// only on failure. The completion guard's non-vacuity floor is a count of assertion-shaped lines, and a
// validator that is deliberately quiet has to declare its own count instead of being guessed at from output.
function ok(label: string, cond: boolean): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

// The CURRENT version per posture. They are no longer the same: the offline statement went to v2 on
// when a clause about in-console restore turned out to be stale, and the operational statement
// was accurate and stayed at v1. Pinned per posture rather than asserted as one shared string, so a bump on
// either side is a deliberate edit here rather than something a loosened check would let through.
const CURRENT_VERSION: Record<PostureChoice, string> = {
  operational: "key-posture-ack/v1",
  "break-glass-only": "key-posture-ack/v2",
};

async function main(): Promise<void> {
  const postures: PostureChoice[] = ["operational", "break-glass-only"];

  for (const posture of postures) {
    const stmt = POSTURE_ACK_STATEMENTS[posture];
    ok(`${posture} statement has its pinned version`, stmt.version === CURRENT_VERSION[posture]);
    // The cross-repo contract: the console text hashes to the pinned canonical value (the same value
    // the engine validator pins). If this fails, the console text has drifted from the engine copy.
    const hash = await postureAckStatementHash(stmt.text);
    ok(`${posture} statement hashes to the pinned canonical value`, hash === POSTURE_ACK_CANONICAL_HASH[posture]);
  }

  // The statements RESTATE the specific residual inline (never a generic "I have read the implications"),
  // which is the whole point of recording them as liability evidence. Assert the load-bearing phrases are
  // present so a future edit cannot quietly soften them below the disclosure bar.
  const op = POSTURE_ACK_STATEMENTS.operational.text;
  ok("operational statement names the decryption-capable key in the customer's own account", op.includes("in my own Cloudflare account") && op.includes("decrypt my stored archives"));
  ok("operational statement names the compromise + malicious-update residual", op.includes("Cloudflare account is compromised") && op.includes("malicious platform update"));
  ok("operational statement does NOT call the key a Secrets Store binding (it is a Worker secret)", !op.toLowerCase().includes("secrets store"));

  const bg = POSTURE_ACK_STATEMENTS["break-glass-only"].text;
  ok("offline statement states nothing in the engine can decrypt", bg.includes("no key that can decrypt my stored archives"));
  ok("offline statement names the manual-proof responsibility and key-loss consequence", bg.includes("attended verification") && bg.includes("cannot be recovered"));

  console.log(failures === 0 ? "\nPOSTURE-ACK VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
