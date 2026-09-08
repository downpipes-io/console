// Drives the REAL Offline recovery panel (src/screens/keys/offline-recovery.ts) under the shared DOM shim
// and asserts that what it tells a customer in a disaster is TRUE of the things it names.
//
// WHY THIS EXISTS. this panel carried five claims that were all false, and the file had no
// direct test coverage at all, so nothing anywhere could catch them:
//
//   1+2. "The run ID ... is printed on the recovery sheet". src/recovery-sheet.ts prints an account label,
//        a created date, a posture, three fingerprints, optional custody metadata, a ruled blank for
//        min-runlog-index, and CLI templates carrying the literal placeholder <runId>. No run id, on either
//        the text sheet or the HTML one.
//   3.   "shown as \"Index\" in the console run detail". The run drawer's rows are Run id, Started, Duration
//        and sometimes Predecessor. The index is in the drawer TITLE and the URL, never a row.
//   4.   "Step 1: inspect (identify available runs)", while every command it printed passed --run, which the
//        reader REQUIRES. The one step whose job was to find a run id could not run without one.
//   5.   "signer.pub ... from the recovery sheet". The sheet carries only that key's FINGERPRINT; the .pub
//        file is a ceremony download. A fingerprint cannot be turned back into a public key.
//
// So the assertions below are deliberately of two kinds. The BAN list fails if a known-false phrasing comes
// back. The CONSISTENCY checks re-derive the fact from the OTHER module rather than restating it here: the
// run-id claim is checked against a recovery sheet this test actually renders, so if the sheet ever starts
// carrying run ids, the test that guards the panel's wording is the thing that notices.
//
// AND THAT WAS ONLY HALF DONE, which is why a SIXTH false claim survived until. Every assertion
// about the READER was of the form "the panel contains this string". The panel said the RUNLOG pin is read
// from `downpipe inspect`, printed "as max-index=<n>", and section 4 below checked that the panel said
// "max-index=". It did say it. `inspect` does not print it: cmd/downpipe/inspect.go prints format, run,
// created, downpipe, envelope, records, signer and recipients, and `attest` (cmd/downpipe/attest.go:119
// and :121) is the ONLY command in the reader that emits max-index=. So an operator mid-incident, setting
// the one pin that protects them against a rolled-back archive, was sent to a command that will not print
// the number. Exactly the shape of the original five, and it lasted because the check that guarded the
// wording never opened the thing the wording was about.
//
// Section 8 fixes the class rather than the instance. Every subcommand and every flag the panel prints is
// now resolved against the reader's OWN source through test/downpipe-root.ts, and the pin block must name
// a command whose source actually emits the field it tells the operator to read.
//
// Run with `node test/validate-offline-recovery-panel.ts`.

import { installDomShim, qsa, textOf } from "./dom-shim.ts";
installDomShim();

import { requireDownpipeRoot, readDownpipeSource } from "./downpipe-root.ts";
import { renderOfflineRecovery } from "../src/screens/keys/offline-recovery.ts";
import { recoverySheet, recoverySheetHTML, type SheetParams } from "../src/recovery-sheet.ts";
import type { CeremonyResult, KeyMaterial } from "../src/keygen.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A ceremony result and sheet params typed properly, so this test cannot drift from either real shape:
// if CeremonyResult or SheetParams changes, this stops compiling rather than silently checking nothing.
// The key VALUES are placeholders (this test asserts only that the FINGERPRINTS reach the sheet); no real
// key material is generated here, and none is needed, which is itself the point the sheet copy now makes.
const SHEET_PARAMS: SheetParams = {
  downpipeAccount: "acct-test",
  createdAt: "2026-08-04",
  posture: "break-glass-only",
};
const material = (fingerprint: string): KeyMaterial => ({ identityB64: "aaaa", recipientPublicB64: "bbbb", fingerprint });
const CERTS: CeremonyResult = {
  breakGlass: material("bg-fp-0001"),
  operational: null,
  signer: { privateB64: "cccc", publicB64: "dddd", fingerprint: "sg-fp-0001" },
};

function panelText(): string {
  const root = renderOfflineRecovery();
  return textOf(root);
}

