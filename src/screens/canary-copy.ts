// CANARY_COPY: the user-facing copy for the Canary screen. The vivid canary / coalmine metaphor is
// the headline framing; every substantive line stays precise and honest about exactly what is (or
// would be) proven. Kept as a sibling constant so the screen module stays under the structural
// threshold while the copy stays a single source of truth.

import type { CanaryLiveness } from "../api.ts";

export const CANARY_COPY = {
  intro:
    "A canary is a small piece of known data the engine sends down the pipe on a schedule, a synthetic backup whose every byte is known in advance. While it returns intact, the whole write, seal, read, restore and verify path is proven byte for byte. If a single bit strays, or any check along that path does not verify, the canary is dead and you stop trusting that destination for real restores until it is investigated.",
  states: {
    alive: { label: "Alive, singing", line: "Last flight: every byte returned exactly as sent. The full write, seal, read, restore and verify path is sound for this destination." },
    // THE LINE SAYS WHAT HAPPENED, NOT WHY. It used to open "A byte strayed on the last flight", which is
    // the single most specific and most alarming thing this screen can say and it is true of only some
    // deaths. A flight also dies when the RUNLOG entry does not verify fresh and chained, when a record
    // fails to decrypt, when the restore-write itself fails, and when a read-back fails verification for a
    // reason the engine could not classify (the fail-closed catch, which exists precisely because the cause
    // is unknown). Naming corruption for all of those is the same defect the deadReason fallback carried,
    // wearing the screen's metaphor. The metaphor stays in the label; the line states the verdict and points
    // at deadDestNote, which renders the engine's reported reason where there is one and nothing where
    // there is not.
    dead: { label: "Dead, evacuate the coalmine", line: "The last flight did not verify on this destination. Do not trust it for real restores until it is investigated; your scheduled backups were not blocked or altered. Where the engine reported which check failed, it is named below." },
    ailing: { label: "Ailing, flight incomplete", line: "The last flight could not finish, so nothing was proven either way. This is a check problem, not detected data corruption. Where the engine reported why, the reason is named below." },
    pending: { label: "Awaiting first flight", line: "The canary is on but has not completed a flight yet. Nothing is proven until the first round trip returns." },
    disabled: { label: "Off", line: "The canary is not flying. Your write, seal, read, restore and verify path is no longer being checked between real runs." },
  } satisfies Record<CanaryLiveness, { label: string; line: string }>,
  aspects: [
    { key: "write-probe", label: "Can write", proves: "Destination reachable, credentials valid, write permission confirmed by a real PUT." },
    { key: "delete-probe", label: "Can delete", proves: "Delete permission confirmed against prior canary objects; immutable buckets are noted, not failed." },
    { key: "seal", label: "Sealed", proves: "The known corpus sealed to the destination as a real archive write, producing manifests and a RUNLOG entry." },
    { key: "read-signature", label: "Signatures verify", proves: "Read-back of root and shard manifest signatures verifies; tamper-evidence holds." },
    { key: "runlog-freshness", label: "RUNLOG fresh", proves: "The RUNLOG entry is present, chained in linear order, and recent." },
    { key: "decrypt-integrity", label: "Bytes intact", proves: "Every record decrypts and its SHA-384 matches the known per-record hash, byte for byte." },
    { key: "restore", label: "Restored", proves: "The real restore path ran into an isolated canary sink, never a real or prod binding." },
    { key: "restore-verify", label: "Restore verified", proves: "The restored cell read back and byte-compared exactly to the known corpus." },
  ] as const,
  proves: [
    "One green canary proves the destination is reachable, your credentials are valid, and you actually have permission to write and to delete prior objects.",
    "It proves a real archive sealed to the destination, with manifests and a fresh, chained RUNLOG entry, so the audit trail stayed linear and tamper-evident.",
    "It proves the read-back: root and shard manifest signatures verify, every record decrypts, and each SHA-384 matches the known per-record hash exactly.",
    "It proves the real restore path runs end to end into an isolated canary sink, then reads that cell back and byte-compares it to the known corpus.",
    "It proves all of this without touching a single real source or backup: known data only, under a dedicated path, into a dedicated sink.",
    "It runs on the cadence you set (hourly by default) and fails open, so a dead canary alerts you and never blocks or alters your real backups.",
  ],
  disableWarning:
    "Turning the canary off stops the scheduled proof that this destination can be written, sealed, read, restored and verified byte for byte. Your real backups keep running unchanged, but you lose the early warning: a destination that has silently gone bad will no longer raise a canary-dead alert, and you may not find out until you actually need to restore. You can turn it back on at any time.",
};

// AILING_CAUSE_LINE turns the engine's closed ailing cause into ONE honest operator line.
//
// The engine used to report a single flat "unreachable" for every ailing flight, so this screen had nothing
// worth rendering and rendered nothing: an expired credential and a black-holed endpoint produced identical
// copy, and an operator was sent looking at the network when the answer was their key. The engine now
// classifies the fault, and this is the console half of that fix: each class names the thing to go and check.
//
// Each line says what happened and what to do, and none of them overclaims. A missing or unrecognised cause
// returns null, so an older engine (or a flight that genuinely recorded none) renders nothing extra rather
// than a fabricated reason.
export function ailingCauseLine(cause: string | undefined): string | null {
  switch (cause) {
    case "auth":
      return "The destination refused the credentials. Check the access key and its permissions on this destination; the endpoint itself answered.";
    case "worm-refused":
      return "The destination refused the write under an Object Lock or retention rule. This is the store enforcing immutability, not a fault to repair.";
    case "throttled":
      return "The destination throttled the request. It should clear on the next flight; a persistent throttle needs a rate or capacity change at the store.";
    case "timeout":
      return "The request never completed within its bound. The store may be slow or partially reachable rather than down.";
    case "network":
      return "The request never reached the destination. Check the endpoint, DNS and any egress restriction between your engine and the store.";
    case "tls":
      return "The transport-security handshake failed, which usually means a wrong or expired certificate on the destination endpoint.";
    case "probe-mismatch":
      return "The destination ANSWERED and returned different bytes than it was given. It is reachable, and what it handed back was not what was written; treat this destination as suspect and investigate before relying on it.";
    case "unreachable":
      // Legacy: produced by engines predating the classification split. Named honestly as coarse rather than
      // dressed up as one of the specific classes, because it genuinely is not known which one it was.
      return "The engine reported a coarse transport fault without a specific class, which an older engine version does.";
    case "other":
      return "The flight failed for a reason outside the destination-fault classes, for example a seal failure.";
    default:
      return null;
  }
}
