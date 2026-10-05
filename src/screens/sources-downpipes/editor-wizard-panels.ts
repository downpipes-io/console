// Destination block for the guided create wizard. See ./editor.ts for the barrel.
//
// cf-config is a scope-preset + tick-many zone/account selection: the wizard offers a coarse, guided
// choice (the scope preset) rather than a per-surface checklist, consistent with how kv/r2/d1 also defer
// fine-grained includes/excludes to "Use the advanced editor". Fine per-surface control lives there
// instead (./editor-cf-config-section.ts).

// destinationBlock is what the name step shows for "where this goes". The picker itself moved to
// ./destination-fanout.ts (a leaf) so the Sources bulk-protect tier shares the SAME control without
// importing the wizard's module graph; this re-export keeps the wizard's import site unchanged.
export { destinationFanout as destinationBlock } from "./destination-fanout.ts";
