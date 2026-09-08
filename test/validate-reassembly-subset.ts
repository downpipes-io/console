// Prove the reassembly card's share triage: a quorum still recovers when the operator has ALSO loaded a
// share that does not belong, and the shares that do not belong are NAMED.
//
// Why this exists. combine() interpolates over whatever share set it is handed and has no error detection
// of its own: a bad share in an otherwise-sufficient set silently yields a WRONG key (shamir.ts). The card
// used to pass every loaded share straight to it, so one stray share defeated an otherwise-good quorum and
// the operator was told to "try removing a share and reconstructing again" with no indication which. For a
// 3-of-5 split with four shares loaded that is a blind search, performed in front of the custodians who had
// to be assembled to get that far, at exactly the moment recovery matters.
//
// findGoodSubset replaces that guess with an answer. It is pure and cheap (n is capped at 16 by the
// splitter, so the worst case is C(16,8) = 12,870 combines of 32 bytes), which is why it can afford to be
// exhaustive rather than heuristic.
//
// Run: node test/validate-reassembly-subset.ts

import { split, wrappingKeyChecksum } from "../src/lib/shamir.ts";
import type { ShareFileFields } from "../src/lib/custody-files.ts";
import { findGoodSubset } from "../src/screens/restore-flow/reassembly.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// fieldsFor packs a real split into the ShareFileFields shape the card holds, so this drives the same
// values the file parser produces rather than a hand-built stand-in.
function fieldsFor(secret: Uint8Array, n: number, threshold: number): { shares: ShareFileFields[]; checksum: Uint8Array } {
  const checksum = wrappingKeyChecksum(secret);
  const shares = split(secret, n, threshold).map((body, i) => ({ index: i + 1, n, threshold, checksum, share: body }));
  return { shares, checksum };
}

function main(): void {
  const secret = rand(32);
  const { shares, checksum } = fieldsFor(secret, 5, 3);

  console.log("a clean quorum reconstructs, and nothing is reported bad:");
  {
    const got = findGoodSubset(shares.slice(0, 3), checksum);
    ok("a 3-of-5 quorum reconstructs", got !== null);
    ok("it recovers the ORIGINAL wrapping key, not merely something that passes the checksum", got !== null && sameBytes(got.wrappingKey, secret));
    ok("all three shares are classified good", got !== null && got.good.length === 3 && got.bad.length === 0);
  }

  console.log("all five shares loaded: every one is good, and the key is still right:");
  {
    const got = findGoodSubset(shares, checksum);
    ok("reconstructs from the full set", got !== null && sameBytes(got.wrappingKey, secret));
    ok("no share is wrongly accused", got !== null && got.bad.length === 0 && got.good.length === 5);
  }

  console.log("ONE bad share alongside a good quorum: recovers anyway, and names the bad one:");
  {
    // The case the old code failed: four shares loaded, three of them a valid quorum, one altered. Passing
    // all four to combine() yields a wrong key and a blind "remove a share" retry loop.
    const tampered: ShareFileFields = { ...shares[3]!, share: new Uint8Array(shares[3]!.share) };
    tampered.share[5] = (tampered.share[5]! ^ 0xff) & 0xff;
    const loaded = [shares[0]!, shares[1]!, shares[2]!, tampered];

    const got = findGoodSubset(loaded, checksum);
    ok("it still reconstructs, rather than being defeated by the stray share", got !== null);
    ok("and recovers the correct key", got !== null && sameBytes(got.wrappingKey, secret));
    ok("the altered share is named as bad", got !== null && got.bad.length === 1 && got.bad[0]!.index === 4);
    ok("the three honest shares are not accused", got !== null && got.good.length === 3 && got.good.every((f) => f.index !== 4));
  }

  console.log("a share from a DIFFERENT split is rejected, not blended in:");
  {
    const other = fieldsFor(rand(32), 5, 3);
    const loaded = [shares[0]!, shares[1]!, shares[2]!, { ...other.shares[3]!, checksum }];
    const got = findGoodSubset(loaded, checksum);
    ok("the correct quorum still wins", got !== null && sameBytes(got.wrappingKey, secret));
    ok("the foreign share is named as bad", got !== null && got.bad.length === 1 && got.bad[0]!.index === 4);
  }

  console.log("too few good shares: refuses rather than returning a plausible wrong key:");
  {
    // Two of the three needed are altered, so no threshold-sized subset can verify. The honest outcome is
    // null, which the card renders as "no combination reconstructs this key", never a silent wrong answer.
    const badA: ShareFileFields = { ...shares[1]!, share: new Uint8Array(shares[1]!.share) };
    badA.share[2] = (badA.share[2]! ^ 0x5a) & 0xff;
    const badB: ShareFileFields = { ...shares[2]!, share: new Uint8Array(shares[2]!.share) };
    badB.share[7] = (badB.share[7]! ^ 0xa5) & 0xff;
    ok("no subset verifies, so it returns null", findGoodSubset([shares[0]!, badA, badB], checksum) === null);
  }

  console.log("short of the threshold: refuses:");
    ok("two shares of a 3-of-5 split cannot reconstruct", findGoodSubset(shares.slice(0, 2), checksum) === null);

  console.log("the result is deterministic, so support can reproduce what the operator saw:");
  {
    const a = findGoodSubset(shares, checksum);
    const b = findGoodSubset([...shares].reverse(), checksum);
    ok(
      "loading the same shares in a different order gives the same verdict",
      a !== null && b !== null && sameBytes(a.wrappingKey, b.wrappingKey) && a.good.length === b.good.length && a.bad.length === b.bad.length,
    );
  }

  console.log("");
    if (failures > 0) {
    console.log(`REASSEMBLY SUBSET FAIL (${failures} assertion(s) failed)`);
    process.exit(1);
  }
  console.log("REASSEMBLY SUBSET PASS (a stray share no longer defeats a good quorum, and the stray is named)");
}

main();
