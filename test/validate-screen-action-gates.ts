// Every SCREEN-OWNED palette command must gate on CAPABILITY, never on a role NAME.
//
// WHY THIS EXISTS
// ---------------
// A role-NAME gate was hiding a control the engine would have allowed: the restore apply/request
// panel read canDo("approver"), a cumulative rank ladder, while the engine reads the restore.apply
// CAPABILITY, which restore-operator holds while sitting off that ladder at rank 0. The panel was fixed
// (screens/restore-flow/confirm.ts) and locked by validate-api-flows-restore.ts SECTION 6R/6S.
//
// The same defect survived one layer up, in the screen DESCRIPTORS' `when` gates, because nothing drove
// them. validate-registry.ts covers shell/registry.ts COMMANDS only; the screen-owned actions assembled by
// allScreenActions() (the ones the palette, the go-to chords and the "?" cheat-sheet all read) had no
// role-based test of any kind. Six of them still enumerated role names, and two were restore surfaces:
// "Review pending restore approvals" and the Overview approvals reads, both excluding restore-operator,
// the recovery-only role that holds restore.approve and restore.request.
//
// WHAT IT ASSERTS, AND WHY IT NEEDS NO MAINTAINED TABLE
// ----------------------------------------------------
// A capability gate is a function of the caller's EFFECTIVE CAPABILITY SET and nothing else. So: build two
// callers with DIFFERENT role names and IDENTICAL effective sets, and every gate must return the same
// verdict for both. The twin is a NAMED CUSTOM ROLE carrying the built-in role's capabilities, which is
// exactly the shape the engine issues (role pinned to the "viewer" floor, real authority in the capability
// set). A gate that reads c.role by name, or that reads ROLE_CAPABILITIES[c.role] directly, disagrees on
// that pair and fails here. No per-command expectation is written down, so the check cannot rot.
//
// Owner is EXCLUDED from the pairing, and honestly: keys.ceremony and posture.riskaccept are
// owner-reserved and capabilitiesOfCustomRole strips them at read time, so an owner twin does not have an
// identical set and the premise does not hold. The validator proves the exclusion is exactly that one
// role rather than assuming it.
//
// Plus three properties the pairing alone cannot see:
//   - fail-closed: every gated action hides for a null caller (whoami still pending);
//   - non-vacuity: it examined gated actions at all, some pair was comparable, and the gates actually
//     DISCRIMINATE (a build where every gate returned true would otherwise pass every pairing);
//   - the two named regressions, asserted against restore-operator by id, with the ids' presence
//     asserted first so a rename fails loudly instead of silently dropping the check.
//
// Run with `node test/validate-screen-action-gates.ts`.

import { installDomShim } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

installDomShim();

const checks = makeChecks();
const { ok, eq } = checks;

const { SCREENS } = await import("../src/lib/app-registry.ts");
const { overviewScreen } = await import("../src/screens/overview.ts");
const { allScreenActions } = await import("../src/screens/common.ts");
const { ROLE_CAPABILITIES } = await import("../src/lib/identity.ts");
const { capabilitiesOfCustomRole } = await import("../src/lib/identity-custom-roles.ts");

type Role = import("../src/lib/identity.ts").Role;
type Capability = import("../src/lib/identity.ts").Capability;
type CustomRole = import("../src/lib/identity-custom-roles.ts").CustomRole;
type Caller = import("../src/api.ts").Caller;
type ScreenAction = import("../src/screens/common.ts").ScreenAction;

// The assembled screen-owned action set, exactly as app-registry.ts feeds the palette
// (overviewScreen is route-bound separately, so it is prepended there and here).
const ACTIONS: ScreenAction[] = allScreenActions([overviewScreen, ...SCREENS]);
const GATED: ScreenAction[] = ACTIONS.filter((a) => a.when !== undefined);

// The engine state a `when` may read. Held permissive so a gate's ENGINE half never masks its ROLE half:
// the pairing below varies only the caller, so any disagreement is attributable to the identity.
const ENGINE_STATE = { ready: true, downpipeCount: 5, updateAvailable: true, connected: true };

function builtinCaller(role: Role): Caller {
  return { method: "access", email: "someone@example.com", role, groups: [], isOnlyOwner: false };
}