function commandBlocks(): string[] {
  const root = renderOfflineRecovery();
  return qsa(root, "pre").map((p) => textOf(p));
}

function main(): void {
  console.log("\nOFFLINE RECOVERY PANEL: the incident instructions must be true of what they name\n");

  const text = panelText();
  const blocks = commandBlocks();
  const all = `${text}\n${blocks.join("\n")}`;

  console.log("1. the five known-false phrasings must never come back:");
  for (const banned of [
    "printed on the recovery sheet",
    "visible in the Runs screen",
    'shown as "Index" in the console run detail',
    "Step 1: inspect (identify available runs)",
    "from your recovery sheet",
  ]) {
    ok(`the panel does not say ${JSON.stringify(banned)}`, !all.includes(banned));
  }

  console.log("\n2. the run-id claim, checked against a sheet this test actually renders:");
  const sheetText = recoverySheet(CERTS, SHEET_PARAMS);
  const sheetHtml = recoverySheetHTML(CERTS, SHEET_PARAMS);
  // The sheet prints "<runId>" as a PLACEHOLDER inside its CLI templates. A real run id would have to be a
  // concrete value, so a sheet that only ever emits the angle-bracket placeholder carries no run id.
  const sheetHasConcreteRunId = /run-[a-z0-9-]{4,}/i.test(sheetText) || /run-[a-z0-9-]{4,}/i.test(sheetHtml);
  ok("the recovery sheet carries NO concrete run id (only the <runId> placeholder)", !sheetHasConcreteRunId);
  ok("the panel says so, rather than sending the customer to the sheet for one",
    all.includes("The recovery sheet does NOT carry run IDs"));

  console.log("\n3. Step 1 must be runnable by someone who has no run id:");
  const listing = blocks.find((b) => b.includes("keys --which"));
  ok("a command block offers `downpipe keys --which`", listing !== undefined);
  ok("that block passes no --run", listing?.includes("--run ") === false);
  ok("that block needs no identity and no signer",
    listing?.includes("--identity") === false && listing.includes("--signer") === false);
  ok("the step is headed as a listing step", all.includes("Step 1: list the runs an archive holds"));

  console.log("\n4. the anti-rollback pin must be read from something that exists:");
  const pinBlock = blocks.find((b) => b.includes("--min-runlog-index"));
  ok("a command block covers the pin", pinBlock !== undefined);
  ok("it names the max-index= field", pinBlock?.includes("max-index=") === true);
  // WHICH command it sends the operator to is checked in section 8, against the reader's own source.
  // Asserting it here, against the panel's own text, is what let "inspect prints it" stand for as long
  // as it did.
  ok("it names the drawer TITLE, not a row", pinBlock?.includes("TITLE") === true);
  ok("it warns that the title groups large numbers",
    pinBlock?.toLowerCase().includes("separators") === true);

  console.log("\n5. the .pub files must be described as files, not as sheet text:");
  ok("the panel calls signer.pub a downloaded FILE", all.includes("downloaded by the key ceremony"));
  ok("the panel points at the sheet's fingerprints as the CHECK, not the source",
    all.includes("fingerprint the sheet prints"));
  // The sheet must actually carry those fingerprints for that instruction to be followable.
  ok("the sheet does carry the signer fingerprint the panel tells you to check against",
    sheetText.includes(CERTS.signer.fingerprint));
  ok("the sheet does carry the break-glass fingerprint too",
    sheetText.includes(CERTS.breakGlass.fingerprint));

  // ---------------------------------------------------------------------------------------------
  // 6. THE SHEET-ONLY CUSTOMER. verify and restore both hard-require --signer and exit ExitUsage
  // without it (downpipe/cmd/downpipe/verify.go, restore.go), and the signer public key is in neither
  // the recovery bundle (FORMAT.md and RECOVER.md only) nor the signed root manifest (which records
  // signingKeyFingerprint). So the sheet MUST tell its reader to keep signer.pub, or a customer who
  // followed the sheet exactly holds identity.key plus a page of fingerprints and cannot restore.
  // These assertions are on the SHEET, the artefact a customer keeps for years, not on the panel.
  // ---------------------------------------------------------------------------------------------
  console.log("\n6. the printed sheet must not leave its reader without signer.pub:");
  ok("the text sheet names signer.pub as a file to keep", sheetText.includes("Keep signer.pub"));
  ok("the text sheet says the sheet alone is not enough",
    sheetText.includes("THIS SHEET IS NOT ENOUGH ON ITS OWN"));
  ok("the HTML sheet says it too", sheetHtml.includes("THIS SHEET IS NOT ENOUGH ON ITS OWN"));
  ok("the text sheet gives the reason (the CLI refuses without --signer)",
    sheetText.includes("--signer"));
  ok("the text sheet says signer.pub is not in the archive",
    sheetText.includes("not written into the archive"));
  // The sheet must not imply it CARRIES signer.pub. "this signer.pub" read as if it did.
  ok("neither sheet says \"this signer.pub\"",
    !sheetText.includes("this signer.pub") && !sheetHtml.includes("this <code>signer.pub</code>"));
  // A customer with no run id must find one from the sheet alone, since the sheet carries none.
  ok("the text sheet points at keys --which for the run id", sheetText.includes("keys --which"));
  ok("the HTML sheet does too", sheetHtml.includes("keys --which"));
  // The sheet must still carry NO key material: this fix adds instruction, not secrets.
  ok("the sheet still carries no identity key bytes", !sheetText.includes(CERTS.breakGlass.identityB64));
  ok("the sheet still carries no signer private bytes", !sheetText.includes(CERTS.signer.privateB64));
  ok("nor does the HTML sheet", !sheetHtml.includes(CERTS.breakGlass.identityB64) && !sheetHtml.includes(CERTS.signer.privateB64));

  // ---------------------------------------------------------------------------------------------
  // 7. recipient.pub is NOT an input to offline recovery. No downpipe command accepts it, and
  // --check-bundle verifies SHA384SUMS under the --signer verifier, not under a recipient key. The
  // panel used to list it as a required kit file "used for --check-bundle", which would have sent an
  // operator mid-incident hunting for a file that could not have helped.
  // ---------------------------------------------------------------------------------------------
  console.log("\n7. recipient.pub must not be claimed as a --check-bundle input:");
  ok("the panel no longer ties recipient.pub to --check-bundle",
    !all.includes("used for --check-bundle"));
  ok("the panel says plainly that recipient.pub is not needed",
    all.includes("recipient.pub is NOT needed here"));
  ok("no command block passes a recipient key",
    blocks.every((b) => !b.includes("recipient.pub")));
  ok("the panel says the signer is required and unrecoverable from the archive",
    all.includes("not stored in the archive"));

  // ---------------------------------------------------------------------------------------------
  // 8. THE READER, OPENED. Everything above this line is the console checked against the console.
  // These assertions resolve the reader through test/downpipe-root.ts and read its source, so a
  // subcommand that is renamed, a flag that is dropped, or an output field that moves to another
  // command fails HERE, with the panel unchanged. That is the only arrangement in which this file is
  // a check on the panel's truthfulness rather than a check on its spelling.
  // ---------------------------------------------------------------------------------------------
  console.log("\n8. every command and flag the panel prints must exist in the reader:");
  const readerRoot = requireDownpipeRoot("validate-offline-recovery-panel.ts CLI-surface assertions");
  if (readerRoot === null) {
    // Skipped loudly rather than failed, for the reason set out at length in test/validate-keygen.ts's
    // own reader block: this file sits in `npm run validate`, that chain is joined by && and the CI
    // Validators job checks out console alone, so a hard FAIL here does not make the check strict, it
    // stops the chain and leaves every validator after it unrun. The CLI-surface assertions are
    // mandatory in the Cross-repo gates job instead, which checks the reader out and sets
    // REQUIRE_DOWNPIPE=1, under which requireDownpipeRoot throws and this branch cannot be reached.
    console.log(
      "  SKIPPED (no reader sibling): the panel's commands and flags were NOT checked against the reader.\n" +
        "       They are enforced in the Cross-repo gates CI job with REQUIRE_DOWNPIPE=1. To run them here,\n" +
        "       point DOWNPIPES_DOWNPIPE at a reader checkout.",
    );
  } else {
    const main = readDownpipeSource(readerRoot, "cmd/downpipe/main.go");
    // The subcommands, from the dispatch switch itself.
    const subcommands = new Set([...main.matchAll(/^\s*case\s+"([a-z][a-z-]*)"(?:,[^:]*)?:\s*$/gm)].map((m) => m[1] as string));
    ok(`the reader's dispatch yielded a plausible command set (${subcommands.size})`, subcommands.size >= 8);

    // Which source file defines each command, so a flag can be checked against the RIGHT command.
    const fileFor: Record<string, string> = {
      keys: "keys.go", verify: "verify.go", attest: "attest.go", restore: "restore.go", inspect: "inspect.go",
      prune: "prune.go", recombine: "recombine.go", "unseal-export": "unseal_export.go",
      selftest: "selftest.go", setup: "setup.go", preflight: "preflight.go", init: "init.go", update: "update.go",
    };
    // Flag registrations, in every form the reader writes them: fs.String("x", fs.StringVar(&f.x, "x",
    // and fs.Var(&f.x, "x". The \w* after the type is load-bearing: without it StringVar and IntVar are
    // invisible, and the FIRST version of this block reported --identity missing from verify and restore
    // for exactly that reason. That is worth recording, because the tempting fix at that moment is to
    // drop the assertion rather than the bad parse, and dropping it would have rebuilt the defect this
    // section exists to remove.
    const flagsIn = (src: string): Set<string> =>
      new Set([...src.matchAll(/fs\.(?:String|Bool|Int64|Int|Uint|Float64|Duration|Var)\w*\(\s*(?:&[\w.]+\s*,\s*)?"([a-z0-9-]+)"/g)].map((m) => m[1] as string));
    // Two shared registrars, pulled in only by the commands that actually call them.
    const storeFlags = flagsIn(main.slice(main.indexOf("func addStoreFlags")).split("\n}")[0] ?? "");
    const identitySrc = readDownpipeSource(readerRoot, "cmd/downpipe/identity_source.go");
    const identityFlags = flagsIn(identitySrc.slice(identitySrc.indexOf("func addIdentityFlags")).split("\n}")[0] ?? "");
    ok(`addStoreFlags registers the source flags (${storeFlags.size})`, storeFlags.has("archive") && storeFlags.has("s3-bucket"));
    ok(`addIdentityFlags registers the identity flags (${identityFlags.size})`, identityFlags.has("identity") && identityFlags.has("share"));
    const flagCache = new Map<string, Set<string>>();
    const flagsOf = (cmd: string): Set<string> | null => {
      const cached = flagCache.get(cmd);
      if (cached !== undefined) return cached;
      const rel = fileFor[cmd];
      if (rel === undefined) return null;
      const src = readDownpipeSource(readerRoot, `cmd/downpipe/${rel}`);
      const set = flagsIn(src);
      if (src.includes("addStoreFlags(fs)")) for (const f of storeFlags) set.add(f);
      if (src.includes("addIdentityFlags(fs")) for (const f of identityFlags) set.add(f);
      flagCache.set(cmd, set);
      return set;
    };

    // Walk the panel's command blocks INVOCATION BY INVOCATION. Per-block attribution is not good
    // enough: the pin block holds an `attest` line and a `restore` line, and scanning the block as one
    // unit charged restore's --identity, --sink and --out to attest and reported three false failures.
    // A check that mis-attributes is a check that will be silenced.
    const invocations: { cmd: string; flags: Set<string> }[] = [];
    for (const block of blocks) {
      // Join backslash continuations first, then drop comment lines, so a flag named in prose above a
      // command is not charged to it.
      const joined = block.replace(/\\\n\s*/g, " ");
      for (const raw of joined.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("#")) continue;
        const m = /(?:^|\s)downpipe\s+([a-z][a-z-]*)\b/.exec(line);
        if (m === null) continue;
        invocations.push({
          cmd: m[1] as string,
          flags: new Set([...line.slice(m.index + m[0].length).matchAll(/(?:^|\s)--([a-z0-9-]+)/g)].map((x) => x[1] as string)),
        });
      }
    }
    ok("the panel's blocks actually named some commands to check", invocations.length > 0);
    for (const { cmd, flags } of invocations) {
      ok(`the reader has a \`${cmd}\` command`, subcommands.has(cmd));
      const known = flagsOf(cmd);
      if (known === null) continue;
      for (const f of flags) ok(`\`downpipe ${cmd}\` accepts --${f}`, known.has(f));
    }

    // The pin block must name a command whose SOURCE emits the field it tells the operator to read.
    // This is the assertion that "it names inspect's own max-index= output" could never have been.
    const pinCmd = /(?:^|\s)downpipe\s+([a-z][a-z-]*)/.exec(pinBlock ?? "")?.[1];
    ok("the pin block names a command", pinCmd !== undefined);
    // An unmapped command FAILS rather than skipping the assertion. The first draft of this block let
    // fileFor miss and fell through, which would have let the panel be pointed back at `inspect` and
    // still go green, rebuilding the very defect three paragraphs of this file's header are about.
    ok("the pin command is one this check knows how to open", pinCmd !== undefined && fileFor[pinCmd] !== undefined);
    if (pinCmd !== undefined && fileFor[pinCmd] !== undefined) {
      const src = readDownpipeSource(readerRoot, `cmd/downpipe/${fileFor[pinCmd] as string}`);
      ok(`\`downpipe ${pinCmd}\` really does print max-index=`, /fmt\.(?:Fprintf|Printf)\([^\n]*max-index=/.test(src));
    }
    // And the operator must be able to run it with what they have at that moment.
    if (pinCmd !== undefined) {
      const known = flagsOf(pinCmd);
      ok("the pin command needs no identity (it is run before the kit is assembled)", known !== null && !known.has("identity"));
    }

    // `keys --which` is the panel's Step 1, offered to someone holding nothing. The reader must still
    // refuse key files there, or the step's "needs no identity, no signer" promise is the panel's alone.
    const keysSrc = readDownpipeSource(readerRoot, "cmd/downpipe/keys.go");
    ok("the reader still has a --which flag on keys", /fs\.Bool\("which"/.test(keysSrc));
    ok("the reader still says keys --which takes no identity or recipient key", keysSrc.includes("takes no identity or recipient key"));

    // Section 6's premise, checked rather than asserted in a comment: verify and restore must still
    // hard-require --signer, or "THIS SHEET IS NOT ENOUGH ON ITS OWN" stops being the reason it gives.
    for (const cmd of ["verify", "restore"]) {
      const src = readDownpipeSource(readerRoot, `cmd/downpipe/${fileFor[cmd] as string}`);
      ok(`\`downpipe ${cmd}\` still declares --signer`, /fs\.String\("signer"/.test(src));
      ok(`\`downpipe ${cmd}\` still refuses to run without it`, /signerPath\s*==\s*""/.test(src));
    }

    // Section 7's premise: recipient.pub is not an input to offline RECOVERY. Scoped to the three
    // commands a recovery actually runs, and deliberately NOT to `keys`, which does take --recipient on
    // its --fingerprint path (checking key files you hold against the sheet). Asserting it there too
    // would be a false claim about the reader in a file whose subject is false claims about the reader.
    for (const cmd of ["verify", "restore", "attest"]) {
      const known = flagsOf(cmd);
      ok(`\`downpipe ${cmd}\` takes no --recipient key`, known !== null && !known.has("recipient"));
    }

    // 9. THE PANEL'S RESTORE COMMANDS MUST ACTUALLY RESTORE, graded against the reader's own flag
    // declaration rather than against an opinion held here.
    //
    // THE DEFECT, driven by building the reader and reading `downpipe restore --help`:
    //   -apply   write to the target; without it the restore is a dry run that plans only
    // The panel is headed "Step 3: restore (write decrypted records)" and its prose said restore
    // "writes them to the chosen sink", and not one of its four restore command blocks carried
    // --apply. A customer on the break-glass path copies the command the console gave them, it prints
    // a plan, it exits 0, and it writes nothing. On a dry run the reader does not even exit non-zero
    // on a per-record failure (restore.go gates that on effectiveApply), so the exit code does not
    // give the omission away either.
    //
    // Two other surfaces written for the same customer at the same moment already had it right:
    // downpipe/docs/RECOVER.md (the bundle that ships INSIDE the bucket) and src/recovery-sheet.ts
    // (the printed sheet) both carry --apply. The console panel was the only one that did not, which
    // is what makes this a defect rather than a decision.
    console.log("\n9. the restore commands write, and the reader is the authority on what that takes:");
    const restoreFlags = flagsOf("restore");
    ok("`downpipe restore` still declares --apply", restoreFlags?.has("apply") === true);
    // The premise: --apply defaults to FALSE. If the reader ever made writing the default, these
    // assertions would be enforcing a flag that no longer matters, so the premise is checked rather
    // than assumed.
    const restoreSrc = readDownpipeSource(readerRoot, "cmd/downpipe/restore.go");
    ok("and it still defaults to false, so a restore without it plans only",
      /fs\.Bool\("apply",\s*false/.test(restoreSrc));

    // The subject must EXIST before "every one of them carries --apply" means anything: a deleted
    // restore section would satisfy a bare "all" over an empty list.
    const restoreBlocks = blocks.filter((b) => b.includes("downpipe restore"));
    ok(`the panel offers restore command blocks at all (${restoreBlocks.length})`, restoreBlocks.length >= 4);
    for (const [i, b] of restoreBlocks.entries()) {
      ok(`restore block ${i + 1} carries --apply, so it writes`, /\bdownpipe restore\b[\s\S]*?--apply\b/.test(b));
    }
    ok("the prose says restore writes nothing without it", text.includes("Restore writes nothing without"));
    ok("and names the default as a dry run that plans only", text.includes("the default is a dry run that plans only"));

    // 10. AN EXIT CODE IS NOT A VERDICT UNTIL YOU KNOW WHICH ONE, and this is the panel where the
    // difference decides whether a customer goes to a replica or gives up. The panel said "A non-zero
    // exit code means verification failed". Read off the reader's own const block that is false for
    // 6 (usage: nothing was opened), 11 (unreachable: nothing was established), 12 and 13. Code 13
    // says the opposite: the manifests verified and every failed record was a seg/ object this copy
    // does not hold, so nothing failed a signature, a tag or a hash.
    console.log("\n10. the exit-code guidance, graded against the reader's own code table:");
    const errsSrc = readDownpipeSource(readerRoot, "internal/format/errors.go");
    const codeOf = (name: string): number | null => {
      const m = new RegExp(`Exit${name}\\s*=\\s*(\\d+)`).exec(errsSrc);
      return m === null ? null : Number(m[1]);
    };
    ok("the reader still numbers the dangling-segment code 13", codeOf("Dangling") === 13);
    ok("the reader still numbers the unrenderable code 12", codeOf("Unrenderable") === 12);
    ok("the reader still numbers the unwritten code 10", codeOf("Unwritten") === 10);
    // The reader's own reason for 13 existing, so this assertion is anchored to the reader's intent
    // and not to a sentence written here.
    ok("the reader still says conflating absent with corrupt points a recoverer the wrong way",
      /merely absent/.test(errsSrc));

    ok("the panel no longer claims every non-zero code is a verification failure",
      !text.includes("A non-zero exit code means verification failed"));
    ok("the panel says an exit 13 is not corruption", text.includes("If the restore exits 13, your data is not corrupt"));
    ok("and names the remedy as another copy of the bucket",
      text.includes("Fetch those objects from another copy of the bucket"));
    ok("and says why retrying the same copy will not help",
      text.includes("the read was answered and the answer was that the object is not there"));
    ok("the panel names --deep as the pass that can tell the two apart",
      text.includes("the only pass that can tell a corrupt object from an absent one"));
    ok("the panel says exit 12 is not data loss", text.includes("Exit 12 means every byte landed intact"));
    ok("the panel says exit 10 leaves records off the disk",
      text.includes("Those records are in the archive and are not on your disk"));
  }

  console.log(failures === 0 ? "\nOFFLINE RECOVERY PANEL PASS" : `\nOFFLINE RECOVERY PANEL: ${failures} FAILED`);
  
  process.exit(failures === 0 ? 0 : 1);
}

main();
