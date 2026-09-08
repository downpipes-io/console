// The console's own version identity. Single source of truth: package.json
// `version`, baked into the bundle by scripts/stamp-build.mjs as the `__CONSOLE_VERSION__` define, and
// exposed by the serving origin as the deterministic /__build.json descriptor the same script emits.
// Two distinct questions live here, deliberately separated:
//   - consoleVersion(): what version is THIS RUNNING CODE (the tab's loaded bundle)? Read from the baked
//     define; null when unstamped (a Node validator run, or a dev context without the define), never a
//     fabricated value.
//   - fetchServedConsoleVersion(): what version does THE ORIGIN SERVE RIGHT NOW? Fetched (cache: no-store)
//     from /__build.json; after a console update the two differ until the operator reloads, which is
//     exactly the signal the post-apply check needs.
// No-custody: a version string only; nothing here reads or carries a token, key or value.

import { skewClassFor } from "./client-diag/ring.ts";
import type { ClientDiagSkewClass } from "./client-diag/vocab.ts";

// __CONSOLE_VERSION__ is substituted at build time (see scripts/stamp-build.mjs). It intentionally may not
// exist at runtime (Node validators run the source without the define), so it is only ever read behind a
// `typeof` guard, which is safe on an undeclared identifier.
declare const __CONSOLE_VERSION__: string | undefined;

// consoleVersion returns the version baked into this running bundle, or null when this build is unstamped
// (honest absence, never a guess). The served bundle is always stamped (`npm run build` always defines it);
// null happens in Node validator runs and would happen in a hand-rolled dev build.
export function consoleVersion(): string | null {
  return typeof __CONSOLE_VERSION__ === "string" && __CONSOLE_VERSION__.trim() !== "" ? __CONSOLE_VERSION__ : null;
}

// ServedVersionRead is the CLASSIFIED read. fetchServedConsoleVersion below collapses four completely
// different failures into one null, and that collapse is exactly why an applied console update that was never
// actually served left no evidence anywhere: the check could only ever say "not confirmed", and "not confirmed"
// covers a CDN still serving the old build, an asset deploy that never landed, an Access page interposed on the
// console's own origin, and a bundle carrying no version stamp at all. Those are four different remedies. The
// class is a frozen product constant chosen by THIS function; the served version string is kept for the caller's
// on-screen compare and never enters the diagnostics ring.
export type ServedVersionReadClass = "ok" | "unreachable" | "non-json" | "unstamped";
export interface ServedVersionRead {
  version: string | null;
  readClass: ServedVersionReadClass;
}

// readServedConsoleVersion is the classifying read: what did the origin say when we asked it what console build
// it serves? Never throws (a fetch fault is `unreachable`), so the poll above it stays bounded and simple.
export async function readServedConsoleVersion(fetchFn?: (input: string, init?: RequestInit) => Promise<Response>): Promise<ServedVersionRead> {
  const doFetch = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let r: Response;
  try {
    r = await doFetch("/__build.json", { cache: "no-store" });
  } catch {
    return { version: null, readClass: "unreachable" };
  }
  if (!r.ok) return { version: null, readClass: "unreachable" };
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    // Not JSON at all. An Access login page answering on the console's own origin looks precisely like this,
    // and it is a different fault from a stale CDN. The body is inspected for parseability and discarded: no
    // part of it is read into a field.
    return { version: null, readClass: "non-json" };
  }
  if (typeof body !== "object" || body === null) return { version: null, readClass: "non-json" };
  const v = (body as Record<string, unknown>).version;
  if (typeof v !== "string" || v.trim() === "") return { version: null, readClass: "unstamped" };
  return { version: v, readClass: "ok" };
}

