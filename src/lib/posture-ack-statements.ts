// The console mirror of the engine's frozen key-posture acceptance statements
// (engine/src/admin/posture-ack-statements.ts). These are the EXACT words shown to the customer at
// the onboarding fork and the Keys-screen posture actions, and they MUST be byte-identical to the
// engine's copy: the engine recomputes the SHA-384 over ITS canonical text and records that hash in
// the tamper-evident audit log, so if the console displayed different words than the engine hashed,
// the "what the customer read is what the engine recorded" binding would be broken. The parity gate
// (test/validate-posture-ack.ts) asserts each statement here hashes to the pinned CANONICAL hash,
// which is the SAME value the engine's own validator pins, so a one-sided edit fails a gate on both
// sides. House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { sha384Hex } from "../bytes.ts";

// PostureChoice is the two recovery postures a customer can acknowledge, mirroring the engine union.
export type PostureChoice = "operational" | "break-glass-only";

// PostureAckStatement is a versioned acceptance text; the version is bumped on any wording change.
export interface PostureAckStatement {
  version: string;
  text: string;
}

// POSTURE_ACK_STATEMENTS mirrors engine/src/admin/posture-ack-statements.ts VERBATIM. Each statement
// restates the specific residual inline so the recorded acknowledgement proves the exact risk was put
// in front of the customer at the moment they confirmed.
export const POSTURE_ACK_STATEMENTS: Record<PostureChoice, PostureAckStatement> = {
  operational: {
    version: "key-posture-ack/v1",
    text: "I am enabling an operational key. It is stored as a secret in my own engine, in my own Cloudflare account, and it can decrypt my stored archives. I understand that if my Cloudflare account is compromised, or a malicious platform update runs in my engine, my stored archives could be read. I understand that removing this key later does not protect archives already sealed while it was present, because each archive is wrapped to the keys in force when it was written. I am accepting this so my engine can reopen and restore-test runs it sealed earlier without me present.",
  },
  "break-glass-only": {
    version: "key-posture-ack/v2",
    text: "I am choosing an offline key only. My engine will hold no key that can decrypt my stored archives. It will still verify each run as it seals it, and prove its own test data recoverable every hour, but it cannot reopen a run it sealed earlier without me. Scheduled restore tests and retention pruning therefore do not run in my engine, and I am responsible for pruning my own archives with the offline reader, supplying my break-glass key at the time. Restoring from the console still works with me present, supplying my break-glass key in my browser, and I am also responsible for proving past runs restorable at an attended verification. If I lose that key my backups cannot be recovered.",
  },
};

// POSTURE_ACK_CANONICAL_HASH pins the "sha384:"-prefixed hex SHA-384 of each statement's exact text.
// These values are the SINGLE cross-repo contract: the engine's validator asserts its own copy hashes
// to these, and the console's validator asserts the copy above does too, so the two texts cannot drift
// apart without failing a gate. Regenerate ONLY when deliberately versioning a statement (bump the
// version id at the same time; never edit v1's text in place).
export const POSTURE_ACK_CANONICAL_HASH: Record<PostureChoice, string> = {
  operational: "sha384:cfe21b0797d478c437e7ffec790976ab2fd6301490793bb3d24e066802a81cf826807860323c63fe5ebeaeb058df98d7",
  "break-glass-only": "sha384:f006296ef4145c1ee54571194946c1ca5e755dee74b72a82d31036bb767cd381fd9ca34debe789cd89999c96f9c22e6b",
};

// postureAckStatementHash returns the "sha384:"-prefixed hex SHA-384 of a statement's text, the value
// the parity gate compares against POSTURE_ACK_CANONICAL_HASH and the value the engine records.
export async function postureAckStatementHash(text: string): Promise<string> {
  return `sha384:${await sha384Hex(new TextEncoder().encode(text))}`;
}
