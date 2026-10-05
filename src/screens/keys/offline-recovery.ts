// The Offline recovery tab of the Keys and break-glass screen: the EXACT downpipe CLI invocations an
// operator needs during an incident, as copyable command blocks present at all times so an operator reading
// the console during an incident does not need external documentation. The canonic incident procedure is
// `keys --which` (list the runs the archive holds, the only step that needs no run id), inspect one of them,
// verify (tamper-evident check before restoring) and restore (decrypt and write records), plus the S3/R2
// variants. It imports nothing from the other tab modules (no shared state needed), so it never forms a cycle.
//
// NO-CUSTODY: no private value appears in any command shown here; identity.key is a FILE PATH placeholder,
// never a value. Claims are precise: "tamper-evident" not "tamper-proof"; "post-quantum hybrid" not
// "quantum-proof".
//
// A PINNED SIGNER IS REQUIRED, AND THIS PANEL MUST SAY WHERE IT COMES FROM. verify and restore refuse
// to start without one and exit ExitUsage (downpipe/cmd/downpipe/signer_source.go). There are two
// sources. signer.pub from the kit works for every run. From engine 0.3.7 the recovery bundle also
// carries the CURRENT signer's signer.pub (engine/src/format/bundle.ts addBundle), and from reader 0.3.4
// --signer-fingerprint accepts that copy only when its fingerprint equals the one on the printed sheet.
// The copy is destination-wide and every run overwrites it. So identity.key plus the printed sheet is
// NOT a recoverable state in a bucket no engine 0.3.7 or later has written to, or for a run sealed before a
// re-key rotated the signer. Copy here that implies otherwise costs a customer their data during the
// one incident this panel exists for.
//
// recipient.pub is not needed here: no downpipe command accepts it, and --check-bundle verifies the
// bundle's SHA384SUMS signature under the --signer verifier (restore.go's checkRecoveryBundle takes that
// verifier), never against recipient.pub. Do not list it as a prerequisite: it sends an operator hunting
// for a file that will not help them recover.

import { h, svgIcon } from "../../lib/dom.ts";
import { navigate } from "../../lib/nav.ts";
import { badge } from "../../components/status.ts";
import { codeBlock } from "../../components/code-block.ts";
import { ICON_CHEVRON_RIGHT } from "../../lib/icons.ts";

// renderOfflineRecovery renders the exact downpipe CLI invocations an operator needs
// during an incident with the recovery sheet. The body is assembled from per-section
// helpers (intro, install, inspect, verify, restore, anti-rollback, navigation) so each
// logical block stays readable in isolation; the assembled DOM order is unchanged.
export function renderOfflineRecovery(): HTMLElement {
  // Disclosure body (the heading lives in the summary). The badge leads the body.
  const card = h("div", { class: "measure" });
  for (const el of [
    ...renderIntroSection(),
    ...renderInstallSection(),
    ...renderInspectSection(),
    ...renderVerifySection(),
    ...renderRestoreSection(),
    ...renderAntiRollbackSection(),
    ...renderNavigationSection(),
  ]) {
    card.appendChild(el);
  }
  return card;
}