// fetchServedConsoleVersion reads the version the ORIGIN currently serves from /__build.json, bypassing
// every cache (cache: no-store), so a just-swapped console deploy is seen as soon as the edge serves it.
// Returns null on any fault (a non-2xx, a non-JSON body, a missing/empty version) rather than throwing:
// the caller polls, and a transient fault is just "not confirmed yet". fetchFn is injectable for the
// validators; the default wraps the global fetch in an arrow so it is never called detached (a detached
// fetch throws "Illegal invocation" in browsers). It is the thin version-only wrapper over the classifying
// read above, so there is one reader and the two cannot disagree about what the origin said.
export async function fetchServedConsoleVersion(fetchFn?: (input: string, init?: RequestInit) => Promise<Response>): Promise<string | null> {
  return (await readServedConsoleVersion(fetchFn)).version;
}

// recordServedBundleSkew asks the ONE version question the browser can answer and the engine cannot: is
// this tab running the bundle its own origin is serving? It is the stale-asset diagnosis in one row -- the dead
// Approve button, the feature that is silently off, "the console update says it did not take effect" -- and
// until now the pack carried nothing at all about the browser's build, so every one of those tickets was
// indistinguishable from a console defect.
//
// It runs at BOOT, once, and never throws (readServedConsoleVersion classifies its own faults rather than
// raising), so a fault here can never affect the console coming up. The version strings are read to SELECT a
// closed member and are never copied into the row; the running build is carried separately, and deliberately,
// as the shape-gated `consoleBuild` on the payload envelope.
export async function recordServedBundleSkew(
  record: (cls: ClientDiagSkewClass) => void,
  read: () => Promise<ServedVersionRead> = () => readServedConsoleVersion(),
  running: string | null = consoleVersion(),
): Promise<void> {
  const served = await read().catch((): ServedVersionRead => ({ version: null, readClass: "unreachable" }));
  record(skewClassFor(running, served.version, served.readClass));
}

// normalisedVersion strips the optional leading "v" and surrounding whitespace so "v0.2.0" and "0.2.0"
// compare equal (the channel and package.json may reasonably differ in the prefix). Pure.
function normalisedVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

// PollOutcome is the CLASSIFIED result of the bounded post-apply poll: did the origin end up serving the
// expected build, and if not, what was it doing instead at the end of the window? `readClass` is the LAST read's
// class, which is the honest statement of the state the check gave up in (a transient unreachable followed by a
// steady wrong version is a wrong version, not a network fault).
export interface PollOutcome {
  confirmed: boolean;
  readClass: ServedVersionReadClass;
}

// pollForServedVersionRead is pollForServedVersion with the class kept. Same bounded budget, same normalised
// compare, same "a throw is a failed attempt, never an escape".
export async function pollForServedVersionRead(
  expected: string,
  readVersion: () => Promise<ServedVersionRead>,
  attempts = 6,
  delayMs = 1000,
): Promise<PollOutcome> {
  const tries = Math.max(1, Math.floor(attempts));
  let last: ServedVersionRead = { version: null, readClass: "unreachable" };
  for (let i = 0; i < tries; i++) {
    last = await readVersion().catch((): ServedVersionRead => ({ version: null, readClass: "unreachable" }));
    if (last.version !== null && normalisedVersion(last.version) === normalisedVersion(expected)) {
      return { confirmed: true, readClass: "ok" };
    }
    if (i < tries - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { confirmed: false, readClass: last.readClass };
}

// pollForServedVersion polls fetchVersion until the origin serves `expected` (normalised compare), up to
// `attempts` reads spaced `delayMs` apart. BOUNDED by construction: at most `attempts` fetches, so the
// post-apply check can never spin forever; the caller decides what a false (not confirmed) means. A
// fetcher throw counts as a failed attempt, never an escape. Injectable fetcher + delay so the validators
// drive every path without a network or a real clock.
export async function pollForServedVersion(
  expected: string,
  fetchVersion: () => Promise<string | null>,
  attempts = 6,
  delayMs = 1000,
): Promise<boolean> {
  const tries = Math.max(1, Math.floor(attempts));
  for (let i = 0; i < tries; i++) {
    const served = await fetchVersion().catch(() => null);
    if (served !== null && normalisedVersion(served) === normalisedVersion(expected)) return true;
    if (i < tries - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
