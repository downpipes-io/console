// Cost wire types: the onboarding estate-size estimate (GET /admin/cost/estate-size). The engine sizes
// each configured source from Cloudflare storage analytics (no value reads) so the cost screen can show a
// real figure before the first backup runs. Mirror of the engine's sizing-probe shapes.

// EstateSourceSize is one source's measured size and how it was obtained (provenance, never a guess):
// "analytics" from Cloudflare storage analytics, or "unavailable" when it could not be sized (D1, a
// missing id, no scope). "list-meta" is reserved for future use (a metadata listing) and is never
// emitted by the current engine; when it is implemented, ensure the console renders it correctly.
export interface EstateSourceSize {
  bytes: number;
  count: number;
  basis: "analytics" | "list-meta" | "unavailable";
}

// EstateSizeReport is the whole-estate roll-up: totals plus how many of the configured sources could be
// sized, so the console can say "sized N of M sources" honestly. available is false when the engine had
// no analytics token or account id (the screen then falls back to manual entry, never blocks).
export interface EstateSizeReport {
  totalBytes: number;
  totalCount: number;
  sizedSources: number;
  sourceCount: number;
  available: boolean;
  perSource: EstateSourceSize[];
}