// twinCaller is the SAME AUTHORITY carried the other way: a named custom role whose capability list is the
// built-in role's set, with the role field pinned to "viewer" exactly as the engine pins it (identity.ts
// WhoAmI: "role is the 'viewer' floor in this case; the capability set is the real authority").
function twinCaller(role: Role): Caller {
  const custom: CustomRole = {
    name: `twin-${role}`,
    label: `Twin of ${role}`,
    capabilities: [...ROLE_CAPABILITIES[role]],
    surface: {},
    presentation: "technical",
    landing: "/",
    createdBy: null,
    createdAt: "2026-07-29T00:00:00.000Z",
  };
  return {
    method: "access",
    email: "someone@example.com",
    role: "viewer",
    groups: [],
    isOnlyOwner: false,
    customRole: custom,
    customCapabilities: [...capabilitiesOfCustomRole(custom)],
  };
}

function sameSet(a: ReadonlySet<Capability>, b: ReadonlySet<Capability>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// verdicts runs every gated action's `when` over one caller and hands BACK the caller it was given
// alongside the verdicts. Returning the subject is not decoration: the pairing below asserts that its two
// runs genuinely saw two DIFFERENT identities, which is the one way to catch the mutation that turns this
// whole file into a tautology (pass the built-in caller to both runs and every "same verdict" assertion
// passes while nothing is compared). That mutation is applied and required to go red in the sweep.
interface Run {
  seen: Map<string, boolean>;
  subject: Caller | null;
}

function verdicts(caller: Caller | null): Run {
  const seen = new Map<string, boolean>();
  for (const a of GATED) seen.set(a.id, a.when ? a.when({ caller, engine: ENGINE_STATE }) : true);
  return { seen, subject: caller };
}

const ALL_ROLES: Role[] = ["viewer", "operator", "restore-operator", "approver", "access-admin", "owner"];

// ---------------------------------------------------------------------------
// (0) Non-vacuity: there is something to check, and the gates are not all-permissive.
// ---------------------------------------------------------------------------
console.log("\n-- screen-action gates: the set under test is real --");
ok(`the assembled screen action set is non-empty (${ACTIONS.length} actions)`, ACTIONS.length > 0);
ok(`some screen actions carry a \`when\` gate (${GATED.length} gated)`, GATED.length > 0);
{
  // A build in which every gate returned true for everyone would satisfy every pairing below without
  // gating anything. Require that at least one gated action is HIDDEN from a viewer and SHOWN to an owner,
  // so the pairing is being applied to gates that genuinely discriminate.
  const viewerSees = verdicts(builtinCaller("viewer"));
  const ownerSees = verdicts(builtinCaller("owner"));
  const discriminating = GATED.filter((a) => ownerSees.seen.get(a.id) === true && viewerSees.seen.get(a.id) === false);
  ok(
    `at least one gated action discriminates owner from viewer (${discriminating.length} do)`,
    discriminating.length > 0,
  );
}

// ---------------------------------------------------------------------------
// (1) Fail-closed: a null caller (whoami still in flight) sees no gated action that reads identity.
// ---------------------------------------------------------------------------
console.log("\n-- screen-action gates: a null caller fails closed --");
{
  const nullSees = verdicts(null);
  // An engine-only gate (e.g. "the engine is connected") legitimately passes with no caller, so the
  // assertion is scoped to the gates that DO read identity, identified as those a viewer and an owner do
  // not both pass identically... which would be circular. Instead: assert directly that no gated action
  // visible to a null caller is one that an owner-versus-viewer comparison shows to be identity-gated.
  const viewerSees = verdicts(builtinCaller("viewer"));
  const ownerSees = verdicts(builtinCaller("owner"));
  const identityGated = GATED.filter((a) => viewerSees.seen.get(a.id) !== ownerSees.seen.get(a.id));
  ok(`some gated actions are identity-gated (${identityGated.length})`, identityGated.length > 0);
  for (const a of identityGated) {
    ok(`${a.id}: hidden from a null caller (whoami pending)`, nullSees.seen.get(a.id) === false);
  }
}

// ---------------------------------------------------------------------------
// (2) THE INVARIANT: a gate is a function of the capability SET, not of the role NAME.
// ---------------------------------------------------------------------------
console.log("\n-- screen-action gates: identical authority, different role name, identical verdict --");
{
  let comparedRoles = 0;
  const skippedRoles: Role[] = [];
  for (const role of ALL_ROLES) {
    const twin = twinCaller(role);
    const twinSet = capabilitiesOfCustomRole(twin.customRole as CustomRole);
    if (!sameSet(ROLE_CAPABILITIES[role], twinSet)) {
      // The owner-reserved bar makes an identical twin impossible; recorded, not silently skipped.
      skippedRoles.push(role);
      continue;
    }
    comparedRoles++;
    const builtinSees = verdicts(builtinCaller(role));
    const twinSees = verdicts(twin);
    // THE SELF-CHECK. Every assertion below compares two runs, so the file is only worth anything if the
    // two runs saw two DIFFERENT identities. Assert that from the subjects the runs actually carried: the
    // built-in run must be on the named built-in role with no custom role, and the twin run must be on a
    // named custom role pinned to the viewer floor. Hand both runs the same caller and this fails, which
    // is the tautology mutant the sweep applies.
    ok(
      `${role}: the pairing ran over two DIFFERENT identities (built-in "${role}" vs a named custom role)`,
      builtinSees.subject !== null
        && twinSees.subject !== null
        && builtinSees.subject.customRole === undefined
        && builtinSees.subject.role === role
        && twinSees.subject.customRole !== undefined
        && twinSees.subject.role === "viewer",
    );
    for (const a of GATED) {
      const b = builtinSees.seen.get(a.id);
      const t = twinSees.seen.get(a.id);
      ok(
        `${a.id}: same verdict for built-in "${role}" and a custom role holding the same capabilities (${String(b)})`,
        b === t,
      );
    }
  }
  ok(`the pairing ran for more than one role (${comparedRoles} compared)`, comparedRoles > 1);
  eq(
    "owner is the ONLY role excluded from the pairing (keys.ceremony / posture.riskaccept are owner-reserved)",
    skippedRoles.join(","),
    "owner",
  );
}

// ---------------------------------------------------------------------------
// (3) The two named regressions, by id, against the role they are about.
// ---------------------------------------------------------------------------
console.log("\n-- screen-action gates: restore-operator reaches the recovery commands --");
{
  const ids = new Set(ACTIONS.map((a) => a.id));
  // Assert the ids EXIST before asserting anything about them: a renamed command must fail here rather
  // than quietly turn the two checks below into assertions about nothing.
  ok('the "restore.approvals" command is still in the assembled set', ids.has("restore.approvals"));
  ok('the "overview.drill-fleet" command is still in the assembled set', ids.has("overview.drill-fleet"));

  const ro = verdicts(builtinCaller("restore-operator"));
  // restore-operator holds restore.approve AND restore.request (identity-model.ts ROLE_CAPABILITIES,
  // byte-equal to engine/src/admin/identity-rbac.ts), so the dual-control inbox is its own surface: the
  // engine gates POST /restore/approve and /restore/reject on restore.approve.
  ok(
    "restore-operator sees the restore approvals command (holds restore.approve + restore.request)",
    ro.seen.get("restore.approvals") === true,
  );
  // restore-operator holds drill.run, and the Overview's own Drill all button already gated on it
  // (overview/view.ts canCap("drill.run")) while this palette entry to the SAME action did not.
  ok(
    "restore-operator sees the fleet drill command (holds drill.run, as the on-screen button already read)",
    ro.seen.get("overview.drill-fleet") === true,
  );
  // The other side of the same gate: a role that holds neither must still be refused, so the fix widened
  // the gate to the capability rather than removing it.
  const aa = verdicts(builtinCaller("access-admin"));
  ok("access-admin does NOT see the restore approvals command (holds no restore capability)", aa.seen.get("restore.approvals") === false);
  ok("access-admin does NOT see the fleet drill command (does not hold drill.run)", aa.seen.get("overview.drill-fleet") === false);
  const viewer = verdicts(builtinCaller("viewer"));
  ok("a viewer does NOT see the restore approvals command", viewer.seen.get("restore.approvals") === false);
  ok("a viewer does NOT see the fleet drill command", viewer.seen.get("overview.drill-fleet") === false);
}

// ---------------------------------------------------------------------------
// (4) The SAME defect off the palette: the Overview's two restore-approval gates.
//
// These are not screen actions, so the pairing above cannot see them, and they are the pair that costs
// the operator the most: fetch.ts decides whether the approvals inbox is READ at all, and recovery.ts
// decides whether the "N restores awaiting approval" item is offered. Both keyed on a role NAME
// (approver/owner), both excluding restore-operator, which holds restore.approve. The read gate is the
// outer one: with it closed the item below cannot fire whatever its own gate says, so both are driven.
// ---------------------------------------------------------------------------
console.log("\n-- overview: the restore-approvals read and the needs-me item follow restore.approve --");
{
  const { setCaller, setWhoamiAvailable } = await import("../src/lib/store.ts");
  const { collectNeedsItems } = await import("../src/screens/overview/recovery.ts");
  const { summariseFleet } = await import("../src/screens/overview/fleet-data.ts");
  const { fetchOverviewData } = await import("../src/screens/overview/fetch.ts");
  type OverviewData = import("../src/screens/overview/shared.ts").OverviewData;
  type EngineClient = import("../src/api.ts").EngineClient;

  // A benign engine stub that records which reads were asked for. Every method answers one shape that
  // satisfies all of fetchOverviewData's continuations (.byDownpipe, .events); settle() absorbs the rest.
  function recordingEngine(): { engine: EngineClient; called: Set<string> } {
    const called = new Set<string>();
    const answer = { byDownpipe: {}, events: [], ok: true, bound: { kv: [], r2: [], d1: [], secrets: [] } };
    const engine = new Proxy({}, {
      get(_t, prop: string) {
        return (..._args: unknown[]) => {
          called.add(prop);
          return Promise.resolve(answer);
        };
      },
    }) as unknown as EngineClient;
    return { engine, called };
  }

  // One pending approval, so the needs-me item has something real to be about (it is deliberately
  // silent on an empty inbox, and an item that never fires would prove nothing either way).
  const pending = [{ id: "ap_1", runId: "run_1", planHash: "abc", status: "requested", requestedBy: "someone@example.com", approvedBy: null, requestedAt: "2026-07-29T00:00:00.000Z" }];
  const data = {
    health: { ok: true, value: { ok: true } },
    status: { ok: false, error: new Error("not needed") },
    licence: { ok: false, error: new Error("not needed") },
    updates: { ok: true, value: { configured: true, verified: true, currentVersion: "0.0.0" } },
    history: { ok: true, value: {} },
    downpipes: { ok: true, value: [] },
    drillEvidence: { ok: true, value: [] },
    audit: { ok: true, value: [] },
    approvals: { ok: true, value: pending },
    discovery: { ok: false, error: new Error("not needed") },
  } as unknown as OverviewData;
  const fleet = summariseFleet(data);

  const awaitingItem = (): boolean =>
    collectNeedsItems(data, fleet).some((i) => i.title.includes("awaiting approval"));

  setWhoamiAvailable(true);

  // restore-operator: holds restore.approve (identity-model.ts), so both gates must open.
  setCaller(builtinCaller("restore-operator"));
  const roRun = recordingEngine();
  await fetchOverviewData(roRun.engine, null);
  ok("restore-operator: the Overview READS the approvals inbox (holds restore.approve)", roRun.called.has("listApprovals"));
  ok("restore-operator: the needs-me item offers the pending approval", awaitingItem());

  // approver: the role the old name-list allowed, still allowed. Proves the fix widened the gate
  // rather than swapping which role it excluded.
  setCaller(builtinCaller("approver"));
  const apRun = recordingEngine();
  await fetchOverviewData(apRun.engine, null);
  ok("approver: the Overview still READS the approvals inbox", apRun.called.has("listApprovals"));
  ok("approver: the needs-me item still offers the pending approval", awaitingItem());

  // viewer: holds no restore.approve, so neither gate opens and no guaranteed-refused round trip is paid.
  setCaller(builtinCaller("viewer"));
  const vRun = recordingEngine();
  await fetchOverviewData(vRun.engine, null);
  ok("a viewer: the Overview does NOT read the approvals inbox", !vRun.called.has("listApprovals"));
  ok("a viewer: no pending-approval item is offered", !awaitingItem());
  // Non-vacuity for the stub itself: it must have been used for the OTHER reads, or "listApprovals was
  // not called" would be satisfied by an engine nothing ever touched.
  ok("the viewer run still performed the other Overview reads (the stub is live)", vRun.called.has("listDownpipes") && vRun.called.size > 3);

  // A null caller (whoami pending) fails closed on both.
  setCaller(null);
  setWhoamiAvailable(false);
  const nRun = recordingEngine();
  await fetchOverviewData(nRun.engine, null);
  ok("a null caller: the Overview does NOT read the approvals inbox", !nRun.called.has("listApprovals"));
  ok("a null caller: no pending-approval item is offered", !awaitingItem());
}

// ===========================================================================
// A REPEATED CHORD MUST COST THE CHORD, NEVER THE COMMAND (app-registry.ts reconcileRegistry).
// ===========================================================================
//
// Driven against the assembled REGISTRY rather than read off the source. A screen-owned action that
// declares a chord the static COMMANDS already own used to be DROPPED WHOLE by the reconciler, so
// "Restore from a run" (restore-flow.ts, group Actions, keywords recover / roll back / dry-run) was absent
// from the entire palette and the cheat-sheet: an operator searching for "roll back" or "dry-run" found
// nothing. app-registry.ts's own block comment asserted that this exact command survived, and it did not.
//
// The assertions are on the OUTCOME a customer gets (a searchable row) and on the invariant the drop rule
// existed to protect (one row per chord), with a negative control that the two PURE duplicate go-to rows
// are still dropped. A reconciler that kept everything would satisfy "the row is present" and fail the
// other two; one that dropped everything again fails the first.
{
  console.log("\n-- reconcileRegistry: a duplicate chord costs the chord, not the command --");
  const { REGISTRY } = await import("../src/lib/app-registry.ts");
  const byId = (id: string) => REGISTRY.find((c) => c.id === id);
  const searchable = (kw: string) => REGISTRY.filter((c) => c.keywords.some((k) => k.includes(kw))).map((c) => c.title);

  ok("the static go-to row keeps the chord it owns", byId("go-restore")?.shortcut === "g s");
  ok("the screen-owned 'Restore from a run' SURVIVES reconciliation", byId("restore.open") !== undefined);
  eq("and it is the row the palette shows for a restore action", byId("restore.open")?.title, "Restore from a run");
  ok("and it no longer carries the chord it does not own", byId("restore.open")?.shortcut === undefined);
  eq("exactly one row carries 'g s'", REGISTRY.filter((c) => c.shortcut === "g s").length, 1);
  // The outcome, in the words an operator would type. This is what was unreachable.
  ok("an operator searching the palette for 'roll back' finds it", searchable("roll back").includes("Restore from a run"));
  ok("an operator searching the palette for 'dry-run' finds it", searchable("dry-run").includes("Restore from a run"));
  // The negative control: a screen's PURE second 'Go to X' is still dropped, so the rail, the chords and
  // the palette never show two identical navigation rows.
  ok("a screen's duplicate 'Go to Downpipes' is still dropped", byId("goto-downpipes") === undefined);
  ok("a screen's duplicate 'Go to Topology map' is still dropped", byId("goto-map") === undefined);
  eq("and only one 'Go to Downpipes' row exists at all", REGISTRY.filter((c) => c.title === "Go to Downpipes").length, 1);
  eq("and only one 'Go to Topology map' row exists at all", REGISTRY.filter((c) => c.title === "Go to Topology map").length, 1);
  // Chord DISPATCH is built from the static COMMANDS, never from the reconciled list, so no chord moved.
  const { goToShortcuts } = await import("../src/shell/registry.ts");
  const chords = goToShortcuts();
  eq("the chord map still binds 'g s' exactly once", chords.filter((c) => c.chord === "g s").length, 1);
  eq("and it still lands on /restore", chords.find((c) => c.chord === "g s")?.route, "/restore");
}

console.log(`\n${checks.failures === 0 ? "PASS" : "FAIL"}: screen-action capability gates (${checks.failures} failure(s))`);
if (checks.failures > 0) process.exitCode = 1;
process.exit(checks.failures === 0 ? 0 : 1);
