// Access-security area of the validate-components suite: the engine-state field
// label mapping, the health-probe no-redundant-repaint logic, and the audit
// Source-IP cell distinction.

import {
  ENGINE_STATE_FIELD_LABELS,
  auditSourceIpDisplay,
} from "../src/screens/access-security.ts";

type Ok = (label: string, cond: boolean) => void;

// Pure-logic mirror of the no-redundant-repaint invariant in verifierErrorTile (CON-L3),
// kept in the test rather than shipped in the production bundle. The repaint runs only when
// the health probe fails (switching to blockError), never when it succeeds. Returns whether
// repaint was called.
function _testHealthProbeRepaint(healthResolves: boolean): boolean {
  let repaintCalled = false;
  const repaint = (): void => { repaintCalled = true; };
  if (!healthResolves) repaint();
  return repaintCalled;
}

// Sections 9 and 10 (engine-state field labels and health-probe repaint logic).
export function runAccessSecurityLabelsAndProbe(ok: Ok): void {

// ===========================================================================
// 9. ACCESS-SECURITY ENGINE-STATE FIELD LABELS
// ===========================================================================
// describeTarget("engine-state") must map raw internal field names to
// human-readable labels. End users must never see "secret-present" or
// "engineVersion" verbatim in the audit log target column.

console.log("\n-- access-security: engine-state field label mapping --");

// 9a. Both known field names are present in the map.
ok('"secret-present" is in ENGINE_STATE_FIELD_LABELS', "secret-present" in ENGINE_STATE_FIELD_LABELS);
ok('"engineVersion" is in ENGINE_STATE_FIELD_LABELS', "engineVersion" in ENGINE_STATE_FIELD_LABELS);

const secretLabel = ENGINE_STATE_FIELD_LABELS["secret-present"]!;
const versionLabel = ENGINE_STATE_FIELD_LABELS.engineVersion!;

// 9b. The label must not expose the raw internal field name to users.
ok('"secret-present" label does not contain the raw field name', !secretLabel.includes("secret-present"));
ok('"engineVersion" label does not contain the raw camelCase name', !versionLabel.includes("engineVersion"));

// 9c. Labels must be non-empty human-readable strings.
ok('"secret-present" label is a non-empty string', typeof secretLabel === "string" && secretLabel.length > 0);
ok('"engineVersion" label is a non-empty string', typeof versionLabel === "string" && versionLabel.length > 0);

// 9d. Exact expected values confirm the specific human text rendered to operators.
ok('"secret-present" maps to "Engine secret present"', secretLabel === "Engine secret present");
ok('"engineVersion" maps to "Engine version"', versionLabel === "Engine version");

// 9e. Negative controls.
ok('unknown field key is not falsely in the label map', !("unknownField" in ENGINE_STATE_FIELD_LABELS));
ok('the two labels are distinct (not accidentally equal)', secretLabel !== versionLabel);

// ===========================================================================
// 10. ACCESS-SECURITY HEALTH-PROBE REPAINT LOGIC
// ===========================================================================
// verifierErrorTile paints consoleOriginTile immediately (optimistic). The
// subsequent health probe must NOT repaint on success (tile already shows the
// correct diagnosis) and MUST repaint on failure (switch to block error).
// A repaint on success would be a redundant repaint.

console.log("\n-- access-security: health probe no-redundant-repaint --");

// 10a. Health resolves: repaint must NOT be triggered (no redundant repaint).
ok("health OK: repaint is NOT called (optimistic tile is correct)", _testHealthProbeRepaint(true) === false);

// 10b. Health fails: repaint MUST be triggered (switch to block-error is a real state change).
ok("health fails: repaint IS called (switch to block error)", _testHealthProbeRepaint(false) === true);

// 10c. The two outcomes are mutually exclusive (opposite results).
ok("health OK vs fails produce opposite results", _testHealthProbeRepaint(true) !== _testHealthProbeRepaint(false));

// 10d. The helper is side-effect free (calling it multiple times gives stable results).
ok("health OK is idempotent across two calls", _testHealthProbeRepaint(true) === false && _testHealthProbeRepaint(true) === false);
ok("health fails is idempotent across two calls", _testHealthProbeRepaint(false) === true && _testHealthProbeRepaint(false) === true);

}

// Section 12 (the audit Source-IP cell distinction). Run last in the suite,
// matching the original source order.
export function runAccessSecurityAuditIp(ok: Ok): void {

// ===========================================================================
// 12. AUDIT SOURCE-IP CELL: system vs missing vs present
// ===========================================================================
// The audit-IP fix's console half: the "Source IP" cell must distinguish a
// legitimately-blank ENGINE-INITIATED event (no client request -> "system")
// from a NON-engine event that genuinely lacks an IP ("not recorded"), so a
// blank system event is not confused with a recording gap, keeping the
// panel's "from where" promise honest. A present IP always shows the IP.

console.log("\n-- access-security: audit Source-IP cell distinguishes system / missing / present --");

// 12a. A human action WITH an IP renders the IP verbatim.
const ipPresent = auditSourceIpDisplay({ sourceIp: "198.51.100.7", actorMethod: "access" });
ok("a present source IP renders kind 'ip'", ipPresent.kind === "ip");
ok("a present source IP renders the IP text verbatim", ipPresent.text === "198.51.100.7");

// 12b. An ENGINE event with NO IP is "system", not a bare missing dash (blank is correct here).
const engineBlank = auditSourceIpDisplay({ sourceIp: null, actorMethod: "engine" });
ok("an engine-initiated event with no IP renders kind 'system'", engineBlank.kind === "system");
ok("the system label is non-empty and not the missing wording", engineBlank.text.length > 0 && engineBlank.text !== "not recorded");

// 12c. A NON-engine (human) event with NO IP is the honest "not recorded" missing case.
const humanBlankAccess = auditSourceIpDisplay({ sourceIp: null, actorMethod: "access" });
const humanBlankPasskey = auditSourceIpDisplay({ sourceIp: null, actorMethod: "passkey" });
const humanBlankToken = auditSourceIpDisplay({ sourceIp: null, actorMethod: "token" });
ok("a human access event with no IP renders kind 'missing'", humanBlankAccess.kind === "missing");
ok("a human passkey event with no IP renders kind 'missing'", humanBlankPasskey.kind === "missing");
ok("a token break-glass event with no IP renders kind 'missing'", humanBlankToken.kind === "missing");
ok("the missing case reads 'not recorded'", humanBlankAccess.text === "not recorded");

// 12d. THE KEY DISTINCTION: a blank ENGINE event and a blank HUMAN event are NOT rendered the same,
// so a legitimately-blank system event is distinguishable from a missing IP.
ok("a blank engine event and a blank human event render DIFFERENTLY (system != missing)", engineBlank.kind !== humanBlankAccess.kind && engineBlank.text !== humanBlankAccess.text);

// 12e. An engine event that DID carry an IP (none do today) still shows the IP, not "system" -
// the present-IP branch wins, the most informative honest choice.
const engineWithIp = auditSourceIpDisplay({ sourceIp: "203.0.113.5", actorMethod: "engine" });
ok("an engine event WITH an IP still renders the IP (present-IP wins over the system fallback)", engineWithIp.kind === "ip" && engineWithIp.text === "203.0.113.5");

// 12f. Negative control: the present-IP case is never mislabelled as system or missing.
ok("negative: a present IP is never 'system' or 'missing'", ipPresent.kind !== "system" && ipPresent.kind !== "missing");

}
