// Sign-out, driven the way an operator drives it: the console is booted from its entry point (src/app.ts),
// the shell's "Sign out" button is clicked, and the engine's logout answer is stubbed at the network.
//
//   node test/validate-sign-out-wiring.ts
//
// Everything here goes through the console's own parts: app.ts (the entry, which boots on import), the
// shell's rendered button (data-dp shell-chrome.button.sign-out#2, the degraded account area every boot
// starts in), the real store, the real EngineClient over a stubbed fetch, the real router writing to a
// recorded history, and the real toast over the DOM shim.
//
// Sign-out asks the engine to end the session BEFORE the store drops the engine client, local sign-out
// completes whether or not the engine answers, and when the engine does not confirm (it fails, refuses or
// stays silent past the wait) the operator is shown a warning that stays on screen. A confirmed logout
// shows none.

import { installDomShim } from "./dom-shim.ts";

installDomShim();

import { qs, qsa, textOf, flushAsync } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The agreed warning. Written out here, not imported, so the test names the words the operator reads.
const UNCONFIRMED =
  "Signed out of this console, but the engine did not confirm that the session ended. It can stay valid until it expires. To end it now, sign in again and use Sign out my other sessions.";
// Longer than the console's wait for the engine, so a silent engine has timed out by the time we look.
const PAST_THE_WAIT_MS = 3600;

const g = globalThis as unknown as Record<string, unknown> & { fetch: (input: unknown, init?: unknown) => Promise<Response> };

// A location and history the real router can drive: pushState / replaceState move the path and are recorded.
const pushed: string[] = [];
const loc = { origin: "https://console.test", protocol: "https:", host: "console.test", hostname: "console.test", pathname: "/", search: "", hash: "" };
function moveTo(url: unknown): void {
  const u = new URL(String(url), "https://console.test");
  loc.pathname = u.pathname;
  loc.search = u.search;
  loc.hash = u.hash;
}
g.location = loc;
g.history = {
  pushState: (_s: unknown, _t: unknown, url?: unknown) => {
    if (url !== undefined) {
      pushed.push(new URL(String(url), "https://console.test").pathname);
      moveTo(url);
    }
  },
  replaceState: (_s: unknown, _t: unknown, url?: unknown) => {
    if (url !== undefined) moveTo(url);
  },
};

const appHost = document.createElement("div");
appHost.id = "app";
document.body.appendChild(appHost);

