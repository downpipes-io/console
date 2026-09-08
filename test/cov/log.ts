// Coverage validator for the structured logging helper (src/log.ts): the single-line JSON
// emitter the console Worker uses for request logs. No existing
// validator imports this module (only src/worker.ts calls log() at its unhandled-request
// catch), so none of them drive the level routing (console.error for "error" versus
// console.log for everything else), the resolveEnv fallback arms, or the five optional-field
// guards that omit an undefined field from the JSON. This file drives the REAL module
// directly and asserts a real outcome for each path: the parsed JSON line, the chosen output
// stream, the resolved env value, and the presence or absence of each optional field.
//
// log() writes to console.log / console.error rather than returning a string, so we capture
// those two functions for the duration of each call, parse the emitted line, and inspect it.
// No DOM is needed (the module is pure), so the shared DOM shim is not used and not touched.
// Run with `node test/cov/log.ts` (the cov runner also invokes it).

import { type LogFields, type LogLevel, log } from "../../src/log.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// capture swaps console.log and console.error for the single log() call, records which stream
// received a line and the raw text, then restores the originals. It returns the captured line
// and the stream it landed on so each test can assert both the routing and the payload.
function capture(run: () => void): { stream: "log" | "error" | "none"; text: string } {
  const realLog = console.log;
  const realError = console.error;
  let stream: "log" | "error" | "none" = "none";
  let text = "";
  console.log = (line?: unknown): void => {
    stream = "log";
    text = String(line);
  };
  console.error = (line?: unknown): void => {
    stream = "error";
    text = String(line);
  };
  try {
    run();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { stream, text };
}

function main(): void {
  // An "error" level routes to console.error so the line lands on the error stream, and the
  // serialised line carries the fixed fields. This drives the error arm of the level branch.
  {
    const before = Date.now();
    const cap = capture(() => log("error", "request.unhandled", { status: 500 }, { ENVIRONMENT: "demo" }));
    ok("error level routes to the error stream", cap.stream === "error");
    const line = JSON.parse(cap.text) as Record<string, unknown>;
    ok("error line carries the level verbatim", line.level === "error");
    ok("error line carries the fixed service name", line.service === "console");
    ok("error line carries the event identifier", line.event === "request.unhandled");
    ok("error line carries the bound environment", line.env === "demo");
    ok("error line carries the status field when supplied", line.status === 500);
    ok("error line stamps an ISO8601 timestamp", typeof line.ts === "string" && line.ts.endsWith("Z"));
    const stamped = Date.parse(line.ts as string);
    ok("error line timestamp is a real time at or after the call", stamped >= before);
  }

  // A non-error level (every other LogLevel) routes to console.log. Drive the else arm with a
  // representative level and confirm the stream and the verbatim level.
  {
    const levels: LogLevel[] = ["warn", "info", "debug"];
    for (const level of levels) {
      const cap = capture(() => log(level, "request.ok"));
      ok(`${level} level routes to the standard stream`, cap.stream === "log");
      const line = JSON.parse(cap.text) as Record<string, unknown>;
      ok(`${level} line carries the level verbatim`, line.level === level);
    }
  }

  // resolveEnv falls back to "unknown" when env is undefined, and again when it is explicitly
  // null. Both arms of the optional-chaining fallback are exercised here.
  {
    const undef = capture(() => log("info", "boot"));
    const undefLine = JSON.parse(undef.text) as Record<string, unknown>;
    ok("env resolves to unknown when the binding is absent", undefLine.env === "unknown");

    const nul = capture(() => log("info", "boot", {}, null));
    const nulLine = JSON.parse(nul.text) as Record<string, unknown>;
    ok("env resolves to unknown when the binding is null", nulLine.env === "unknown");

    const bound = capture(() => log("info", "boot", {}, { ENVIRONMENT: "staging" }));
    const boundLine = JSON.parse(bound.text) as Record<string, unknown>;
    ok("env resolves to the bound value when present", boundLine.env === "staging");

    // An env object present but without ENVIRONMENT also falls back to "unknown" (the inner
    // arm of the nullish coalesce), and never throws.
    const emptyEnv = capture(() => log("info", "boot", {}, {}));
    const emptyEnvLine = JSON.parse(emptyEnv.text) as Record<string, unknown>;
    ok("env resolves to unknown when the binding omits ENVIRONMENT", emptyEnvLine.env === "unknown");
  }

  // The default fields parameter: omitting fields entirely uses the {} default, so the line
  // carries only the fixed keys and none of the five optional fields.
  {
    const cap = capture(() => log("info", "request.minimal"));
    const line = JSON.parse(cap.text) as Record<string, unknown>;
    ok("a minimal call omits method", !("method" in line));
    ok("a minimal call omits path", !("path" in line));
    ok("a minimal call omits status", !("status" in line));
    ok("a minimal call omits duration_ms", !("duration_ms" in line));
    ok("a minimal call omits error_code", !("error_code" in line));
    ok("a minimal call still carries the fixed keys", line.event === "request.minimal" && line.service === "console");
  }

  // Every optional field present drives the truthy side of all five undefined guards, and the
  // values pass through verbatim.
  {
    const fields: LogFields = {
      method: "POST",
      path: "/api/runs",
      status: 202,
      duration_ms: 17,
      error_code: "upstream_timeout",
    };
    const cap = capture(() => log("warn", "request.slow", fields, { ENVIRONMENT: "demo" }));
    const line = JSON.parse(cap.text) as Record<string, unknown>;
    ok("the method field passes through", line.method === "POST");
    ok("the path field passes through", line.path === "/api/runs");
    ok("the status field passes through", line.status === 202);
    ok("the duration_ms field passes through", line.duration_ms === 17);
    ok("the error_code field passes through", line.error_code === "upstream_timeout");
  }

  // Each guard independently: a single field present while the other four stay undefined, so the
  // false side of each of the other four guards is hit alongside the true side of the one under
  // test. status 0 and duration_ms 0 are deliberate so the guard tests for undefined, not falsy.
  {
    const onlyMethod = JSON.parse(capture(() => log("info", "e", { method: "GET" })).text) as Record<string, unknown>;
    ok("only-method keeps method and drops the rest", onlyMethod.method === "GET" && !("path" in onlyMethod) && !("status" in onlyMethod));

    const onlyPath = JSON.parse(capture(() => log("info", "e", { path: "/" })).text) as Record<string, unknown>;
    ok("only-path keeps path and drops the rest", onlyPath.path === "/" && !("method" in onlyPath) && !("status" in onlyPath));

    const zeroStatus = JSON.parse(capture(() => log("info", "e", { status: 0 })).text) as Record<string, unknown>;
    ok("a zero status is emitted (guard tests undefined, not falsy)", zeroStatus.status === 0 && "status" in zeroStatus);

    const zeroDuration = JSON.parse(capture(() => log("info", "e", { duration_ms: 0 })).text) as Record<string, unknown>;
    ok("a zero duration is emitted (guard tests undefined, not falsy)", zeroDuration.duration_ms === 0 && "duration_ms" in zeroDuration);

    const emptyCode = JSON.parse(capture(() => log("info", "e", { error_code: "" })).text) as Record<string, unknown>;
    ok("an empty error_code is emitted (guard tests undefined, not falsy)", emptyCode.error_code === "" && "error_code" in emptyCode);
  }

  if (failures > 0) process.exitCode = 1;

  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("\nLOG COVERAGE VECTORS PASS");
}

void main();
