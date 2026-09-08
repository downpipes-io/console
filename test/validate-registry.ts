// Validate the command-registry RBAC filtering (src/shell/registry.ts): visibleCommands and the
// requireRole / requireCap / hasDownpipes gates baked into the COMMANDS `when` predicates. These are the
// CLIENT MIRROR of the engine's per-route RBAC gates; the engine is always the enforcement point, but a
// regression here (a null-caller check dropped, a capability renamed, a role ladder inverted) would either
// leak a gated command to a role that should not see it, or hide one that should be visible, breaking the
// "no palette entry that 403s" invariant. validate-palette.ts exercises routing and structural duplicate
// checks; this file fills the role-based-filtering gap.
//
// Run with `node test/validate-registry.ts`. No DOM: registry.ts is pure (role + state predicates over
// plain data), so the registry imports succeed in Node and the functions are callable directly.
//
// Coverage (the audit's required scenarios):
//   - visibleCommands with a null caller returns ONLY commands with no `when` (fail-closed);
//   - a viewer sees the navigation commands but not the operator-gated mutating commands;
//   - the requireCap gates (notify.config, posture.read) pass/fail correctly against the role's caps;
//   - the hasDownpipes gate suppresses the restore commands when downpipeCount is 0.

import { COMMANDS, visibleCommands, type CommandContext, type EngineState } from "../src/shell/registry.ts";
import type { Caller, CustomRole, Role } from "../src/api.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A minimal Caller stub for a built-in role (no custom role: authority falls back to can(role, cap)).
function callerOf(role: Role): Caller {
  return { method: "token", email: null, role, groups: [], isOnlyOwner: false };
}

function ctx(caller: Caller | null, engine: EngineState = {}): CommandContext {
  return { caller, engine };
}

function ids(cmds: { id: string }[]): Set<string> {
  return new Set(cmds.map((c) => c.id));
}

// ---------------------------------------------------------------------------
// (1) Null caller (whoami pending) -> only the ungated commands. Every gated command fails closed.
// ---------------------------------------------------------------------------
console.log("\n-- registry: null caller sees only ungated commands (fail-closed) --");
{
  const visible = visibleCommands(ctx(null, { downpipeCount: 5 }));
  const ungatedCount = COMMANDS.filter((c) => c.when === undefined).length;
  ok("a null caller sees exactly the commands with no `when` gate", visible.length === ungatedCount && visible.every((c) => c.when === undefined));
  const v = ids(visible);
  ok("a null caller does NOT see create-downpipe (operator-gated)", !v.has("create-downpipe"));
  ok("a null caller does NOT see request-restore (operator + hasDownpipes)", !v.has("request-restore"));
  ok("a null caller does NOT see configure-notify-rules (notify.config)", !v.has("configure-notify-rules"));
  ok("a null caller DOES see go-overview (ungated navigation)", v.has("go-overview"));
}

// ---------------------------------------------------------------------------
// (2) A viewer sees navigation but not the operator-gated mutating commands.
// ---------------------------------------------------------------------------
console.log("\n-- registry: viewer sees navigation, not operator-gated mutations --");
{
  const visible = ids(visibleCommands(ctx(callerOf("viewer"), { downpipeCount: 5 })));
  ok("a viewer sees go-downpipes (navigation, ungated)", visible.has("go-downpipes"));
  ok("a viewer sees review-posture (posture.read is in the read floor)", visible.has("review-posture"));
  ok("a viewer does NOT see create-downpipe (operator-gated mutation)", !visible.has("create-downpipe"));
  ok("a viewer does NOT see request-restore (operator-gated)", !visible.has("request-restore"));
  ok("a viewer does NOT see apply-restore (approver-gated)", !visible.has("apply-restore"));
  ok("a viewer does NOT see configure-notify-rules (notify.config not in the read floor)", !visible.has("configure-notify-rules"));
}

