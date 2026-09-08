// Overview data fetch: settles the nine independent reads so one failing route never blanks
// the page. Moved verbatim out of view.ts for size; behaviour unchanged.
// House rules: Australian English, no em dashes, precise claims.

import type { EngineClient, RestoreApproval, RunHistoryEntry, SourceDiscovery } from "../../api.ts";
import { callerCan } from "../../lib/identity-custom-roles.ts";
import { caller, whoamiAvailable } from "../../lib/nav.ts";
import type { OverviewData, Settled } from "./shared.ts";

// fetchOverviewData fetches the reads independently, settling each so one failing route never blanks the
// page. The nine core reads (health, status, licence, updates, history, downpipes, drill-evidence, audit,
// approvals) run on every load; source discovery is special-cased (see carriedDiscovery).
//
// carriedDiscovery is the surface-coverage hero's input (bound bindings + the added token set). Source
// discovery makes LIVE Cloudflare API calls, so it must not ride the 30s poll: the view fetches it once,
// then passes the cached result back here on a poll (carriedDiscovery set) so it is reused verbatim. A
// manual refresh passes null to force a fresh read. On the first load none is carried, so it is fetched.
export async function fetchOverviewData(
  engine: EngineClient,
  carriedDiscovery?: Settled<SourceDiscovery> | null,
): Promise<OverviewData> {
  const settle = async <T>(p: Promise<T>): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const discoveryP: Promise<Settled<SourceDiscovery>> = carriedDiscovery
    ? Promise.resolve(carriedDiscovery)
    : settle(engine.discoverSources());
  // The two D4 reads (drill-evidence + audit) are settled alongside the rest so one
  // failing route never blanks the page; the recovery card reads their own ok/unknown and
  // falls back to the honest "pending engine" copy when they are not yet wired (404/501).
  // The audit read asks for a single newest event (the "last audited" stamp), so even a
  // large log returns one row. listDrillEvidence has no paging, so it returns the small set.
  // The approvals inbox read is only meaningful to a caller who can sign a plan, so other callers
  // settle an empty list locally rather than paying a guaranteed-refused round trip on every poll.
  // Gated by the restore.approve CAPABILITY, the engine's own gate for POST /restore/approve. The
  // old role-NAME test (approver/owner) also excluded restore-operator, which HOLDS restore.approve,
  // so the recovery-only role's Overview substituted an empty approvals list and the needs-me item
  // below could not fire even when the inbox held pending requests. callerCan resolves a named custom
  // role's effective set rather than the "viewer" floor its role field carries.
  const c = caller();
  const canApprove = whoamiAvailable() && c !== null && callerCan(c.role, "restore.approve", c.customRole ?? null);
  const [health, status, licence, updates, historyAll, downpipes, drillEvidence, audit, approvals, discovery] = await Promise.all([
    settle(engine.health()),
    settle(engine.status()),
    settle(engine.licence()),
    settle(engine.updates()),
    // ONE read, TWO fields. The rings and the rollover counters arrive in the same response and are split
    // below rather than fetched twice: `history` stays exactly the map every existing consumer reads, and
    // historyRollover carries the counters that let an empty map be told apart from an emptied one.
    settle(engine.listAllHistory()),
    settle(engine.listDownpipes()),
    settle(engine.listDrillEvidence()),
    settle(engine.listAudit({ limit: 1 }).then((p) => p.events)),
    settle(canApprove ? engine.listApprovals() : Promise.resolve<RestoreApproval[]>([])),
    discoveryP,
  ]);
  // Null-defensive on the SAME terms as fleet-data's own read of this field: the declared type is what the
  // contract promises, not what arrived, so a 2xx whose body carries no byDownpipe still settles ok and
  // must not throw here. An absent map reads as {} (an honest empty fleet), and absent counters stay
  // ABSENT rather than becoming zeroes, because an unknown is not a claim that nothing rolled over.
  const history: Settled<Record<string, RunHistoryEntry[]>> = historyAll.ok ? { ok: true, value: historyAll.value?.byDownpipe ?? {} } : historyAll;
  const historyRollover: OverviewData["historyRollover"] = historyAll.ok
    ? {
        ok: true,
        value: {
          ...(typeof historyAll.value?.runsRecordedTotal === "number" ? { recordedTotal: historyAll.value.runsRecordedTotal } : {}),
          ...(typeof historyAll.value?.runsRetainedCount === "number" ? { retainedCount: historyAll.value.runsRetainedCount } : {}),
          ...(typeof historyAll.value?.runsRolledOverCount === "number" ? { rolledOverCount: historyAll.value.runsRolledOverCount } : {}),
          ...(historyAll.value?.runlogCounterReset === true ? { counterReset: true as const } : {}),
        },
      }
    : historyAll;
  return { health, status, licence, updates, history, historyRollover, downpipes, drillEvidence, audit, approvals, discovery };
}
