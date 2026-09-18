// The console's provider mirrors, graded against the engine each one claims to mirror.
//
// TWO MIRRORS LIVE HERE because they fail the same way and are graded the same way: a console copy of an
// engine derivation, carrying a comment that says it mirrors, with nothing comparing the two.
//
// WHY THIS FILE EXISTS. console/src/lib/demo/demo-world.ts's demoProviderForEndpoint carries a header
// saying it MIRRORS engine/src/dest/provider.ts's providerForEndpoint, and nothing checked the mirror.
// Measured: deleting its azure branch, so a learner's Azure destination falls through to the
// "s3" residual, left every validator in this repo green. That is the exact defect the demo fix closed.
//
// The value is read by the residency panel, which is the screen that says whether data leaves the
// Cloudflare account, by the topology map's destination phrase and by the downpipe drawer. So the training
// course taught the wrong vendor for the learner's own destination, on the screens whose whole job is to
// say where the archives went.
//
// WHY IT IS ITS OWN FILE RATHER THAN A SECTION OF validate-destination-azure-provider.ts, which is where I
// put it first. That validator runs in validate:chain, which supplies NO engine checkout, so the mirror
// would have resolved nothing and printed a skip on every run. lint:sibling-supply caught exactly that and
// its message is the reason: "a check that reads a sibling it cannot find prints a skip and exits 0, and a
// skip and a pass are the same exit code and the same silence". This file is in validate:workspace:chain,
// which sets REQUIRE_ENGINE=1, so an absent engine is a refusal rather than a quiet pass.
//
// It is graded against the ENGINE'S OWN FUNCTION rather than a hand-copied expectation table, because a
// copied table drifts the moment the authority changes, and a mirror test that cannot notice drift is
// decorative.
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims.

import { AZURE_STORAGE_SUFFIXES as CONSOLE_AZURE_SUFFIXES } from "../src/screens/destination-cards.ts";
import { demoProviderForEndpoint } from "../src/lib/demo/demo-world.ts";
import { importFromEngine } from "./engine-path.ts";
import { verdictCannotCheck, verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         ${measured}` : ""}`);
  if (!cond) failures++;
}

console.log("the demo world's provider derivation, against the engine it mirrors\n");

const here = new URL(".", import.meta.url).pathname; // must end in a separator: engineRoots appends "../../engine"
const mod = await importFromEngine<{ providerForEndpoint: (h: string | undefined) => string }>(here, "src/dest/provider.ts");

if (mod === null) {
  // Only reachable without REQUIRE_ENGINE, on a single-repo clone: the workspace chain sets it, so there
  // importFromEngine refuses before returning.
  //
  // THIS IS A CANNOT-CHECK AND NOT A PASS, and the first version of this file got that wrong. It printed a
  // skip note and fell through to verdictReached(0), which is a zero-assertion pass wearing a green verdict.
  // The completion guard caught it and forced exit 1, saying the file "wrote 193 byte(s), none of which
  // looked like an assertion, so there is no evidence it checked anything". Nothing was compared here, so
  // the honest verdict is that the check could not run.
  verdictCannotCheck("no engine checkout resolved, so the demo mirror was not compared against anything. Point at one with DOWNPIPES_ENGINE=/path/to/engine, or run this through npm run validate:workspace, which supplies the sibling and refuses when it is absent.");
} else {
  // The vectors carry the four-way answer AND the two traps the mirror's own header calls out: Google is a
  // WHOLE-HOST match, so a look-alike must not read as gcs, and Azure is a SUFFIX on the account label, so
  // a bare string ending must not either.
  const hosts = [
    "myaccount.blob.core.windows.net",
    "storage.googleapis.com",
    "abc123.r2.cloudflarestorage.com",
    "s3.us-east-1.amazonaws.com",
    "s3.wasabisys.com",
    "notstorage.googleapis.com",
    "storage.googleapis.com.attacker.test",
    "myaccount.blob.core.cloudapi.de",
    "evilblob.core.windows.net.attacker.test",
    "",
  ];
  let agreed = 0;
  for (const h of hosts) {
    const engine = mod.providerForEndpoint(h);
    const demo = demoProviderForEndpoint(h);
    ok(`the demo agrees with the engine on ${JSON.stringify(h)}`, demo === engine, `demo=${demo} engine=${engine}`);
    if (demo === engine) agreed++;
  }
  // Without this the block would pass if the loop never ran, which is how a mirror test becomes a comment.
  ok("the mirror compared every vector, so agreement is a measurement", agreed === hosts.length && hosts.length === 10, `agreed=${agreed} of ${hosts.length}`);
  // And the vectors must reach all four answers, or a mirror could agree on nothing but the residual.
  const answers = new Set(hosts.map((h) => mod.providerForEndpoint(h)));
  ok("the vectors reach all four providers, so agreement is not agreement on the residual", answers.size === 4, [...answers].sort().join("|"));
}


// 2. THE AZURE CLOUD SUFFIX LIST, the second mirror.
//
// destination-cards.ts declares AZURE_STORAGE_SUFFIXES with a comment saying it mirrors the engine's list,
// one entry per Azure cloud. validate-destination-azure-provider.ts drives one HARDCODED VECTOR per cloud,
// which grades that the console handles the three it knows about and can say nothing about a fourth. If the
// engine ever routes another cloud to its Azure client, the console badges those destinations S3 on the row
// whose whole job is to say which vendor holds the archives, and three green vectors would hide it. That is
// the same defect P1.10 fixed, in the only direction the existing test cannot see.
if (mod !== null) {
  const eng = (mod as unknown as { AZURE_STORAGE_SUFFIXES?: readonly string[] }).AZURE_STORAGE_SUFFIXES;
  if (eng === undefined) {
    ok("the engine still exports AZURE_STORAGE_SUFFIXES, so this mirror can be compared at all", false, "provider.ts no longer exports it, so the comparison below graded nothing");
  } else {
    const a = [...eng].sort();
    const b = [...CONSOLE_AZURE_SUFFIXES].sort();
    ok("the console's Azure cloud suffixes match the engine's, list for list", a.length === b.length && a.every((v, i) => v === b[i]), `engine=${a.join(",")} console=${b.join(",")}`);
    ok("and the list is not empty, so a match is not a match between two empty lists", a.length > 0, `${a.length} suffix(es)`);
  }
}

console.log(failures === 0 ? "\nPROVIDER MIRRORS PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures);
if (failures > 0) process.exit(1);
