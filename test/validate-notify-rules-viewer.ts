// A viewer sees the notification rules the engine lets them read, even though the channel read is refused.
//
//   node test/validate-notify-rules-viewer.ts
//
// The engine opens GET /notify/rules to every signed-in role but gates GET /notify/channels on
// notify.config, because a channel carries its webhook URL or routing key (engine src/admin/router-ops.ts).
// The Rules panel loaded all three reads in one Promise.all, so a viewer's 403 on channels rejected the lot
// and the panel showed an error block in place of rules the engine had just sent. The panel now renders the
// rules with channel ids on a 403 from the channel read alone, and still fails on any other channel fault.
//
// It drives the real panel through the real EngineClient over a stubbed fetch, so the 403 is classified by
// the same transport and classifier a browser would use.

import { installDomShim, textOf } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts
installDomShim();

const { renderRulesPanel } = await import("../src/screens/notifications/rules.ts");
const { EngineClient } = await import("../src/api.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RULES = [{ id: "r1", scope: { kind: "global" }, minSeverity: "warn", events: ["run-failed"], channelIds: ["ch-ops-slack"], enabled: true }];
const CHANNELS = [{ id: "ch-ops-slack", name: "Ops Slack", kind: "slack", enabled: true }];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

// panelWith renders the Rules panel as `role`, answering the channel read with `channels`.
async function panelWith(role: string, channels: () => Response): Promise<string> {
  store.setCaller({ method: "access", email: `${role}@example.com`, role, groups: [], isOnlyOwner: false } as never);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/admin/notify/rules")) return json(200, RULES);
    if (url.endsWith("/admin/notify/channels")) return channels();
    if (url.endsWith("/admin/downpipes")) return json(200, []);
    return json(404, { error: "not found" });
  }) as typeof fetch;
  try {
    const el = renderRulesPanel(new EngineClient("https://engine.test"));
    markConnected(el as unknown as never);
    await flush();
    return textOf(el as unknown as never);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main(): Promise<void> {
  console.log("(1) a viewer, whose channel read the engine refuses with 403, sees the rules");
  {
    const t = await panelWith("viewer", () => json(403, { error: "forbidden", required: "notify.config" }));
    ok("(1a) the rules table renders", t.includes("Routing rules") && t.includes("Min severity"));
    ok("(1b) the rule's channel shows by its id", t.includes("ch-ops-slack"));
    ok("(1c) the panel says why channels show by id", t.includes("Your role cannot read channel settings"));
    ok("(1d) the rule does not read as delivering nowhere", !t.includes("delivers nowhere"));
    ok("(1e) no 'add a channel first' banner for a list it could not read", !t.includes("Add a channel before adding a rule"));
  }

  console.log("\n(2) an owner who can read channels sees names, as before");
  {
    const t = await panelWith("owner", () => json(200, CHANNELS));
    ok("(2a) the channel shows by name", t.includes("Ops Slack"));
    ok("(2b) no by-id note", !t.includes("Your role cannot read channel settings"));
  }

  console.log("\n(3) a channel read that fails for another reason still fails the panel");
  {
    const t = await panelWith("owner", () => json(500, { error: "internal" }));
    ok("(3a) a 500 on channels does not render the rules table", !t.includes("Routing rules"));
  }

  console.log(`\n${failures === 0 ? "NOTIFY-RULES-VIEWER OK: a viewer sees the rules the engine lets them read" : `${failures} FAILURE(S)`}`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
