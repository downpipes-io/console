// FIXTURE: the shape a BYTE floor cannot see. This validator prints only its verdict banner, exactly like
// test/validate-posture-ack.ts and test/validate-client-diag.ts, which write assertion output only on
// failure. On bytes it looks busy; on assertion lines it is empty, and it passes no check count, so the
// guard must refuse it.
import { verdictReached } from "../verdict-guard.ts";
console.log("\nSILENT FIXTURE: a banner and nothing that looks like an assertion");
verdictReached(0);
