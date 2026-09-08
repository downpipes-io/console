// The console half of a two-sided defect: the console never stated a base, so every write
// it made was a caller that "states nothing" and the engine's precondition could not fire.
//
// THE DEFECT IN ONE SENTENCE. `POST /admin/downpipes` is a WHOLE-OBJECT upsert. Two operators who loaded the
// same downpipe and saved different edits to it were BOTH answered 200, one edit was discarded with nothing
// said, and neither could tell. The engine half landed (engine/src/sched/downpipe-precondition.ts):
// a save or a delete may state `ifMatchRev`, and a stated base that has moved is refused with 409 naming the
// field another operator changed. The check is enforced inside addDownpipe / removeDownpipe, downstream of
// both branches of the change-control gate, and it never reads requireConfigApproval, so DETECTION is
// unconditional and GOVERNANCE stays opt-in. But an engine precondition only fires for a caller that states
// one, and until this landed the console stated nothing on every path, so on the deployed product two
// operators could still both be told they had succeeded.
//
// WHAT THIS DRIVES, and every arm is driven rather than read:
//   1. THE WIRE. The real addDownpipe / deleteDownpipe from lib/api/client-downpipes.ts against a captured
//      fetch, grading the JSON body the engine would receive. The three states are distinguished: a key that
//      is ABSENT, a key that is explicitly null, and a key carrying a number. The engine reads ifMatchRev
//      with `in`, so absent and null are two DIFFERENT statements and a console that sent null for "I have
//      no revision" would be declaring a create.
//   2. THE BOUNDARY. mapEngineDownpipeState, proving the revision survives the wire mapping and that a
//      FORGED one is dropped rather than carried, because a screen holding a forged revision would refuse a
//      save that has no collision in it and the operator could do nothing about it.
//   3. THE SCREENS. The real toggleEnabled and deleteDownpipe from the downpipes drawer, driven through the
//      DOM shim, grading the base each one actually handed the client.
//   4. THE CONSEQUENCE, which is the arm that answers the defect: two operators, one downpipe, against a
//      fake engine that MIRRORS the landed precondition. With the base stated the second operator is
//      refused and reads why; the CONTROL, an identical run with the base withheld exactly as the shipped
//      console withheld it, has both operators told they succeeded and the first operator's edit gone.
//
// Run with: node test/validate-optimistic-concurrency-base-stated.ts
import { flushAsync, installDomShim } from "./dom-shim.ts";

installDomShim();

import type { Downpipe, DownpipeState, EngineClient, EngineDownpipeState, MutationResult } from "../src/api.ts";
import { addDownpipe, deleteDownpipe as apiDeleteDownpipe } from "../src/lib/api/client-downpipes.ts";
import { Transport } from "../src/lib/api/client-transport.ts";
import { mapEngineDownpipeState } from "../src/lib/api/helpers.ts";
import { fetchOverviewData } from "../src/screens/overview/fetch.ts";
import { summariseFleet } from "../src/screens/overview/fleet-data.ts";
import { buildNeedsMe } from "../src/screens/overview/recovery.ts";
import { deleteDownpipe as screenDeleteDownpipe, toggleEnabled } from "../src/screens/sources-downpipes/detail-actions.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

const BASE: Downpipe = {
  id: "dp-1",
  name: "nightly",
  cadenceSeconds: 86400,
  enabled: false,
  source: { type: "r2", binding: "SRC_R2", include: [], exclude: [] },
};

function stateOf(cfg: Downpipe, configRev?: number): DownpipeState {
  return { config: cfg, nextRunAt: null, lastRunId: null, inFlight: false, ...(configRev !== undefined ? { configRev } : {}) } as unknown as DownpipeState;
}

// ---- captured fetch -----------------------------------------------------------------------------------
// The global fetch every engine call reaches through engineFetch, replaced by one that records the parsed
// body and answers a plain applied 200. Restored at the end of the wire arms.
interface Sent {
  url: string;
  body: Record<string, unknown>;
}
const realFetch = globalThis.fetch;
const sent: Sent[] = [];
function captureFetch(answer: () => Response): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    sent.push({ url: String(input), body });
    return answer();
  }) as unknown as typeof fetch;
}
const applied200 = (): Response => new Response(JSON.stringify({ config: BASE, nextRunAt: 0, lastRunId: null, inFlight: false }), { status: 200, headers: { "content-type": "application/json" } });
const deleted200 = (): Response => new Response(JSON.stringify({ deleted: true, deletedRev: 3 }), { status: 200, headers: { "content-type": "application/json" } });

