// One voice for the four scripts here that can write into a repo they do not own.
//
// FS-WRITES: none outside this repo
//
// WHY THIS EXISTS. two separate passes lost work to the same shape. A pass ran
// `node scripts/field-census.mjs` because internal-docs/FIELD-CATALOGUE/CROSS-CHECK-PROTOCOL.md tells it
// to, in a section whose stated purpose is to LOOK ("your control must appear in the census"), and the run
// rewrote 81 lines of internal-docs belonging to another pass. A second pass found four derived artefacts
// sitting dirty in internal-docs after what it believed was a read-only gate run. Both were caught by luck:
// the finder happened to be holding internal-docs at that moment. Neither script said it was going to
// write, and nothing in the output made the write visible after the fact either, because "Wrote
// <absolute path>" scrolls past under a hundred lines of census summary.
//
// The cost was not the eighty lines. Several passes that evening declined to run these scripts at all
// rather than risk it, and the cross-check protocol that mandates them became something to work around.
//
// THE RULE. A run that writes outside this checkout has to be asked for, and it has to say so. Both halves
// matter separately: asking for it stops the accident, and saying so is what lets a caller who DID ask
// find and undo the write without going hunting through another repo's git status.
//
// The flag is spelled --write-internal-docs rather than --write, and that is deliberate rather than
// verbose. hook-census.mjs already had a --write, and it means "stamp data-dp attributes into console/src",
// an edit to THIS repo. A caller reading `--write` there reasonably concludes that the bare run writes
// nothing, and the bare run was writing another repository. A flag that names its destination cannot be
// read as the other one.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

export const OUTSIDE_WRITE_FLAG = "--write-internal-docs";

/** True when the caller explicitly asked for the write that lands outside this checkout. */
export function outsideWriteRequested(argv = process.argv) {
  return argv.includes(OUTSIDE_WRITE_FLAG);
}

const RULE = "  ------------------------------------------------------------------------------";

/**
 * Printed after a run that DID write outside this checkout. Names every path and hands back the command
 * that undoes it, because the caller is standing in console and the damage is in a sibling.
 */
export function announceOutsideWrites(tag, workspace, paths) {
  const lines = [
    "",
    RULE,
    `  ${tag}: THIS RUN WROTE OUTSIDE THIS REPOSITORY (${paths.length} path${paths.length === 1 ? "" : "s"}).`,
    RULE,
  ];
  for (const p of paths) lines.push(`    ${p}`);
  lines.push("");
  lines.push("  These belong to internal-docs, which another agent may be holding. To undo:");
  lines.push(`    git -C ${workspace}/internal-docs checkout -- ${paths.map((p) => p.replace(/^.*internal-docs\//, "")).join(" ")}`);
  lines.push("  To keep them, land internal-docs in the required DERIVED-artefact order.");
  lines.push(RULE);
  lines.push("");
  console.log(lines.join("\n"));
}

/**
 * Printed after a run that did NOT write, naming the paths a --write-internal-docs run would have touched.
 *
 * This half is not politeness. A caller following the two-command refresh in CROSS-CHECK-PROTOCOL.md and
 * getting silence would land a console change against a census that never regenerated, and the gate would
 * then report drift with no visible cause. Saying which paths were held, and with which flag to release
 * them, is what keeps a read-only default from turning one failure mode into another.
 */
export function announceOutsideWritesHeld(tag, paths) {
  const lines = [
    "",
    RULE,
    `  ${tag}: read-only run. Nothing outside this repository was written.`,
    RULE,
  ];
  for (const p of paths) lines.push(`    would write  ${p}`);
  lines.push("");
  lines.push(`  Pass ${OUTSIDE_WRITE_FLAG} to refresh the committed artefact(s) above.`);
  lines.push(RULE);
  lines.push("");
  console.log(lines.join("\n"));
}
