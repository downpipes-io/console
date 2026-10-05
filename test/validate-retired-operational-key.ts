// AN OPERATIONAL KEY LEFT BOUND BESIDE THE BREAK-GLASS-ONLY MARKER READS AS PRESENT, NOT AS USABLE.
//
// The engine reports operationalConfigured.private as presence only: the secret is bound. It stays true
// even after an Owner chooses strict break-glass-only, because the engine records the choice as its own
// marker (operationalRetired) and cannot delete its own secrets, only the Owner's one-shot switch can. From
// that point the engine seals every new run to the break-glass key alone and opens no run with the
// operational private, so a surface that still reads presence alone as "the engine can self-test" is
// wrong on exactly the estates that need the true answer most: the ones a strict re-key left with a
// leftover pair.
//
// This file pins the shared decision (engineHoldsUsableOperationalKey) and each surface that must use it:
// the Keys screen's recovery-mode read and its ceremony-box starting posture, the strict break-glass-only
// switch (which must still offer itself, and never claim the switch is already done), and the Overview
// recovery-mode tile. A control case (the marker absent or false) proves none of this changed ordinary
// two-recipient behaviour.
//
// Run: node test/validate-retired-operational-key.ts

import { installDomShim, textOf, flushAsync, markConnected, qs, qsa } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

const { engineHoldsUsableOperationalKey } = await import("../src/lib/operational-key-posture.ts");
const { EngineClient } = await import("../src/api.ts");
const { renderPostureTab } = await import("../src/screens/keys/posture.ts");
const { renderPostureSwitch } = await import("../src/screens/keys/posture-switch.ts");
const { recoveryModeCard, buildRecoverySection } = await import("../src/screens/overview/recovery.ts");
const { renderBreakGlassRestore } = await import("../src/screens/restore-flow/break-glass.ts");
const { renderBreakGlassPrune } = await import("../src/screens/restore-flow/break-glass-prune.ts");
const { attendEntryCard } = await import("../src/screens/restore-flow/attend.ts");
const store = await import("../src/lib/store.ts");
type StatusReport = import("../src/api.ts").StatusReport;
type DownpipeState = import("../src/api.ts").DownpipeState;
type DrillEvidenceEntry = import("../src/api.ts").DrillEvidenceEntry;
type OverviewData = import("../src/screens/overview/shared.ts").OverviewData;
type FleetSummary = import("../src/screens/overview/shared.ts").FleetSummary;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A retired estate: the strict switch was chosen, but the operational pair is still bound (the defect this
// file guards). A plain two-recipient estate carries operationalRetired absent or false; both are covered.
const RETIRED_HELD: StatusReport = {
  service: "engine", engineVersion: "test", signerConfigured: true, breakGlassConfigured: true,
  operationalConfigured: { public: true, private: true }, operationalRetired: true,
  configKeysConfigured: { recipient: true, wrapKey: true }, destConfigured: true, destKind: "r2",
  updateChannelConfigured: false, licenceConfigured: true, downpipeCount: 0, ready: true,
};
const TWO_RECIPIENT: StatusReport = { ...RETIRED_HELD, operationalRetired: false };
const TWO_RECIPIENT_UNREPORTED: StatusReport = (() => {
  const { operationalRetired: _drop, ...rest } = RETIRED_HELD;
  return rest as StatusReport;
})();
const STRICT: StatusReport = { ...RETIRED_HELD, operationalConfigured: { public: false, private: false }, operationalRetired: false };

// owner() seats a verified Owner so role-gated controls (the switch's apply button) render.
function owner(): void {
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: false } as never);
}

// engineAnswering builds an EngineClient whose .status() resolves to the given report; every screen under
// test reads through this method alone.
function engineAnswering(status: StatusReport): InstanceType<typeof EngineClient> {
  const engine = new EngineClient("https://engine.test");
  (engine as unknown as Record<string, unknown>).status = async () => status;
  return engine;
}

