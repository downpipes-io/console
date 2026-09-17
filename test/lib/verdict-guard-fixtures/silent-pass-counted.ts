// FIXTURE: the same silence, with the escape hatch used properly. A validator that is deliberately quiet on
// a pass declares its own check count, which is a real number rather than a guess from its output, and the
// floor is satisfied without weakening it for everyone else.
import { verdictReached } from "../verdict-guard.ts";
console.log("\nSILENT FIXTURE: a banner, and a declared count of what it checked");
verdictReached(0, 7);