// renderIntroSection: the incident-reference badge, the orientation prose, and the prerequisites list.
function renderIntroSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("div", { style: "margin-bottom:var(--space-3)" }, badge("info", "Incident reference")));

  out.push(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "During a break-glass recovery incident, use the ",
      h("code", { class: "mono" }, "downpipe"),
      " CLI with the identity.key from your offline storage and a pinned signer. The pinned signer is the signer.pub file the key ceremony downloaded, or (from reader 0.3.4) the signer fingerprint on your printed sheet, passed as --signer-fingerprint. With the fingerprint, the CLI uses the signer.pub copy in the bucket only if its fingerprint matches. That copy is always your current signer's, so the fingerprint works only for runs sealed since your last re-key. The CLI operates entirely offline against a local archive directory or an S3-compatible archive bucket.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "If you have neither signer.pub nor the printed sheet, stop here and find one of them before anything else. ",
      h("code", { class: "mono" }, "verify"),
      " and ",
      h("code", { class: "mono" }, "restore"),
      " both refuse to start without ",
      h("code", { class: "mono" }, "--signer"),
      " or ",
      h("code", { class: "mono" }, "--signer-fingerprint"),
      ". A bucket with no run written to it yet has no copy of the signer public key. After a re-key, the copy is the new signer's. In both cases you need signer.pub itself. For a run sealed before the re-key, that is the old signer.pub. It is a public key that decrypts nothing, so any copy of the right file will do.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "The recovery sheet does NOT carry run IDs, and in a real incident this console may be gone, so the archive itself is where you find them: ",
      h("code", { class: "mono" }, "downpipe keys --which --archive <dir>"),
      " lists every run a source holds, grouped by the identity that opens each one. That is Step 1 below, and it needs nothing but the archive. While this console IS reachable, the Runs screen also shows each run's ID in its detail. The verify and restore commands below that pass --receipt write receipt.json; keep it as the record of the recovery action.",
    ),
  );

  // Prerequisites block.
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Files required from your recovery kit"));

  const prereqList = h("ul", { class: "field__hint", style: "padding-left:var(--space-5);display:flex;flex-direction:column;gap:var(--space-1);margin-top:var(--space-2)" });
  for (const item of [
    "identity.key (the break-glass private key, from your offline or custody-split storage)",
    "signer.pub (the operator signer public key: a FILE downloaded by the key ceremony, not text on the sheet. Check it against the signer fingerprint the sheet prints). From reader 0.3.4 you can pass the sheet's signer fingerprint with --signer-fingerprint instead, and the CLI uses the bucket's copy. That copy is your current signer's, so a run sealed before a re-key, or a bucket with no copy, needs the file.",
    "the run ID (NOT on the recovery sheet: list what an archive holds with `downpipe keys --which --archive <dir>`, Step 1 below)",
    "recipient.pub is NOT needed here. No recovery command takes it (only keys --fingerprint reads it, to check it against your sheet): it is the public half your engine uses to lock new runs, and --check-bundle verifies against the signer, not against it.",
  ]) {
    const li = h("li");
    li.textContent = item;
    prereqList.appendChild(li);
  }
  out.push(prereqList);
  return out;
}

// renderInstallSection: the install guidance (prebuilt archive plus verification, then the
// build-from-source fallback) and their command blocks.
function renderInstallSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Install the downpipe CLI"));

  out.push(
    h("p", { class: "field__hint" },
      "Download the archive for your platform (linux, darwin or windows; amd64 or arm64) from the latest release. checksums.txt lists each archive's SHA-256 and is cosign-signed; a CycloneDX SBOM sits beside each archive. Verify before you extract it.",
    ),
  );
  out.push(codeBlock(
    "# Download your platform's archive, checksums.txt and checksums.txt.cosign-bundle\n# from https://github.com/downpipes-io/downpipe/releases/latest, then:\nsha256sum --check --ignore-missing checksums.txt\n\ncosign verify-blob \\\n  --bundle checksums.txt.cosign-bundle \\\n  --certificate-identity-regexp '^https://github.com/downpipes-io/downpipe/\\.github/workflows/release\\.yml@refs/tags/v' \\\n  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\\n  checksums.txt\n\n# Extract the binary (unzip the .zip on windows)\ntar -xzf downpipe_<version>_<os>_<arch>.tar.gz downpipe\n\n# Self-test (verifies the conformance suite passes locally)\n./downpipe selftest",
    { copyLabel: "Copy download-verify commands" },
  ));
  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "See ",
      h("code", { class: "mono" }, "VERIFY.md"),
      " in the repository for what each verification step proves and what it does not.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "No prebuilt binary for your platform, or you need to build against an unreleased commit? Build from source instead, with Go 1.26 or newer. The CLI has no runtime dependencies.",
    ),
  );
  out.push(codeBlock(
    "# Build from source (Go 1.26 or newer)\ngit clone https://github.com/downpipes-io/downpipe\ncd downpipe\ngo build -o downpipe ./cmd/downpipe\n\n# Self-test (verifies the conformance suite passes locally)\n./downpipe selftest",
    { copyLabel: "Copy build commands" },
  ));
  return out;
}

