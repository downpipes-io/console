// FIXTURE: a file that only EXPORTS its work. Run as its own step in the validate chain it prints
// nothing, checks nothing and exits 0. The engine had a validator in exactly this shape listed as its own
// chain step, and the console's chain lists 141 steps by path, so the same mistake is one line away.
import { verdictReached } from "../verdict-guard.ts";
export async function run(): Promise<void> {
  console.log("  ok   this never runs when the file is the entry point");
  verdictReached(0, 1);
}
