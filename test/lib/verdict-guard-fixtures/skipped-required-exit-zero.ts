// FIXTURE: a MANDATORY precondition absent, then the trailing explicit exit. Four skip sites in this repo
// (validate-engine-field-coverage, validate-source-type-parity, validate-cf-surface-split-parity and
// validate-visible-surface-counts) follow verdictSkipped with a bare process.exit(0) on the next line, so
// the moment any of them marks its engine sibling mandatory this is the shape that runs.
import { verdictSkipped } from "../verdict-guard.ts";
console.log("skipped-required fixture: the precondition it needs is absent");
verdictSkipped("no engine checkout reachable, and this environment requires one", { require: true });
process.exit(0);
