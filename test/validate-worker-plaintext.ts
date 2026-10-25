// The console Worker refuses the claim-code POST over plaintext http and sends a plaintext navigation to https.
//
//   node test/validate-worker-plaintext.ts
//
// The claim code is a bearer secret for licence activation. A request that arrives over http:// on a
// non-loopback host must never reach the control-plane proxy: the POST is answered 400 and the upstream
// fetch is never called. A GET or HEAD is answered 308 to the https form of the same URL. Loopback hosts
// (the wrangler dev seam) and https requests are unaffected.

import consoleWorker from "../src/worker.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const g = globalThis as unknown as { fetch: (input: unknown, init?: unknown) => Promise<Response> };
const realFetch = g.fetch;
let upstreamCalls = 0;
g.fetch = async () => {
  upstreamCalls++;
  return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
};

const env = { ASSETS: { fetch: async () => new Response("shell", { status: 200 }) } };
const fetchFn = (consoleWorker as unknown as { fetch: (req: Request, env: unknown) => Promise<Response> }).fetch;
const claim = (url: string): Request => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":"abc"}' });

async function main(): Promise<void> {
  console.log("(1) a claim-code POST over plaintext http is refused and never forwarded");
  {
    upstreamCalls = 0;
    const res = await fetchFn(claim("http://console.example/control-plane/licence/claim"), env);
    ok("(1a) status is 400", res.status === 400);
    ok("(1b) the control plane was never called", upstreamCalls === 0);
    ok("(1c) the refusal is not cached", res.headers.get("cache-control") === "no-store");
    ok("(1d) the refusal carries the console security headers", (res.headers.get("strict-transport-security") ?? "").includes("max-age="));
  }

  console.log("\n(2) a plaintext navigation is redirected to https");
  {
    const res = await fetchFn(new Request("http://console.example/canary?tab=x"), env);
    ok("(2a) GET answers 308", res.status === 308);
    ok("(2b) Location is the https form of the same URL", res.headers.get("location") === "https://console.example/canary?tab=x");
    const head = await fetchFn(new Request("http://console.example/", { method: "HEAD" }), env);
    ok("(2c) HEAD answers 308", head.status === 308);
  }

  console.log("\n(3) controls: loopback and https pass through");
  {
    upstreamCalls = 0;
    const https = await fetchFn(claim("https://console.example/control-plane/licence/claim"), env);
    ok("(3a) https claim POST reaches the control plane", https.status === 200 && upstreamCalls === 1);
    upstreamCalls = 0;
    const local = await fetchFn(claim("http://localhost:8787/control-plane/licence/claim"), env);
    ok("(3b) loopback http claim POST passes", local.status === 200 && upstreamCalls === 1);
    const ip = await fetchFn(new Request("http://127.0.0.1:8787/"), env);
    ok("(3c) loopback http GET is served, not redirected", ip.status === 200);
    const page = await fetchFn(new Request("https://console.example/"), env);
    ok("(3d) https GET is served", page.status === 200);
  }

  g.fetch = realFetch;
  console.log(`\n${failures === 0 ? "PLAINTEXT OK: the claim POST is refused and navigations are redirected over http, https and loopback unaffected" : `${failures} FAILURE(S)`}`);
  verdictReached(failures);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