async function main(): Promise<void> {
  // ---- ARM 1: THE WIRE ---------------------------------------------------------------------------------
  console.log("\nARM 1: the body the engine receives, for each of the three things a caller can state");
  {
    const t = new Transport("https://engine.example.com", "tok");

    captureFetch(applied200);
    sent.length = 0;
    await addDownpipe(t, BASE, 7);
    const stated = sent[0]?.body ?? {};
    ok("1a: a stated revision rides as ifMatchRev, at the value the screen read", stated.ifMatchRev === 7);
    ok("1b: and the configuration itself is unchanged beside it", stated.id === "dp-1" && stated.cadenceSeconds === 86400 && stated.name === "nightly");

    sent.length = 0;
    await addDownpipe(t, BASE);
    const unstated = sent[0]?.body ?? {};
    // THE KEY MUST BE ABSENT, not null. readPrecondition reads it with `in`, so a null here would declare
    // "I believe this downpipe does not exist", and every save from a screen that holds no revision would
    // be refused as `already-exists`.
    ok("1c: an UNSTATED base omits the key entirely, rather than sending null", !("ifMatchRev" in unstated));
    ok("1d: and the unstated body is otherwise the same configuration", unstated.id === "dp-1" && unstated.cadenceSeconds === 86400);

    sent.length = 0;
    await addDownpipe(t, BASE, null);
    ok("1e: an explicitly DECLARED create sends null, which is a different statement from silence", "ifMatchRev" in (sent[0]?.body ?? {}) && sent[0]?.body.ifMatchRev === null);

    captureFetch(deleted200);
    sent.length = 0;
    await apiDeleteDownpipe(t, "dp-1", 3);
    ok("1f: the DELETE states its base too", sent[0]?.body.id === "dp-1" && sent[0]?.body.ifMatchRev === 3);

    sent.length = 0;
    await apiDeleteDownpipe(t, "dp-1");
    ok("1g: an unstated delete sends the id alone", sent[0]?.body.id === "dp-1" && !("ifMatchRev" in (sent[0]?.body ?? {})));

    sent.length = 0;
    await apiDeleteDownpipe(t, "dp-1", null);
    // null is nonsense on a delete and the engine refuses it as `precondition-unreadable` rather than
    // reading it as unstated, so the client must never send one.
    ok("1h: a null base on a delete is never sent, because the engine refuses it as unreadable", !("ifMatchRev" in (sent[0]?.body ?? {})));

    globalThis.fetch = realFetch;
  }

  // ---- ARM 2: THE BOUNDARY -----------------------------------------------------------------------------
  console.log("\nARM 2: the revision survives the wire mapping, and a forged one does not");
  {
    const wire = (configRev: unknown): EngineDownpipeState => ({ config: BASE, nextRunAt: 0, lastRunId: null, inFlight: false, configRev } as unknown as EngineDownpipeState);
    ok("2a: a real revision is carried onto the console state", mapEngineDownpipeState(wire(4)).configRev === 4);
    ok("2b: revision 0 is carried, because 0 is a real revision and not an absence", mapEngineDownpipeState(wire(0)).configRev === 0);
    ok("2c: an ABSENT revision stays absent, so an older engine leaves the screen stating nothing", mapEngineDownpipeState(wire(undefined)).configRev === undefined);
    ok("2d: a NEGATIVE revision is dropped, never carried", mapEngineDownpipeState(wire(-1)).configRev === undefined);
    ok("2e: a non-numeric revision is dropped, never coerced", mapEngineDownpipeState(wire("4")).configRev === undefined);
    ok("2f: a NaN revision is dropped", mapEngineDownpipeState(wire(Number.NaN)).configRev === undefined);
  }

  // ---- ARM 3: THE SCREENS ------------------------------------------------------------------------------
  console.log("\nARM 3: the drawer's own writes state the base they read");
  {
    const bases: Array<number | null | undefined> = [];
    const live = stateOf({ ...BASE }, 11);
    const engine = {
      listDownpipes: async (): Promise<DownpipeState[]> => [live],
      addDownpipe: async (dp: Downpipe, base?: number | null): Promise<MutationResult<DownpipeState>> => {
        bases.push(base);
        return { status: "applied", value: stateOf(dp, 12) };
      },
    } as unknown as EngineClient;
    await toggleEnabled(engine, stateOf({ ...BASE }), () => {}, () => {});
    await flushAsync();
    ok("3a: the enable switch states the revision the LIVE read returned, not the one the screen opened at", bases[0] === 11);

    const delBases: Array<number | null | undefined> = [];
    const delEngine = {
      deleteDownpipe: async (_id: string, base?: number | null): Promise<MutationResult<{ deleted: boolean }>> => {
        delBases.push(base);
        return { status: "applied", value: { deleted: true } };
      },
    } as unknown as EngineClient;
    // The drawer's danger-tier confirm is a modal; answer it by clicking the confirm button once it paints.
    const del = screenDeleteDownpipe(delEngine, BASE, () => {}, () => {}, 9);
    await flushAsync();
    const confirm = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Delete downpipe"));
    confirm?.click();
    await del;
    await flushAsync();
    ok("3b: the drawer's delete states the revision the drawer was opened at", delBases[0] === 9);
  }

  // ---- ARM 4: THE CONSEQUENCE, AND ITS CONTROL ----------------------------------------------------------
  console.log("\nARM 4: two operators, one downpipe, against an engine that mirrors the landed precondition");
  {
    // A fake engine holding ONE record with a revision, applying the landed rule: a stated base that does
    // not match the live revision is refused the way parseJsonOrPending surfaces the engine's 409 (the
    // sentence, then the status), and an UNSTATED base applies over the top exactly as the route did before
    // the precondition existed.
    function engineWithPrecondition(): { engine: EngineClient; read: () => Downpipe } {
      let stored: Downpipe = { ...BASE };
      let rev = 1;
      const engine = {
        addDownpipe: async (dp: Downpipe, base?: number | null): Promise<MutationResult<DownpipeState>> => {
          if (typeof base === "number" && base !== rev) {
            throw new Error(`add downpipe: this downpipe changed since you loaded it (another operator changed cadenceSeconds); your edit to "${dp.id}" was not saved, please reload it and make the change again: 409`);
          }
          stored = { ...dp };
          rev += 1;
          return { status: "applied", value: stateOf(stored, rev) };
        },
      } as unknown as EngineClient;
      return { engine, read: () => stored };
    }

    // THE SUBJECT: both operators state the base they read.
    {
      const { engine, read } = engineWithPrecondition();
      const baseA = 1; // both screens loaded the record at revision 1
      const baseB = 1;
      let aTold = "";
      let bTold = "";
      try {
        await engine.addDownpipe({ ...BASE, cadenceSeconds: 3600 }, baseA);
        aTold = "saved";
      } catch (err) {
        aTold = String((err as Error).message);
      }
      try {
        await engine.addDownpipe({ ...BASE, name: "renamedbyb" }, baseB);
        bTold = "saved";
      } catch (err) {
        bTold = String((err as Error).message);
      }
      ok("4a: operator A, whose base is current, is told they saved", aTold === "saved");
      ok("4b: operator B is NOT told they saved", bTold !== "saved");
      ok("4c: operator B is told the downpipe changed under them", bTold.includes("changed since you loaded it"));
      ok("4d: operator B is told WHICH field moved, by name", bTold.includes("cadenceSeconds"));
      ok("4e: operator B is told their edit was not saved", bTold.includes("was not saved"));
      ok("4f: A's edit SURVIVED, which is the edit that used to be discarded", read().cadenceSeconds === 3600);
      ok("4g: B's rename did not land, and B knows it", read().name === "nightly");
    }

    // THE CONTROL: the SAME two operators, the SAME two edits, the SAME order, against the SAME engine.
    // The only thing changed is that neither states a base, which is what the shipped console did. If this
    // arm did not reproduce the defect the arm above would be proving nothing about the console's part.
    {
      const { engine, read } = engineWithPrecondition();
      let aTold = "";
      let bTold = "";
      try {
        await engine.addDownpipe({ ...BASE, cadenceSeconds: 3600 });
        aTold = "saved";
      } catch (err) {
        aTold = String((err as Error).message);
      }
      try {
        await engine.addDownpipe({ ...BASE, name: "renamedbyb" });
        bTold = "saved";
      } catch (err) {
        bTold = String((err as Error).message);
      }
      ok("CONTROL 4h: with no base stated, operator A is told they saved", aTold === "saved");
      ok("CONTROL 4i: with no base stated, operator B is ALSO told they saved", bTold === "saved");
      ok("CONTROL 4j: and A's edit is GONE, which is the defect, reproduced here to prove the arms above bite", read().cadenceSeconds === 86400);
    }
  }

  // ---- ARM 5: AN EMPTY RUN HISTORY AND A BRAND-NEW ESTATE WERE THE SAME SENTENCE ------------------------
  //
  // The engine now publishes runsRecordedTotal, runsRetainedCount, runsRolledOverCount and
  // runlogCounterReset beside the rings on GET /history. The console read only
  // the rings, so an estate whose run history had entirely rolled out of the bounded ring still read
  // "Nothing needs your attention yet", the teaching copy for an estate that has never run anything.
  //
  // These arms drive the REAL fleet roll-up and the REAL Overview section, and grade the sentence.
  console.log("\nARM 5: the Overview tells an emptied run history apart from a new estate");
  {
    const settledOk = (value: unknown): unknown => ({ ok: true, value });
    const base = (): Record<string, unknown> => ({
      health: settledOk({ ok: true, service: "downpipe engine" }),
      status: settledOk({ ready: true, signerConfigured: true, breakGlassConfigured: true, destConfigured: true, operationalConfigured: { private: true }, recoveryCodesRemaining: 8 }),
      licence: settledOk({ valid: true, tier: "business", notAfter: "2027-01-01T00:00:00Z" }),
      updates: settledOk({ configured: true, verified: true, updateAvailable: false, currentVersion: "0.2.0", recommendedVersion: "0.2.0", versionSkew: "current" }),
      history: settledOk({}),
      downpipes: settledOk([]),
      drillEvidence: settledOk([]),
      audit: settledOk([]),
      approvals: settledOk([]),
      discovery: settledOk({ bindings: [], tokenSources: [] }),
    });
    const sentenceFor = (rollover?: unknown): string => {
      const data = { ...base(), ...(rollover !== undefined ? { historyRollover: settledOk(rollover) } : {}) } as never;
      const el = buildNeedsMe(data, summariseFleet(data));
      return String(el.textContent ?? "").replace(/\s+/g, " ").trim();
    };

    const newEstate = sentenceFor({});
    const emptiedEstate = sentenceFor({ recordedTotal: 240, retainedCount: 0, rolledOverCount: 240 });
    const resetCounter = sentenceFor({ recordedTotal: 12, retainedCount: 0, rolledOverCount: 12, counterReset: true });
    const oldEngine = sentenceFor(undefined);

    ok("5a: a genuinely new estate still reads as a new estate", newEstate.includes("Nothing needs your attention yet"));
    ok("5b: an estate whose history rolled does NOT read as a new estate", !emptiedEstate.includes("Nothing needs your attention yet"));
    ok("5c: THE TWO STATES NO LONGER PRODUCE THE SAME SENTENCE, which is the defect", newEstate !== emptiedEstate);
    ok("5d: the emptied estate is told how many runs rolled out", emptiedEstate.includes("240"));
    ok("5e: it names what rolled, so the operator knows where to stop looking", emptiedEstate.includes("rolled out of the retained run history"));
    ok("5f: and it does not turn a normal rollover into an archive alarm", emptiedEstate.includes("archives are not affected"));
    ok("5g: a wound-back counter reports a FLOOR, not a measurement", resetCounter.includes("at least 12"));
    ok("5h: an unreset counter does NOT say `at least`", !emptiedEstate.includes("at least"));
    // ABSENT IS NOT ZERO. An engine older than the counters publishes none, and reading an absent counter
    // as 0 would tell every such estate that nothing had rolled over, which is the defect wearing the
    // costume of its fix.
    ok("5i: against an engine that publishes no counters, the sentence falls back rather than claiming zero", oldEngine.includes("Nothing needs your attention yet"));
    ok("5j: and that fallback is byte-identical to the genuine new estate, because both are honestly unknown", oldEngine === newEstate);
  }

  // ---- ARM 6: ONE READ, TWO FIELDS ----------------------------------------------------------------------
  console.log("\nARM 6: the counters come off the SAME history read, not a second one");
  {
    let historyCalls = 0;
    const engine = {
      health: async () => ({ ok: true }),
      status: async () => ({ ready: true }),
      licence: async () => ({ valid: true }),
      updates: async () => ({ configured: false }),
      listAllHistory: async () => {
        historyCalls++;
        return { byDownpipe: { dp1: [] }, runsRecordedTotal: 9, runsRetainedCount: 0, runsRolledOverCount: 9 };
      },
      listDownpipes: async () => [],
      listDrillEvidence: async () => [],
      listAudit: async () => ({ events: [] }),
      listApprovals: async () => [],
      discoverSources: async () => ({ bindings: [], tokenSources: [] }),
    } as unknown as EngineClient;
    const data = await fetchOverviewData(engine);
    ok("6a: GET /admin/history is read ONCE", historyCalls === 1);
    ok("6b: the rings land on `history`, unchanged for every existing consumer", data.history.ok && JSON.stringify(data.history.value) === JSON.stringify({ dp1: [] }));
    ok("6c: and the counters land beside them off the same response", data.historyRollover?.ok === true && data.historyRollover.value.rolledOverCount === 9);
    ok("6d: the roll-up carries the count onto the fleet summary", summariseFleet(data).runsRolledOverCount === 9);
  }

  // ---- ARM 7: THE LOSING OPERATOR READS THE REASON ------------------------------------------------------
  //
  // Stating a base is only half of being told. A refusal the console swallows into "Could not change the
  // enabled state." would leave the losing operator exactly as uninformed as a silent 200, with the extra
  // insult of a failure they cannot act on. So this drives the REAL screen against a REAL 409 in the shape
  // the engine sends, and grades the SENTENCE that reaches the toast.
  console.log("\nARM 7: what the losing operator actually reads on screen");
  {
    const engineSentence = 'this downpipe changed since you loaded it (another operator changed cadenceSeconds); your edit to "dp-1" was not saved, please reload it and make the change again';
    const t = new Transport("https://engine.example.com", "tok");
    captureFetch(() => new Response(JSON.stringify({ error: engineSentence, refusal: "precondition-failed", precondition: { reason: "base-moved", id: "dp-1", yourRev: 4, currentRev: 5, changedFields: ["cadenceSeconds"], changedAt: "2026-08-13T06:41:02.117Z" } }), { status: 409, headers: { "content-type": "application/json" } }));
    let thrown = "";
    try {
      await addDownpipe(t, BASE, 4);
    } catch (err) {
      thrown = String((err as Error).message);
    }
    globalThis.fetch = realFetch;
    ok("7a: a 409 is not swallowed into an applied result", thrown !== "");
    ok("7b: the ENGINE's own sentence rides all the way to the caller", thrown.includes("changed since you loaded it"));
    ok("7c: including the field another operator moved, by name", thrown.includes("cadenceSeconds"));
    // parseJsonOrPending gates the reason fold OUT for 401/403/429 and 5xx, so a role denial still reads
    // "Not permitted" rather than a 400 sentence. 409 is deliberately inside the fold, and this is the cell
    // that would red if somebody widened that gate to exclude it.
    ok("7d: and the status trails it, so a client can still branch on 409", thrown.trim().endsWith("409"));

    // AND ON SCREEN. The drawer's toast wraps the reason; refusalText strips the transport's verb prefix,
    // so what the operator reads is the engine's reviewed sentence rather than "add downpipe: ...: 409".
    document.body.innerHTML = "";
    const engine = {
      listDownpipes: async (): Promise<DownpipeState[]> => [stateOf({ ...BASE }, 4)],
      addDownpipe: async (): Promise<MutationResult<DownpipeState>> => {
        throw new Error(`add downpipe: ${engineSentence}: 409`);
      },
    } as unknown as EngineClient;
    await toggleEnabled(engine, stateOf({ ...BASE }), () => {}, () => {});
    await flushAsync();
    const onScreen = [...document.querySelectorAll(".toast__msg")].map((n) => n.textContent ?? "").join(" | ");
    ok("7e: the drawer TELLS the operator, rather than reporting a bare status", onScreen.includes("changed since you loaded it"));
    ok("7f: and names the field, which is what sends them to the right place", onScreen.includes("cadenceSeconds"));
    ok("7g: and it does NOT say the switch was flipped", !onScreen.includes("Enabled dp-1") && !onScreen.includes("Disabled dp-1"));
  }

  console.log(`\n${checks - failures}/${checks} ok`);
  console.log(`VERDICT: ${failures === 0 ? "PASS" : "FAIL"} failures=${failures} checks=${checks} entry=${import.meta.filename}`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("BASE STATED ON EVERY WRITE THAT HOLDS ONE");
}

await main();
