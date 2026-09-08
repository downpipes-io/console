// The downpipe (offline reader) checkout is not part of this repository.
export function downpipeRoot(): string | null {
  return null;
}

export function requireDownpipeRoot(who: string): string | null {
  if (process.env.REQUIRE_DOWNPIPE === "1") {
    console.error(`REFUSED: REQUIRE_DOWNPIPE=1 and no downpipe checkout is available for ${who}.`);
    process.exit(2);
  }
  return null;
}

export function readDownpipeSource(_root: string, rel: string): string {
  throw new Error(`downpipe reader source is not available (${rel}).`);
}
