// Point-in-time recovery + per-destination replication mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// PointInTimeRun mirrors the engine's PointInTimeRun (engine src/admin/restore-types.ts) byte-for-byte:
// the resolution of "the run to restore from AS OF timestamp T", the latest SUCCESSFUL run that completed
// at-or-before T from the retained ring. found:true carries runId/completedAt (the recovery point it
// restores to) + index (the monotonic run index). found:false carries an honest reason and, when the ring
// holds successful runs, the retainedFrom/retainedTo bounds so the console can state the recoverable
// window plainly ("you can only restore to a point between <from> and <to>"). It is a redaction-safe
// projection of the history ring: a run id + a timestamp + an index, never a key, value or selector.
export interface PointInTimeRun {
  downpipeId: string;
  found: boolean;
  runId?: string;
  completedAt?: string;
  index?: number;
  reason?: string;
  retainedFrom?: string;
  retainedTo?: string;
}

// DestReplState mirrors the engine's per-destination replication state (engine scheduler-do.ts): what
// THIS destination is PROVEN to hold (holdsRunId/holdsIndex) and whether the last seal-or-mirror attempt
// to it succeeded (lastOk + coarse reason), the reachability heartbeat behind the map's "down" indicator.
export interface DestReplState {
  holdsRunId: string | null;
  holdsIndex: number;
  lastOk: boolean;
  lastAttemptAt: number;
  reason?: string;
}
