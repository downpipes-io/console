// FIXTURE: the same drain, from a .mjs entry point. The console has one derived entry point that is not
// TypeScript (test/cov/run.mjs, the coverage runner), so the guard has to be importable from plain ESM as
// well. Node 22.23.1 resolves the .ts specifier from a .mjs importer under its own type stripping, and
// that is measured here rather than assumed, because CI pins Node 22 while this box defaults to 25.
import { verdictReached } from "../verdict-guard.ts";
let failures = 0;
const ok = (l, c) => { console.log(`  ${c ? "ok  " : "FAIL"} ${l}`); if (!c) failures++; };
async function main() {
  ok("an assertion that fails", false);
  await new Promise(() => {});
  verdictReached(failures);
}
main().catch((e) => { console.error(e); process.exit(1); });