// renderInspectSection: Step 1, inspect the archive to list runs (local and S3/R2 variants).
function renderInspectSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Step 1: list the runs an archive holds, then inspect one"));

  // The listing command comes FIRST and takes no run id, because everything below this point does.
  // `inspect` REQUIRES --run (cmd/downpipe/inspect.go), so the step that finds a run id cannot itself
  // require one already. With the recovery sheet carrying no run ids either, this is the only step that
  // gives a customer in a genuine disaster a first move at all.
  out.push(
    h("p", { class: "field__hint" },
      "Start here if you do not have a run ID. ",
      h("code", { class: "mono" }, "keys --which"),
      " reads only the public envelope of each run, so it needs no identity file and no signer, and it names which identity opens each run. Listing the ",
      h("code", { class: "mono" }, "run/"),
      " prefix on the destination gives the same run IDs.",
    ),
  );
  out.push(codeBlock(
    "# List every run the archive holds, grouped by the identity that opens it.\n# Needs nothing but the archive: no identity, no signer, no run id.\ndownpipe keys --which --archive <dir>\n\n# The same, against an S3-compatible bucket:\ndownpipe keys --which \\\n  --s3-endpoint https://<account-id>.r2.cloudflarestorage.com \\\n  --s3-bucket <bucket-name>",
    { copyLabel: "Copy run-listing commands" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "With a run ID in hand, inspect that run to confirm the archive is readable before decrypting. Without ",
      h("code", { class: "mono" }, "--identity"),
      " the preamble (downpipe name, cadence, source config, time window) remains encrypted; pass ",
      h("code", { class: "mono" }, "--identity"),
      " and ",
      h("code", { class: "mono" }, "--signer"),
      " to read the encrypted detail.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "From a local archive directory:",
    ),
  );
  out.push(codeBlock(
    "downpipe inspect --run <runId> --archive <dir>\n\n# With decrypted preamble detail:\ndownpipe inspect --run <runId> --archive <dir> --identity identity.key --signer signer.pub",
    { copyLabel: "Copy inspect (local)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "From an S3-compatible archive bucket (e.g. Cloudflare R2):",
    ),
  );
  out.push(codeBlock(
    "export AWS_ACCESS_KEY_ID=<r2-access-key-id>\nexport AWS_SECRET_ACCESS_KEY=<r2-secret-access-key>\n\ndownpipe inspect \\\n  --run <runId> \\\n  --s3-endpoint https://<account-id>.r2.cloudflarestorage.com \\\n  --s3-bucket <bucket-name> \\\n  --identity identity.key \\\n  --signer signer.pub",
    { copyLabel: "Copy inspect (S3/R2)" },
  ));
  return out;
}

// renderVerifySection: Step 2, the tamper-evident verify (local and S3/R2 variants) and flag guidance.
function renderVerifySection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Step 2: verify (tamper-evident check)"));

  out.push(
    h("p", { class: "field__hint" },
      "Verify the archive before restoring. This checks the run's signed manifests and the RUNLOG chain, and writes a receipt (receipt.json). Add ",
      h("code", { class: "mono" }, "--check-bundle"),
      " to also verify the recovery bundle (FORMAT.md and RECOVER.md) against its signed SHA-384 checksum file. To sign the receipt as well, add ",
      h("code", { class: "mono" }, "--receipt-signer"),
      " with your signer private-key file, if you hold one; it does not take signer.pub.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "Local archive:",
    ),
  );
  out.push(codeBlock(
    "downpipe verify \\\n  --run <runId> \\\n  --archive <dir> \\\n  --identity identity.key \\\n  --signer signer.pub \\\n  --check-bundle \\\n  --receipt receipt.json",
    { copyLabel: "Copy verify (local)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "S3/R2 archive:",
    ),
  );
  out.push(codeBlock(
    "export AWS_ACCESS_KEY_ID=<r2-access-key-id>\nexport AWS_SECRET_ACCESS_KEY=<r2-secret-access-key>\n\ndownpipe verify \\\n  --run <runId> \\\n  --s3-endpoint https://<account-id>.r2.cloudflarestorage.com \\\n  --s3-bucket <bucket-name> \\\n  --identity identity.key \\\n  --signer signer.pub \\\n  --check-bundle \\\n  --receipt receipt.json",
    { copyLabel: "Copy verify (S3/R2)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "Exit 0 means the run verified. Codes 2 to 5 are verification failures: a signature, the record coverage, a per-record plaintext hash, or the freshness and anti-rollback check did not pass. Code 6 is a usage or input error, so nothing was opened, and code 11 means the destination could not be reached, so nothing was established about the archive either way. Read the number rather than only its sign: several non-zero codes are not verification failures, and one of them (13, below) means the opposite. Add ",
      h("code", { class: "mono" }, "--deep"),
      " to open every segment object rather than the manifests alone. It is the only verify pass that can tell a corrupt object from an absent one, and it costs a full read of the archive. The ",
      h("code", { class: "mono" }, "--allow-stale"),
      " flag proceeds despite a freshness or anti-rollback warning (use with caution and document the decision). The ",
      h("code", { class: "mono" }, "--min-runlog-index"),
      " flag rejects any run whose RUNLOG maximum index is below a pinned value (pinning the index is best practice; record it on the recovery sheet).",
    ),
  );
  return out;
}

// renderRestoreSection: Step 3, restore to a directory or back to Wrangler env (local and S3/R2).
function renderRestoreSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Step 3: restore (write decrypted records)"));

  out.push(
    h("p", { class: "field__hint" },
      "Restore decrypts all records and writes them to the chosen sink. ",
      h("strong", {}, "Restore writes nothing without "),
      h("code", { class: "mono" }, "--apply"),
      h("strong", {}, ": the default is a dry run that plans only."),
      " Every command below carries it. A dry run is worth doing first if you want to see the plan, and it exits 0 having written no files, so read the plan rather than the exit code to tell the two apart. The valid sinks are ",
      h("code", { class: "mono" }, "file"),
      ", ",
      h("code", { class: "mono" }, "env"),
      " and ",
      h("code", { class: "mono" }, "discard"),
      "; anything else, including ",
      h("code", { class: "mono" }, "stdout"),
      ", exits with a usage error. The default sink is ",
      h("code", { class: "mono" }, "--sink file"),
      " with an ",
      h("code", { class: "mono" }, "--out <dir>"),
      " directory. ",
      h("code", { class: "mono" }, "--sink env"),
      " writes dotenv ",
      h("code", { class: "mono" }, "KEY='value'"),
      " lines to stdout, refusing to redefine any variable already set in your current environment. ",
      h("code", { class: "mono" }, "--sink discard"),
      " decrypts and verifies every record but writes nothing, for a restorability check that must never put plaintext on disk or in a terminal.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "Local archive, restore to a local directory:",
    ),
  );
  out.push(codeBlock(
    "downpipe restore \\\n  --apply \\\n  --run <runId> \\\n  --archive <dir> \\\n  --identity identity.key \\\n  --signer signer.pub \\\n  --sink file \\\n  --out ./restored \\\n  --receipt receipt.json",
    { copyLabel: "Copy restore to directory (local)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "Local archive, with the signer fingerprint from your printed sheet instead of signer.pub (reader 0.3.4 on, a bucket with a run written to it, and a run sealed since your last re-key):",
    ),
  );
  out.push(codeBlock(
    "downpipe restore \\\n  --apply \\\n  --run <runId> \\\n  --archive <dir> \\\n  --identity identity.key \\\n  --signer-fingerprint <signer-fingerprint-from-sheet> \\\n  --sink file \\\n  --out ./restored \\\n  --receipt receipt.json",
    { copyLabel: "Copy restore with the sheet fingerprint (local)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "S3/R2 archive, restore to a local directory:",
    ),
  );
  out.push(codeBlock(
    "export AWS_ACCESS_KEY_ID=<r2-access-key-id>\nexport AWS_SECRET_ACCESS_KEY=<r2-secret-access-key>\n\ndownpipe restore \\\n  --apply \\\n  --run <runId> \\\n  --s3-endpoint https://<account-id>.r2.cloudflarestorage.com \\\n  --s3-bucket <bucket-name> \\\n  --identity identity.key \\\n  --signer signer.pub \\\n  --sink file \\\n  --out ./restored \\\n  --receipt receipt.json",
    { copyLabel: "Copy restore (S3/R2)" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2);font-weight:var(--weight-semibold)" },
      "Restore to dotenv lines (to feed into ",
      h("code", { class: "mono" }, "wrangler secret put"),
      " or an env file yourself):",
    ),
  );
  out.push(codeBlock(
    "downpipe restore \\\n  --apply \\\n  --run <runId> \\\n  --archive <dir> \\\n  --identity identity.key \\\n  --signer signer.pub \\\n  --sink env",
    { copyLabel: "Copy restore to dotenv" },
  ));

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "After a successful restore, retain the receipt (receipt.json) as the record of what was restored, when, and under which key. It is tamper-evident when you signed it with --receipt-signer. Record the receipt hash in your incident log.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      h("strong", {}, "If the restore exits 13, your data is not corrupt."),
      " That code means every record that failed was a ",
      h("code", { class: "mono" }, "seg/"),
      " object the signed manifests name and this copy of the archive does not hold. Nothing failed a signature or an integrity check, and the receipt counts the absent paths as ",
      h("code", { class: "mono" }, "danglingSegments"),
      ". Fetch those objects from another copy of the bucket and run the restore again. Retrying against the same copy will keep failing, because the read was answered and the answer was that the object is not there. An absent object is not corruption.",
    ),
  );

  out.push(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "Exit 10 means the run restored and some records were not written, because the target could not take them. Those records are in the archive and are not on your disk, so read the named conflicts before you treat the recovery as complete. Exit 12 means every byte landed intact and this release cannot turn one of the D1 bodies into runnable SQL: keep the written file, do not feed it to ",
      h("code", { class: "mono" }, "sqlite3"),
      ", and restore again with a newer release.",
    ),
  );
  return out;
}