// ---------------------------------------------------------------------------
// (3) The requireCap gates pass and fail correctly against the role's capability table.
// ---------------------------------------------------------------------------
console.log("\n-- registry: requireCap gates (notify.config, posture.read) --");
{
  // notify.config: an operator can configure alerting; a viewer cannot.
  const operatorSees = ids(visibleCommands(ctx(callerOf("operator"), { downpipeCount: 1 })));
  ok("an operator sees configure-notify-rules (holds notify.config)", operatorSees.has("configure-notify-rules"));
  const viewerSees = ids(visibleCommands(ctx(callerOf("viewer"), { downpipeCount: 1 })));
  ok("a viewer does not see configure-notify-rules (lacks notify.config)", !viewerSees.has("configure-notify-rules"));

  // posture.read: in the read floor, so EVERY built-in role sees review-posture.
  const roles: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];
  const allSeePosture = roles.every((r) => ids(visibleCommands(ctx(callerOf(r), { downpipeCount: 1 }))).has("review-posture"));
  ok("every built-in role sees review-posture (posture.read is universal)", allSeePosture);
}

// ---------------------------------------------------------------------------
// (3b) requireCap resolves a NAMED custom role by its capability set, not the "viewer" floor.
// ---------------------------------------------------------------------------
console.log("\n-- registry: requireCap honours a named custom role --");
{
  // A custom role pinned to role=viewer (the engine floor) but holding downpipe.write. The palette's
  // create-downpipe command gates on requireCap("downpipe.write"); it used to read can("viewer", ...) and
  // wrongly hid the command from this holder. It must now be visible, WITHOUT the holder gaining anything
  // its capability set does not list (apply-restore, on restore.apply, stays hidden).
  const customRole: CustomRole = {
    name: "backup-operator", label: "Backup Operator", capabilities: ["downpipe.write"],
    surface: {}, presentation: "technical", landing: "overview",
    createdBy: "owner@example.com", createdAt: "2026-07-21T00:00:00.000Z",
  };
  const customCaller: Caller = {
    method: "passkey", email: "custom@example.com", role: "viewer", groups: [], isOnlyOwner: false,
    customRole, customCapabilities: ["downpipe.write"],
  };
  const customSees = ids(visibleCommands(ctx(customCaller, { downpipeCount: 2 })));
  ok("a downpipe.write custom role SEES create-downpipe (requireCap resolves the effective set)", customSees.has("create-downpipe"));
  ok("the same holder still does NOT see apply-restore (restore.apply not in its set -- no escalation)", !customSees.has("apply-restore"));
  ok("the same holder still does NOT see configure-notify-rules (notify.config not in its set)", !customSees.has("configure-notify-rules"));
  // A built-in viewer (no custom role) is unaffected: create-downpipe stays hidden (callerCan(role,cap,null) === can).
  ok("a plain viewer is unchanged -- create-downpipe still hidden", !ids(visibleCommands(ctx(callerOf("viewer"), { downpipeCount: 2 }))).has("create-downpipe"));
}

// ---------------------------------------------------------------------------
// (4) hasDownpipes suppresses the restore commands when downpipeCount is 0.
// ---------------------------------------------------------------------------
console.log("\n-- registry: hasDownpipes gate on the restore commands --");
{
  // With NO downpipes, even an approver (who clears the role gate) does not see the restore commands.
  const noDownpipes = ids(visibleCommands(ctx(callerOf("approver"), { downpipeCount: 0 })));
  ok("request-restore is hidden when downpipeCount is 0", !noDownpipes.has("request-restore"));
  ok("apply-restore is hidden when downpipeCount is 0", !noDownpipes.has("apply-restore"));

  // With downpipes present, the role gate alone decides: an approver sees both; an operator sees only
  // request-restore (apply is approver+).
  const approverWith = ids(visibleCommands(ctx(callerOf("approver"), { downpipeCount: 2 })));
  ok("an approver with downpipes sees request-restore", approverWith.has("request-restore"));
  ok("an approver with downpipes sees apply-restore", approverWith.has("apply-restore"));
  const operatorWith = ids(visibleCommands(ctx(callerOf("operator"), { downpipeCount: 2 })));
  ok("an operator with downpipes sees request-restore", operatorWith.has("request-restore"));
  ok("an operator with downpipes does NOT see apply-restore (approver+)", !operatorWith.has("apply-restore"));

  // An undefined downpipeCount is treated as 0 (the ?? 0 fallback), so the restore commands stay hidden.
  const undefinedCount = ids(visibleCommands(ctx(callerOf("approver"), {})));
  ok("an undefined downpipeCount suppresses request-restore (treated as 0)", !undefinedCount.has("request-restore"));
}

console.log(failures === 0 ? "\nREGISTRY VALIDATORS PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1; // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