async function main(): Promise<void> {
  console.log("\n-- the shared decision --");
  ok("held beside the marker: not usable", engineHoldsUsableOperationalKey(RETIRED_HELD) === false);
  ok("two-recipient, no marker: usable", engineHoldsUsableOperationalKey(TWO_RECIPIENT) === true);
  ok("an older engine that never sent the field: usable off presence alone", engineHoldsUsableOperationalKey(TWO_RECIPIENT_UNREPORTED) === true);
  ok("strict, no key at all: not usable", engineHoldsUsableOperationalKey(STRICT) === false);
  ok("an unread status: not usable", engineHoldsUsableOperationalKey(null) === false);

  owner();

  console.log("\n-- Keys screen: posture read and ceremony-box starting state --");
  {
    const tab = renderPostureTab(engineAnswering(RETIRED_HELD));
    document.body.appendChild(tab);
    await flushAsync();
    const text = textOf(tab as unknown as never);
    ok("retired+held: the recovery-mode read is break-glass-only, not two-recipient", text.includes("Recovery mode: break-glass-only") && !text.includes("Recovery mode: two-recipient"));
    const check = qs(tab as unknown as never, "#ceremony-strict") as unknown as HTMLInputElement | null;
    ok("retired+held: the ceremony box starts ticked (strict), because the pair is not usable", check?.checked === true);
    ok("retired+held: the 'What do these mean?' row does not claim bare presence runs the unattended work", text.includes("present, and not retired by a break-glass-only choice, means the engine can run scheduled restore tests"));
    tab.remove();
  }
  {
    const tab = renderPostureTab(engineAnswering(TWO_RECIPIENT));
    document.body.appendChild(tab);
    await flushAsync();
    const text = textOf(tab as unknown as never);
    ok("control, two-recipient: the recovery-mode read stays two-recipient", text.includes("Recovery mode: two-recipient"));
    const check = qs(tab as unknown as never, "#ceremony-strict") as unknown as HTMLInputElement | null;
    ok("control, two-recipient: the ceremony box starts unticked, unchanged", check?.checked === false);
    tab.remove();
  }

  console.log("\n-- the strict break-glass-only switch --");
  {
    const el = renderPostureSwitch(engineAnswering(RETIRED_HELD));
    document.body.appendChild(el);
    await flushAsync();
    const text = textOf(el as unknown as never);
    ok("retired+held: never claims the switch is already done", !text.includes("already break-glass-only"));
    ok("retired+held: still offers the switch", qs(el as unknown as never, '[data-dp="keys.button.apply"]') !== null);
    ok("retired+held: reuses the engine's own posture-check wording, not a fresh claim", text.includes("The engine seals new runs to the break-glass key only and does not use the operational key, but its private half can still decrypt every run sealed to it."));
    ok("retired+held: does not repeat the two-recipient claim that it can test-restore on its own", !text.includes("it can test-restore on its own"));
    el.remove();
  }
  {
    const el = renderPostureSwitch(engineAnswering(TWO_RECIPIENT));
    document.body.appendChild(el);
    await flushAsync();
    const text = textOf(el as unknown as never);
    ok("control, two-recipient: offers the switch with its ordinary wording", text.includes("it can test-restore on its own") && qs(el as unknown as never, '[data-dp="keys.button.apply"]') !== null);
    el.remove();
  }
  {
    const el = renderPostureSwitch(engineAnswering(STRICT));
    document.body.appendChild(el);
    await flushAsync();
    const text = textOf(el as unknown as never);
    ok("control, already strict: states it plainly", text.includes("Your engine is already break-glass-only"));
    el.remove();
  }

  console.log("\n-- Overview recovery-mode tile --");
  ok("retired+held: reads break-glass-only", textOf(recoveryModeCard({ ok: true, value: RETIRED_HELD }) as unknown as never).includes("Break-glass-only"));
  ok("control, two-recipient: reads two-recipient", textOf(recoveryModeCard({ ok: true, value: TWO_RECIPIENT }) as unknown as never).includes("Two-recipient"));
  ok("an unread status: reads unknown, not a fabricated mode", textOf(recoveryModeCard({ ok: false, error: new Error("x") }) as unknown as never).length > 0);

  console.log("\n-- Overview 'Last proven recoverable' tile: the same proof the Downpipes table counts --");
  {
    // The Downpipes table's "Covered" column reads a downpipe's own restoreProven record
    // (lib/protection-statement.ts provenClause); an ATTENDED verification stamps method
    // "attended-blind-test". This tile must count the same record, not only the separate
    // drill-evidence log. Driven through buildRecoverySection (the render path an operator
    // actually sees), not the inner tile builder directly, so a defect that only shows up once
    // the section assembles its data reads as a failing assertion here, not a crash somewhere
    // else that leaves the claim unproven.
    const attendedDownpipe: DownpipeState = {
      config: { id: "att1", name: "att1", cadenceSeconds: 86_400, enabled: true, source: { type: "kv", binding: "SRC_ATT", include: [], exclude: [] } },
      nextRunAt: Date.now() + 3_600_000,
      lastRunId: "run-att-1",
      inFlight: false,
      restoreProvenMethod: "attended-blind-test",
      lastRestoreProvenAt: "2026-09-20T00:00:00.000Z",
      lastRestoreProvenBy: "owner@example.com",
    };
    const emptyFleet: FleetSummary = {
      total: 0, healthy: 0, stale: 0, failed: 0, disabled: 0, inFlight: 0, rows: [],
      newestGoodAt: null, worstGoodAt: null, noGoodBackupCount: 0, anyRuns: false,
    } as unknown as FleetSummary;
    function overviewData(status: StatusReport, downpipes: DownpipeState[], drillEvidence: DrillEvidenceEntry[] = []): OverviewData {
      return {
        health: { ok: true, value: { ok: true, service: "downpipe engine" } },
        status: { ok: true, value: status },
        licence: { ok: true, value: { tier: "community", valid: false } },
        updates: { ok: true, value: { configured: true, verified: true, currentVersion: "0.0.0" } },
        history: { ok: true, value: {} },
        downpipes: { ok: true, value: downpipes },
        drillEvidence: { ok: true, value: drillEvidence },
        audit: { ok: true, value: [] },
        approvals: { ok: true, value: [] },
        discovery: { ok: false, error: new Error("not exercised by this validator") },
      } as unknown as OverviewData;
    }
    // tileText isolates ONE tile's own text within the rendered section (by its .stat__label),
    // so a word another posture tile also uses (the RPO tile's own "Unproven" on an empty
    // fleet) cannot pass or fail this assertion by accident.
    function tileText(section: HTMLElement, label: string): string {
      for (const el of qsa(section as unknown as never, ".stat__label")) {
        if ((el as unknown as { textContent: string }).textContent === label) {
          return textOf((el as unknown as { parentElement: unknown }).parentElement as unknown as never);
        }
      }
      return "";
    }
    async function renderSection(data: OverviewData): Promise<HTMLElement> {
      const section = buildRecoverySection(data, emptyFleet, () => {});
      document.body.appendChild(section);
      markConnected(section);
      await flushAsync();
      return section;
    }
    async function renderSectionText(data: OverviewData): Promise<string> {
      const section = await renderSection(data);
      const text = textOf(section as unknown as never);
      section.remove();
      return text;
    }

    const provenSection = await renderSection(overviewData(RETIRED_HELD, [attendedDownpipe]));
    const provenTileText = tileText(provenSection, "Last proven recoverable");
    provenSection.remove();
    ok("break-glass-only, an attended verification recorded: the tile reads proven, not Unproven", provenTileText.length > 0 && !provenTileText.includes("Unproven"));
    ok("break-glass-only, an attended verification recorded: the kind is named", provenTileText.includes("Attended verification"));
    ok("break-glass-only, an attended verification recorded: names who proved it", provenTileText.includes("Newest attended verification by owner@example.com."));

    const noProofBreakGlass = await renderSectionText(overviewData(RETIRED_HELD, []));
    ok("break-glass-only, no proof at all: points to an attended verification", noProofBreakGlass.includes("Prove recoverability with an attended verification."));
    ok("break-glass-only, no proof at all: never points at a drill the engine refuses", !noProofBreakGlass.includes("Run a drill"));

    const noProofOperational = await renderSectionText(overviewData(TWO_RECIPIENT, []));
    ok("control, operational, no proof at all: still points at a drill", noProofOperational.includes("Run a drill so recovery is demonstrated, not assumed."));
    ok("control, operational, no proof at all: names no attended verification", !noProofOperational.includes("attended verification"));

    const drillNewer = await renderSectionText(overviewData(
      RETIRED_HELD,
      [attendedDownpipe],
      [{ runId: "r1", kind: "in-account", recordedBy: "ops@example.com", recordedAt: "2026-09-25T00:00:00.000Z" }],
    ));
    ok("a newer in-account drill outranks an older attended proof", drillNewer.includes("In-account drill") && !drillNewer.includes("Attended verification"));
  }

  console.log("\n-- break-glass panels: presence is not usability --");
  // These three panels' intro text is static (it does not branch on status), and it is reached whenever the
  // engine reports the break-glass-only reason -- which, from 257857b1, now includes an estate a strict
  // re-key left with a leftover pair (retired+held), not only an estate with no operational secret at all.
  // "Holds no operational key" is false in that case: the pair is bound, only unusable. Each panel must say
  // the engine has no key it can USE, not that it holds none.
  {
    const panel = renderBreakGlassRestore(engineAnswering(RETIRED_HELD));
    document.body.appendChild(panel.el);
    await flushAsync();
    const text = textOf(panel.el as unknown as never);
    ok("break-glass restore: says no USABLE operational key, not bare presence", text.includes("the engine has no usable operational key"));
    ok("break-glass restore: drops the old 'holds no operational key' claim", !text.includes("the engine holds no operational key"));
    panel.teardown();
    panel.el.remove();
  }
  {
    const panel = renderBreakGlassPrune(engineAnswering(RETIRED_HELD));
    document.body.appendChild(panel.el);
    await flushAsync();
    const text = textOf(panel.el as unknown as never);
    ok("break-glass prune: says no USABLE operational key, not bare presence", text.includes("the engine has no usable operational key"));
    ok("break-glass prune: drops the old 'holds no operational key' claim", !text.includes("the engine holds no operational key"));
    panel.teardown();
    panel.el.remove();
  }
  {
    const card = attendEntryCard(engineAnswering(RETIRED_HELD));
    document.body.appendChild(card);
    await flushAsync();
    const text = textOf(card as unknown as never);
    ok("attended-verification entry: says no USABLE key, not bare presence", text.includes("it has no usable key to reopen a run"));
    ok("attended-verification entry: drops the old 'holds no key' claim", !text.includes("it holds no key to reopen a run"));
    card.remove();
  }

  console.log(`\n${failures === 0 ? "RETIRED-OPERATIONAL-KEY OK" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
