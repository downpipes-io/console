// Sign-out reports an engine session it could not confirm ended.
//
//   node test/validate-sign-out.ts
//
// endEngineSession is the engine-side half of the console's sign-out. It resolves "ended" only when the
// engine answers ok within the bound; a rejection, a refusal and silence all resolve "unconfirmed", which
// the sign-out path turns into a visible warning. It never rejects, so local sign-out always completes.

import { endEngineSession, SIGN_OUT_UNCONFIRMED_MESSAGE } from "../src/lib/sign-out.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  console.log("(1) the engine confirms: ended");
  ok("(1a) ok:true resolves ended", (await endEngineSession({ passkeyLogout: async () => ({ ok: true }) }, 200)) === "ended");

  console.log("\n(2) the engine cannot be reached or does not confirm: unconfirmed, never a rejection");
  let seen: unknown;
  const rejected = await endEngineSession({ passkeyLogout: async () => { throw new Error("network down"); } }, 200, (e) => { seen = e; });
  ok("(2a) a transport failure resolves unconfirmed", rejected === "unconfirmed");
  ok("(2b) the failure reaches the diagnostics callback", seen instanceof Error);
  ok("(2c) ok:false resolves unconfirmed", (await endEngineSession({ passkeyLogout: async () => ({ ok: false }) }, 200)) === "unconfirmed");
  const started = Date.now();
  const silent = await endEngineSession({ passkeyLogout: () => new Promise<{ ok: boolean }>(() => {}) }, 50);
  ok("(2d) no answer within the bound resolves unconfirmed", silent === "unconfirmed");
  ok("(2e) the wait is bounded", Date.now() - started < 1000);

  console.log("\n(3) no engine client: nothing to end");
  ok("(3a) null resolves none", (await endEngineSession(null, 200)) === "none");

  console.log("\n(5) a synchronous throw, an abort at the bound, and a late reply");
  let syncSeen: unknown;
  const syncThrow = await endEngineSession({ passkeyLogout: () => { throw new Error("sync boom"); } }, 200, (e) => { syncSeen = e; }).catch(() => "rejected");
  ok("(5a) a synchronous throw resolves unconfirmed", syncThrow === "unconfirmed");
  ok("(5b) the synchronous throw reaches the diagnostics callback", syncSeen instanceof Error);
  let silentSignal: AbortSignal | undefined;
  await endEngineSession({ passkeyLogout: (s?: AbortSignal) => { silentSignal = s; return new Promise<{ ok: boolean }>(() => {}); } }, 50);
  ok("(5c) silence past the bound aborts the request signal", silentSignal?.aborted === true);
  let lateSignal: AbortSignal | undefined;
  let lateErr = 0;
  const late = await endEngineSession(
    { passkeyLogout: (s?: AbortSignal) => { lateSignal = s; return new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), 100)); } },
    50,
    () => { lateErr++; },
  );
  await new Promise<void>((r) => setTimeout(r, 150));
  ok("(5d) a reply after the bound leaves the outcome unconfirmed", late === "unconfirmed" && lateSignal?.aborted === true);
  ok("(5e) a reply after the bound does not call onError", lateErr === 0);
  let abortErr = 0;
  await endEngineSession(
    { passkeyLogout: (s?: AbortSignal) => new Promise<{ ok: boolean }>((_r, rej) => s?.addEventListener("abort", () => rej(new Error("aborted")))) },
    50,
    () => { abortErr++; },
  );
  await new Promise<void>((r) => setTimeout(r, 20));
  ok("(5f) a rejection caused by our own abort does not call onError", abortErr === 0);
  let okSignal: AbortSignal | undefined;
  await endEngineSession({ passkeyLogout: async (s?: AbortSignal) => { okSignal = s; return { ok: true }; } }, 200);
  ok("(5g) a confirmed answer in time leaves the signal not aborted", okSignal !== undefined && okSignal.aborted === false);

  console.log("\n(4) the warning does not claim the session ended");
  ok("(4a) it says the engine did not confirm", SIGN_OUT_UNCONFIRMED_MESSAGE.includes("did not confirm"));
  ok("(4b) it names the remedy", SIGN_OUT_UNCONFIRMED_MESSAGE.includes("Sign out my other sessions"));

  console.log(`\n${failures === 0 ? "SIGN-OUT OK: an unconfirmed engine session is reported, never dropped" : `${failures} FAILURE(S)`}`);
  verdictReached(failures);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