// The network. Every call is recorded; the logout call gets the scripted answer, anything else the boot asks
// for (identity, setup, counts) is refused with a 404 so boot settles without touching a real engine.
let logoutAnswer: () => Promise<Response> = async () => new Response("{}", { status: 200 });
const calls: string[] = [];
let lastLogoutInit: { signal?: AbortSignal } | undefined;
g.fetch = async (input: unknown, init?: unknown): Promise<Response> => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith("/admin/auth/logout")) {
    lastLogoutInit = init as { signal?: AbortSignal } | undefined;
    return logoutAnswer();
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

// The console remembers an engine, then boots from its entry point. app.ts boots on import.
const store = await import("../src/lib/store.ts");
store.connect("https://engine.example.invalid");
await import("../src/app.ts");
await flushAsync();

const signOutButton = (): ReturnType<typeof qs> => qs(document, '[data-dp="shell-chrome.button.sign-out#2"]');
// The assertive toast region is created on the first assertive toast, so before one it holds no text.
const warnText = (): string => {
  const region = qs(document, ".toast-region--assertive");
  return region ? textOf(region) : "";
};
const warnings = (): number => warnText().split(UNCONFIRMED).length - 1;
const logoutCalls = (): number => calls.filter((u) => u.endsWith("/admin/auth/logout")).length;

interface Click {
  logoutSentWithEngine: boolean;
  engineAfter: boolean;
  navigatedToSignIn: boolean;
}

// clickSignOut presses the real shell button once and reports what was visible at the moment of the press.
async function clickSignOut(answer: () => Promise<Response>, afterConnect?: (client: { passkeyLogout(): Promise<{ ok: boolean }> }) => void): Promise<Click> {
  logoutAnswer = answer;
  // Each press starts from a connected console, as an operator who is signed in would be.
  store.connect("https://engine.example.invalid");
  const signedInClient = store.getEngine();
  if (afterConnect && signedInClient) afterConnect(signedInClient as unknown as { passkeyLogout(): Promise<{ ok: boolean }> });
  const button = signOutButton();
  const callsBefore = logoutCalls();
  const pushedBefore = pushed.length;
  try {
    button?.click();
  } catch {
    // A throw that escapes the click handler shows up as the state assertions below, not as a crash.
  }
  // The shell runs its sign-out handler after the click event settles, so read state once it has.
  await flushAsync();
  const sent = logoutCalls() > callsBefore;
  // The sign-in route reconnects a fresh client to the remembered URL (no session), so "dropped" means the
  // signed-in client is not the store's client, not that the store holds none.
  const engineAfter = signedInClient !== null && store.getEngine() === signedInClient;
  return { logoutSentWithEngine: sent, engineAfter, navigatedToSignIn: pushed.slice(pushedBefore).includes("/passkey") };
}

async function main(): Promise<void> {
  ok("(0) the shell rendered a Sign out button to press", signOutButton() !== null && qsa(document, '[data-dp="shell-chrome.button.sign-out#2"]').length === 1);

  console.log("\n(1) the engine cannot be reached: local sign-out completes and the operator is shown the warning");
  {
    const before = warnings();
    const run = await clickSignOut(async () => {
      throw new TypeError("network down");
    });
    ok("(1a) pressing Sign out sent the logout request to the engine", run.logoutSentWithEngine);
    ok("(1b) local state is cleared: the store dropped the engine", !run.engineAfter);
    ok("(1c) the console went to the sign-in", run.navigatedToSignIn);
    ok("(1d) the failure is SHOWN: a warning carries the unconfirmed message", warnings() === before + 1);
  }

  console.log("\n(2) the engine refuses (a 500 answer): the same warning");
  {
    const before = warnings();
    const run = await clickSignOut(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500, headers: { "content-type": "application/json" } }));
    ok("(2a) the logout request was sent", run.logoutSentWithEngine);
    ok("(2b) a refused logout raises another warning", warnings() === before + 1);
    ok("(2c) local sign-out still completed", !run.engineAfter && run.navigatedToSignIn);
  }

  console.log("\n(3) the engine stays silent past the wait: local sign-out completes and the warning follows");
  {
    const before = warnings();
    const run = await clickSignOut(() => new Promise<Response>(() => {}));
    ok("(3a) the logout request was sent", run.logoutSentWithEngine);
    ok("(3b) local sign-out did not wait for the engine", !run.engineAfter && run.navigatedToSignIn);
    await new Promise<void>((r) => setTimeout(r, PAST_THE_WAIT_MS));
    await flushAsync();
    ok("(3c) once the wait has passed the operator is shown the warning", warnings() === before + 1);
    ok("(3d) the logout request was aborted at the wait cap", lastLogoutInit?.signal?.aborted === true);
  }

  console.log("\n(4) control: a confirmed logout shows no warning");
  {
    const before = warnings();
    const run = await clickSignOut(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    ok("(4a) the logout was still requested", run.logoutSentWithEngine);
    ok("(4b) local sign-out completed", !run.engineAfter && run.navigatedToSignIn);
    await new Promise<void>((r) => setTimeout(r, PAST_THE_WAIT_MS));
    await flushAsync();
    ok("(4c) no new warning is raised, now or after the wait", warnings() === before);
  }

  console.log("\n(5) the logout call throws synchronously: local sign-out completes and one warning shows");
  {
    // A throw that escapes the click handler is uncaught; record it so the run reports it as an assertion.
    const proc = (globalThis as unknown as { process: { on(e: string, f: (x: unknown) => void): void; off(e: string, f: (x: unknown) => void): void } }).process;
    let escaped = 0;
    const onEscape = (): void => { escaped++; };
    proc.on("uncaughtException", onEscape);
    const before = warnings();
    const run = await clickSignOut(async () => new Response("{}", { status: 200 }), (client) => {
      client.passkeyLogout = () => { throw new Error("sync boom"); };
    });
    ok("(5a) local sign-out completed", !run.engineAfter && run.navigatedToSignIn);
    ok("(5b) exactly one new warning is shown", warnings() === before + 1);
    proc.off("uncaughtException", onEscape);
    ok("(5c) nothing escaped the click handler", escaped === 0);
  }

  console.log(`\n${failures === 0 ? "SIGN-OUT WIRING OK: the logout is requested before local state drops, and an unconfirmed one is shown" : `${failures} FAILURE(S)`}`);
  verdictReached(failures);
  // The booted console keeps timers alive, so leave explicitly, after stdout has drained.
  const proc = (globalThis as unknown as { process: { exit(code: number): never; stdout: { write(s: string, cb: () => void): void } } }).process;
  proc.stdout.write("", () => proc.exit(failures > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