// renderAntiRollbackSection: the RUNLOG-index pin guidance and command block.
function renderAntiRollbackSection(): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-4)" }, "Anti-rollback: pin the RUNLOG index"));

  out.push(
    h("p", { class: "field__hint" },
      "The RUNLOG is a tamper-evident append-only chain: each run records its index and the previous run ID, so an attacker who deleted recent runs cannot substitute an older archive without detection. To make this protection operational, record the last-known RUNLOG index on your recovery sheet and pass it with ",
      h("code", { class: "mono" }, "--min-runlog-index"),
      " when running verify or restore. The CLI will reject any run whose RUNLOG maximum index is below that pin.",
    ),
  );
  out.push(codeBlock(
    "# Read the RUNLOG's highest chain index. attest prints it on its own runlog line, as max-index=<n>,\n# on stderr. inspect prints it only with --identity and --signer, and only when the freshness check passes.\n# attest needs no identity and no signer, so this works before you have found either.\ndownpipe attest --run <runId> --archive <dir>\n# In the Runs screen the same number is the index of the newest run sealed to that destination,\n# shown in its run detail's TITLE (\"<downpipe> run 42\") and in its URL, not as a row called \"Index\".\n# Copy the digits only: the title groups large numbers with separators.\n# Record that RUNLOG index as your --min-runlog-index pin for next time.\n# Do NOT use verify's \"<n> record(s)\" count: the pin is the chain index, not a record count.\n\n# Restore with the pinned index:\ndownpipe restore --apply --run <runId> --archive <dir> \\\n  --identity identity.key --signer signer.pub \\\n  --min-runlog-index <pinned-index> --sink file --out ./restored",
    { copyLabel: "Copy RUNLOG pinning commands" },
  ));
  return out;
}

// renderNavigationSection: the SPA-intercepted links to the topology map and costs screen for broader
// context. A full-page reload would drop the in-memory session state (the token fallback) for no reason.
function renderNavigationSection(): HTMLElement[] {
  return [
    h("p", { class: "field__hint", style: "margin-top:var(--space-4)" },
      "For a visual overview of which sources are protected and their current status, see the ",
      h(
        "a",
        { href: "/map", class: "linklike", on: { click: (ev: Event) => { ev.preventDefault(); navigate("/map"); } } },
        h("span", { "aria-hidden": "true" }, svgIcon(ICON_CHEVRON_RIGHT, { size: 12 })),
        "topology map",
      ),
      ". For estimated storage and recovery costs, see the ",
      h(
        "a",
        { href: "/costs", class: "linklike", on: { click: (ev: Event) => { ev.preventDefault(); navigate("/costs"); } } },
        h("span", { "aria-hidden": "true" }, svgIcon(ICON_CHEVRON_RIGHT, { size: 12 })),
        "costs screen",
      ),
      ".",
    ),
  ];
}
