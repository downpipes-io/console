// Coverage validator for src/lib/api/client.ts (the EngineClient transport).
// Run with: node test/cov/lib-api-client.ts (auto-run by test/cov/run.mjs, part of npm run validate).
//
// client.ts is a pure, DOM-free transport: ~95 thin methods over fetch plus a small set of shared
// response helpers that hold almost all the branching (parseJson / parseJsonOrPending /
// parseJsonOrOwnerAction / gatedFetch / readErrorReason / readOwnerActionQueued / failResponse). The
// existing validate-*.ts suite exercises only a slice of the surface, so this validator drives the REAL
// EngineClient over a stubbed global fetch and asserts a meaningful outcome for:
//   - the constructor's origin guard (https accepted, http-localhost accepted, non-https rejected) and
//     the trailing-slash strip, plus headers() with and without a bearer
//   - every shared response helper across its success, deferred (202), error-fold and Access-redirect
//     branches, so a body that is HTML where JSON was expected is named honestly, a 202 resolves to a
//     pending/queued result rather than a false success, and an engine { error } reason is folded into
//     the thrown message
//   - the step-up gatedFetch ceremony: a 401 { stepUpRequired } retries ONCE with the header, a cancel
//     surfaces the original 401, a non-step-up 401 and an unparseable 401 pass straight through, and a
//     client with no ceremony wired never retries
//   - every public method's happy path (its route, verb and parsed result) and, for the methods that
//     fold an engine reason, their non-2xx error branch
//   - the pure path/URL builders (oidcStartPath / samlStartPath / idpStartUrlFor / samlMetadataUrl /
//     idpRedirectUri / samlAcsUrl) across their returnTo guard
//
// No DOM and no network: a stubbed fetch answers each canned Response, so the assertions check the
// client's own contract (mapping, branching, throw messages), never the engine.

import { EngineClient } from "../../src/api.ts";
import { ACCESS_REDIRECT_MARKER, classifyError, RESTORE_UNAPPROVED_REASON } from "../../src/lib/errors.ts";

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}
function eq(a: unknown, b: unknown, label: string): void {
  const cond = a === b;
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}  got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// fetch doubles. Each installs a global fetch and returns a restore function. The shapes mirror the
// minimal Response surface the client consumes (ok/status/text/json/arrayBuffer/clone), exactly as the
// existing validators stub it, so a real EngineClient method runs its real parse helper over the canned
// answer.
// ---------------------------------------------------------------------------

type FetchInit = { method?: string; headers?: unknown; body?: unknown };

interface CannedOpts {
  status: number;
  // text is what r.text() returns; json() parses it (so a non-JSON text triggers the client's catch).
  text: string;
  // arrayBuffer backs the binary readers (getReportPDF / getEvidencePackPDF); defaults to empty.
  arrayBuffer?: ArrayBuffer;
  // textThrows / jsonThrows model an unreadable body (failResponse's catch, parseJson's catch).
  textThrows?: boolean;
  // headers the canned response carries. Only the console worker's own binding-absent marker is read today.
  headers?: Record<string, string>;
}

// stub installs a fetch answering one canned Response for every call.
function stub(opts: CannedOpts): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const make = () => ({
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    // A real Response ALWAYS has headers, and the transport reads them: the console's own worker marks its
    // engine-binding-absent 503 with a header, which is how the recording seam tells that 503 from an
    // engine's own without consuming the body it may not consume. A canned response with no headers is not a
    // Response, and a fixture that is not the thing under test proves nothing about it.
    headers: new Headers(opts.headers ?? {}),
    async text(): Promise<string> {
      if (opts.textThrows) throw new Error("unreadable body");
      return opts.text;
    },
    async json(): Promise<unknown> {
      return JSON.parse(opts.text);
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return opts.arrayBuffer ?? new ArrayBuffer(0);
    },
    clone(): unknown {
      return make();
    },
  });
  g.fetch = async () => make();
  return () => {
    g.fetch = prev;
  };
}

// record installs a fetch that records each call (url + method + parsed body + header presence) and
// answers a single canned 200, so a method's route, verb and request body can be asserted.
function record(text: string): {
  calls: Array<{ url: string; method: string; body: unknown; auth: string | null; stepup: string | null }>;
  restore: () => void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null; stepup: string | null }> = [];
  g.fetch = async (url: string, init?: FetchInit) => {
    let body: unknown ;
    if (typeof init?.body === "string" && init.body !== "") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const h = init?.headers as Record<string, string> | Headers | undefined;
    const readHeader = (name: string): string | null => {
      if (h === undefined) return null;
      if (h instanceof Headers) return h.get(name);
      return h[name] ?? h[name.toLowerCase()] ?? null;
    };
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      auth: readHeader("authorization"),
      stepup: readHeader("x-downpipes-stepup"),
    });
    return {
      ok: true,
      status: 200,
      async text(): Promise<string> {
        return text;
      },
      async json(): Promise<unknown> {
        return JSON.parse(text);
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },
      clone(): unknown {
        return this;
      },
    };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

// stepUpFetch models the step-up ceremony at the transport: the FIRST call answers the given status with
// the given body (a 401 { stepUpRequired } drives the retry); the SECOND call answers a canned 200 and is
// recorded so the retry's header can be inspected.
function stepUpFetch(firstStatus: number, firstBody: string): {
  calls: Array<{ stepup: string | null }>;
  restore: () => void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.fetch;
  const calls: Array<{ stepup: string | null }> = [];
  let n = 0;
  g.fetch = async (_url: string, init?: FetchInit) => {
    n += 1;
    const h = init?.headers;
    let stepup: string | null = null;
    if (h instanceof Headers) stepup = h.get("x-downpipes-stepup");
    else if (h && typeof h === "object") stepup = (h as Record<string, string>)["x-downpipes-stepup"] ?? null;
    calls.push({ stepup });
    if (n === 1) {
      return {
        ok: firstStatus >= 200 && firstStatus < 300,
        status: firstStatus,
        async text(): Promise<string> { return firstBody; },
        async json(): Promise<unknown> { return JSON.parse(firstBody); },
        clone(): unknown {
          return {
            async json(): Promise<unknown> { return JSON.parse(firstBody); },
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text(): Promise<string> { return JSON.stringify({ ok: true }); },
      async json(): Promise<unknown> { return { ok: true }; },
      clone(): unknown { return this; },
    };
  };
  return { calls, restore: () => { g.fetch = prev; } };
}

async function expectThrow(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "__did-not-throw__";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  const HTML = "<!doctype html><html><body>Cloudflare Access login</body></html>";

  // ========================================================================
  console.log("\n-- constructor: origin guard + trailing-slash strip + headers() --");
  // ========================================================================
  {
    const https = new EngineClient("https://engine.test/");
    const rec = record(JSON.stringify({ ok: true }));
    await https.health();
    eq(rec.calls[0]?.url, "https://engine.test/admin/health", "https origin accepted and the trailing slash is stripped");
    rec.restore();

    // http is permitted ONLY for a localhost dev engine; the request builds off the bare base.
    const local = new EngineClient("http://127.0.0.1:8787");
    const rec2 = record(JSON.stringify({ ok: true }));
    await local.health();
    eq(rec2.calls[0]?.url, "http://127.0.0.1:8787/admin/health", "http localhost origin accepted");
    rec2.restore();

    // A non-localhost http origin is refused in the constructor, before any request is built.
    const threw = await expectThrow(async () => new EngineClient("http://engine.test"));
    ok("a non-https non-localhost origin throws in the constructor", threw !== "__did-not-throw__");

    // headers(): a token-bearing client sends the bearer; a tokenless client sends none.
    const withTok = new EngineClient("https://engine.test", "tok-abc");
    const rec3 = record(JSON.stringify([]));
    await withTok.listRoles();
    eq(rec3.calls[0]?.auth, "Bearer tok-abc", "headers() carries the bearer when a token is set");
    rec3.restore();

    const noTok = new EngineClient("https://engine.test");
    const rec4 = record(JSON.stringify([]));
    await noTok.listRoles();
    eq(rec4.calls[0]?.auth, null, "headers() carries no authorization when no token is set");
    rec4.restore();
  }

  const engine = new EngineClient("https://engine.test");

  // ========================================================================
  console.log("\n-- parseJson: success, redirect-on-2xx, bad-json-on-2xx, non-2xx redirect, non-2xx plain --");
  // ========================================================================
  {
    let restore = stub({ status: 200, text: JSON.stringify({ ok: true, service: "engine" }) });
    const h = await engine.health();
    ok("a 200 JSON body parses to the typed value", h.ok === true && h.service === "engine");
    restore();

    // A 200 whose body is an Access login HTML (not JSON) is named as an access-redirect, not a parse fault.
    restore = stub({ status: 200, text: HTML });
    let msg = await expectThrow(() => engine.whoami());
    ok("a 200 HTML (Access login) body throws the access-redirect marker", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();

    // A 200 whose body is neither JSON nor a recognisable redirect degrades to the "<verb>: <status>" throw.
    restore = stub({ status: 200, text: "not json at all" });
    msg = await expectThrow(() => engine.whoami());
    ok("a 200 non-JSON non-redirect body throws verb + status", msg.includes("whoami: 200"));
    restore();

    // A non-2xx HTML body is recognised as an access-redirect via failResponse.
    restore = stub({ status: 403, text: HTML });
    msg = await expectThrow(() => engine.whoami());
    ok("a non-2xx HTML body throws the access-redirect marker", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();

    // A non-2xx plain body throws the bare "<verb>: <status>".
    restore = stub({ status: 500, text: "boom" });
    msg = await expectThrow(() => engine.whoami());
    ok("a non-2xx plain body throws verb + status", msg.includes("whoami: 500"));
    restore();

    // failResponse's catch: a non-2xx body that cannot even be read still throws verb + status.
    restore = stub({ status: 502, text: "", textThrows: true });
    msg = await expectThrow(() => engine.whoami());
    ok("a non-2xx body that cannot be read throws verb + status", msg.includes("whoami: 502"));
    restore();
  }

  // ========================================================================
  console.log("\n-- parseJsonOrPending: applied (200), pending (202), malformed-202 throws (B8), errors --");
  // ========================================================================
  {
    // 200 applied: the change-control gate is off, the record flows straight through.
    let restore = stub({ status: 200, text: JSON.stringify({ id: "d_1", name: "nightly" }) });
    let res = await engine.addDownpipe({ id: "d_1", name: "nightly" } as never);
    ok("a 200 config mutation resolves to status:applied", res.status === "applied");
    ok("the applied value is the parsed record", res.status === "applied" && (res.value as unknown as { id: string }).id === "d_1");
    restore();

    // 202 + a pending body: queued for a second approver, with the change id read out.
    restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg_9", status: "pending", contentHash: "h9" }) });
    res = await engine.addDownpipe({ id: "d_1", name: "nightly" } as never);
    ok("a 202 pending body resolves to status:pending", res.status === "pending");
    ok("the pending changeId is read from the body", res.status === "pending" && res.changeId === "chg_9");
    // The engine's 202 carries queued/id/status/contentHash and NO `kind` (src/sched/scheduler-do.ts), so the
    // result models the id and nothing more. It used to model a `kind` the wire never carried.
    ok("the raw pending body is the engine's, verbatim", res.status === "pending" && res.raw.queued === true && res.raw.id === "chg_9");
    restore();

    // A 202 carrying only the two fields the guard requires: still pending.
    restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg_10" }) });
    res = await engine.addDownpipe({ id: "d_1", name: "nightly" } as never);
    ok("a 202 with just { queued, id } is still pending", res.status === "pending" && res.changeId === "chg_10");
    restore();

    // B8: a malformed 202 (not the pending shape) THROWS an honest answer-unreadable error instead of
    // being coerced into a false applied value (confirmed live by the write-fault capability's
    // fulfilMalformed202 probe on this exact route). The message carries the 202 status, exactly like
    // parseJson's own throw for an illegible 2xx body, so classifyError names it answer-unreadable.
    restore = stub({ status: 202, text: JSON.stringify({ id: "d_2", name: "x" }) });
    let msg = await expectThrow(() => engine.addDownpipe({ id: "d_2", name: "x" } as never));
    ok("a malformed 202 (no queued flag) throws verb + status, never a false applied", msg.includes("add downpipe: 202"));
    restore();

    // A non-2xx routes through failResponse (here a plain status throw).
    restore = stub({ status: 500, text: "nope" });
    msg = await expectThrow(() => engine.addDownpipe({ id: "d", name: "n" } as never));
    ok("a non-2xx config mutation throws verb + status", msg.includes("add downpipe: 500"));
    restore();

    // A 2xx whose body is HTML (Access redirect) on a config-mutation route is named honestly.
    restore = stub({ status: 200, text: HTML });
    msg = await expectThrow(() => engine.addDownpipe({ id: "d", name: "n" } as never));
    ok("a 2xx HTML body on a config mutation throws the access-redirect marker", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();

    // A 2xx whose body is non-JSON non-redirect degrades to verb + status.
    restore = stub({ status: 200, text: "garbage" });
    msg = await expectThrow(() => engine.addDownpipe({ id: "d", name: "n" } as never));
    ok("a 2xx non-JSON non-redirect on a config mutation throws verb + status", msg.includes("add downpipe: 200"));
    restore();
  }

  // ========================================================================
  console.log("\n-- parseJsonOrOwnerAction: queued (202), malformed-202 throws (B8), error fold, no-error --");
  // ========================================================================
  {
    // 202 + the owner-action body: queued for a second owner.
    let restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_1", status: "pending" }) });
    let res = await engine.setDestination(null);
    ok("a 202 owner-action body resolves to status:queued", res.status === "queued");
    ok("the queued owner-action id is carried through", res.status === "queued" && res.queued.id === "oa_1");
    restore();

    // B8: a malformed 202 (not the owner-action shape) THROWS an honest answer-unreadable error instead of
    // being coerced into a false result (confirmed live by the write-fault capability, the same
    // class parseJsonOrPending's own fix carries).
    restore = stub({ status: 202, text: JSON.stringify({ present: true }) });
    let msg = await expectThrow(() => engine.setDestination(null));
    ok("a malformed 202 owner-action throws verb + status, never a false result", msg.includes("set destination: 202"));
    restore();

    // A 202 whose clone().json() THROWS: readOwnerActionQueued's catch returns null exactly as it does for a
    // shape mismatch, so this ALSO throws honestly rather than falling through (the defensive catch changes
    // WHAT is unreadable about the body, never whether an unreadable 202 gets trusted as a value).
    {
      const g = globalThis as unknown as Record<string, unknown>;
      const prev = g.fetch;
      g.fetch = async () => ({
        ok: true,
        status: 202,
        async text(): Promise<string> { return JSON.stringify({ present: true }); },
        async json(): Promise<unknown> { return { present: true }; },
        clone(): unknown {
          return { async json(): Promise<unknown> { throw new Error("clone read failed"); } };
        },
      });
      msg = await expectThrow(() => engine.setDestination(null));
      ok("a 202 whose clone read throws also throws honestly, never a false result", msg.includes("set destination: 202"));
      g.fetch = prev;
    }

    // 200 applied: the gate is off, value flows through as { status:"result" }.
    restore = stub({ status: 200, text: JSON.stringify({ present: true }) });
    res = await engine.setDestination(null);
    ok("a 200 owner mutation resolves to status:result", res.status === "result");
    restore();

    // A non-2xx with an engine { error } reason folds it into the throw in the "<verb>: <reason>: <status>" form.
    restore = stub({ status: 400, text: JSON.stringify({ error: "bucket unreachable" }) });
    msg = await expectThrow(() => engine.setDestination(null));
    ok("a non-2xx { error } owner mutation folds the reason into the throw", msg === "set destination: bucket unreachable: 400");
    restore();

    // A non-2xx with NO usable error degrades to the shared failResponse throw. On a 403 that throw now NAMES THE
    // CLASS OF THE REFUSAL: a body carrying no refusal shape this engine emits is `not-engine-body`, which
    // is the honest reading (something in front of the engine refused it). The trailing status is still the last
    // token, so extractStatus and every classifyError branch read it exactly as before.
    restore = stub({ status: 403, text: JSON.stringify({ other: "x" }) });
    msg = await expectThrow(() => engine.setDestination(null));
    ok("a non-2xx owner mutation with no error degrades to verb + the 403 class + status", msg === "set destination: forbidden-class=not-engine-body: 403");
    restore();

    // B31: parseJsonOrPending routes (notify channel/rule save) now fold the engine's 400 reason too, exactly
    // as the owner-mutation path above does, so a channel-save refusal names WHY (e.g. the SSRF default-deny
    // sentence) instead of a bare "save notify channel: 400".
    restore = stub({ status: 400, text: JSON.stringify({ error: "url points at a private/loopback address" }) });
    msg = await expectThrow(() => engine.upsertNotifyChannel({ kind: "webhook", url: "https://127.0.0.1/x" } as never));
    ok("B31: a notify channel-save 400 folds the engine reason (not a bare status)", msg === "save notify channel: url points at a private/loopback address: 400");
    restore();
    // But a 403 on the SAME route is NOT reason-folded: the fold is gated out for 401/403/429/5xx, so
    // failResponse's forbidden-class marker (the dual-control-inbox 403 distinction) survives intact.
    restore = stub({ status: 403, text: JSON.stringify({ error: "forbidden" }) });
    msg = await expectThrow(() => engine.upsertNotifyChannel({ kind: "webhook", url: "https://h" } as never));
    ok("B31: a notify 403 keeps the forbidden-class marker, not a folded reason", msg.startsWith("save notify channel: forbidden-class=") && msg.endsWith(": 403"));
    restore();
    // The rule-save path (also parseJsonOrPending) folds its 400 reason the same way.
    restore = stub({ status: 400, text: JSON.stringify({ error: "channel not found" }) });
    msg = await expectThrow(() => engine.upsertNotifyRule({ channelId: "c", event: "run.failed" } as never));
    ok("B31: a notify rule-save 400 folds the engine reason", msg === "save notify rule: channel not found: 400");
    restore();

    // B50/B51: the dual-control approve/reject family and the run-trigger now fold the engine's 400 reason via
    // parseJsonOrReason (they returned a plain record through parseJson before, so the reason was discarded).
    restore = stub({ status: 400, text: JSON.stringify({ error: "the base config moved; re-propose" }) });
    msg = await expectThrow(() => engine.approveConfigChange("chg1"));
    ok("B50: an approve-config-change 400 folds the engine reason (superseded/decided)", msg === "approve config change: the base config moved; re-propose: 400");
    restore();
    // A 403 on the same route keeps the forbidden-class marker (the fold is gated out for 401/403/429/5xx).
    restore = stub({ status: 403, text: JSON.stringify({ error: "forbidden" }) });
    msg = await expectThrow(() => engine.approveConfigChange("chg1"));
    ok("B50: an approve-config-change 403 keeps the forbidden-class marker, not a folded reason", msg.startsWith("approve config change: forbidden-class=") && msg.endsWith(": 403"));
    restore();
    // The restore self-approval refusal (a 400) now names itself instead of reading a bare status.
    restore = stub({ status: 400, text: JSON.stringify({ error: "cannot approve your own request" }) });
    msg = await expectThrow(() => engine.approveRestore("hash1"));
    ok("B50: a restore self-approval 400 names the reason", msg === "restore approve: cannot approve your own request: 400");
    restore();
    // B51: run-now on a stale downpipe id folds the engine's "unknown downpipe" reason (the list is stale).
    restore = stub({ status: 400, text: JSON.stringify({ error: "unknown downpipe abc" }) });
    msg = await expectThrow(() => engine.trigger("abc"));
    ok("B51: a trigger 400 folds the unknown-downpipe reason (not a bare status)", msg === "trigger: unknown downpipe abc: 400");
    restore();
  }

  // ========================================================================
  console.log("\n-- readErrorReason: trimmed reason, exact unapproved reason, trailing-status strip, null cases --");
  // ========================================================================
  {
    // The exact dual-control reason is returned verbatim (so classifyError maps restore-unapproved).
    let restore = stub({ status: 403, text: JSON.stringify({ error: "Restore not approved" }) });
    let msg = await expectThrow(() => engine.restore({ runId: "r1", confirm: true } as never));
    ok("restore folds the exact unapproved reason", msg === `restore: ${RESTORE_UNAPPROVED_REASON}: 403`);
    restore();

    // A reason that happens to END in a 3-digit run has it stripped so the appended status stays unambiguous.
    restore = stub({ status: 409, text: JSON.stringify({ error: "conflict on bucket 123" }) });
    msg = await expectThrow(() => engine.restore({ runId: "r1" } as never));
    ok("a reason ending in 3 digits has them stripped before the status is appended", msg === "restore: conflict on bucket: 409");
    restore();

    // An empty error string yields no usable reason, so the path degrades to failResponse (plain status).
    restore = stub({ status: 500, text: JSON.stringify({ error: "   " }) });
    msg = await expectThrow(() => engine.restore({ runId: "r1" } as never));
    ok("an empty error string degrades to the plain status throw", msg.includes("restore: 500"));
    restore();

    // A non-string error yields no usable reason.
    restore = stub({ status: 500, text: JSON.stringify({ error: 42 }) });
    msg = await expectThrow(() => engine.restore({ runId: "r1" } as never));
    ok("a non-string error degrades to the plain status throw", msg.includes("restore: 500"));
    restore();

    // A reason that is ONLY a status-like digit run normalises to null, so it degrades to the plain status.
    restore = stub({ status: 503, text: JSON.stringify({ error: "503" }) });
    msg = await expectThrow(() => engine.restore({ runId: "r1" } as never));
    ok("a reason that is only digits normalises away and degrades to the plain status", msg.includes("restore: 503"));
    restore();

    // An unreadable error body (json() throws) yields null, so it degrades to failResponse.
    restore = stub({ status: 500, text: "not json", textThrows: false });
    msg = await expectThrow(() => engine.restore({ runId: "r1" } as never));
    ok("an unreadable/non-JSON error body degrades to the plain status throw", msg.includes("restore: 500"));
    restore();

    // restore() on a 2xx parses the plan/result (the success arm of restore()).
    restore = stub({ status: 200, text: JSON.stringify({ ok: false, reason: "dry run" }) });
    const plan = (await engine.restore({ runId: "r1" } as never)) as { reason?: string };
    eq(plan.reason, "dry run", "restore on a 200 returns the parsed plan/result");
    restore();
  }

  // ========================================================================
  console.log("\n-- gatedFetch: step-up retry, cancel, non-step-up 401, unparseable 401, no-ceremony --");
  // ========================================================================
  {
    // A SENSITIVE action that returns 401 { stepUpRequired } runs the ceremony and retries ONCE with the header.
    const e1 = new EngineClient("https://engine.test");
    let ceremonyCalled = 0;
    e1.onStepUpRequired = async () => {
      ceremonyCalled += 1;
      return "stepup-token-xyz";
    };
    let sf = stepUpFetch(401, JSON.stringify({ stepUpRequired: true }));
    let res = await e1.setDestination(null);
    ok("the step-up 401 triggered the ceremony exactly once", ceremonyCalled === 1);
    ok("the step-up retry was a second request", sf.calls.length === 2);
    eq(sf.calls[0]?.stepup, null, "the first request carried no step-up header");
    eq(sf.calls[1]?.stepup, "stepup-token-xyz", "the retry carried the single-use step-up token");
    ok("the retried owner mutation resolved to status:result", res.status === "result");
    sf.restore();

    // A cancelled ceremony (token null) surfaces the ORIGINAL 401 to the caller, with no retry.
    const e2 = new EngineClient("https://engine.test");
    e2.onStepUpRequired = async () => null;
    sf = stepUpFetch(401, JSON.stringify({ stepUpRequired: true }));
    const msg = await expectThrow(() => e2.setDestination(null));
    ok("a cancelled ceremony does NOT retry (one request)", sf.calls.length === 1);
    // B29: a cancelled/refused step-up ceremony surfaces the stepUpRequired 401 tagged as a step-up
    // signal (STEPUP_REQUIRED_MARKER), so classifyError reads it "stepup-required" (verify + retry),
    // NOT "unauthorised" (which would bounce the operator to sign-in on a still-valid session).
    ok("a cancelled ceremony surfaces the stepUpRequired 401 tagged step-up, not a bare 401", msg.includes("set destination: stepup-required: 401"));
    ok("a cancelled ceremony classifies stepup-required, never unauthorised (B29)", classifyError(msg).kind === "stepup-required");
    sf.restore();

    // A 401 that is NOT a step-up prompt passes straight through (no ceremony), even with one wired.
    const e3 = new EngineClient("https://engine.test");
    let e3Called = 0;
    e3.onStepUpRequired = async () => { e3Called += 1; return "t"; };
    sf = stepUpFetch(401, JSON.stringify({ stepUpRequired: false }));
    await expectThrow(() => e3.setDestination(null));
    ok("a non-step-up 401 does not call the ceremony", e3Called === 0);
    ok("a non-step-up 401 makes one request", sf.calls.length === 1);
    sf.restore();

    // A 401 whose body cannot be parsed passes straight through (the gatedFetch catch returns the response).
    const e4 = new EngineClient("https://engine.test");
    let e4Called = 0;
    e4.onStepUpRequired = async () => { e4Called += 1; return "t"; };
    sf = stepUpFetch(401, "not json");
    await expectThrow(() => e4.setDestination(null));
    ok("an unparseable 401 body does not call the ceremony", e4Called === 0);
    sf.restore();

    // With NO ceremony wired, a step-up 401 is returned as-is (the early return in gatedFetch).
    const e5 = new EngineClient("https://engine.test");
    sf = stepUpFetch(401, JSON.stringify({ stepUpRequired: true }));
    const noCeremony = await expectThrow(() => e5.setDestination(null));
    ok("no ceremony wired: a step-up 401 is not retried", sf.calls.length === 1);
    // B29: even with no ceremony wired, a stepUpRequired 401 means the session is valid but the action
    // needs step-up (the engine only sends stepUpRequired to an authenticated caller). It surfaces
    // tagged step-up, never a bare 401 that would read as signed-out.
    ok("no ceremony wired: the stepUpRequired 401 surfaces tagged step-up, not a bare 401", noCeremony.includes("set destination: stepup-required: 401"));
    ok("no ceremony wired: it classifies stepup-required, not unauthorised (B29)", classifyError(noCeremony).kind === "stepup-required");
    sf.restore();

    // A non-401 on a gated route passes straight through gatedFetch to the normal parse path.
    const e6 = new EngineClient("https://engine.test");
    e6.onStepUpRequired = async () => "t";
    const restoreNon401 = stub({ status: 200, text: JSON.stringify({ present: true }) });
    res = await e6.setDestination(null);
    ok("a non-401 on a gated route resolves normally (status:result)", res.status === "result");
    restoreNon401();
  }

  // ========================================================================
  console.log("\n-- step-up ceremony endpoints + listDownpipes mapping --");
  // ========================================================================
  {
    let rec = record(JSON.stringify({ ok: true, publicKey: { challenge: "c" } }));
    await engine.stepUpBegin();
    eq(rec.calls[0]?.url, "https://engine.test/admin/stepup/begin", "stepUpBegin hits /admin/stepup/begin");
    eq(rec.calls[0]?.method, "POST", "stepUpBegin is a POST");
    rec.restore();

    rec = record(JSON.stringify({ ok: true, stepUpToken: "stk" }));
    const fin = (await engine.stepUpFinish("ch1", { id: "c", rawId: "r", type: "public-key", response: {} } as never)) as { ok: boolean };
    ok("stepUpFinish parses the verified body", fin.ok === true);
    eq((rec.calls[0]?.body as { challengeId: string }).challengeId, "ch1", "stepUpFinish sends the challengeId");
    rec.restore();

    // listDownpipes maps the engine wire shape (nested restoreProven / epoch-ms stamps) to the console shape.
    const wire = [{
      id: "d_1", name: "nightly", schedule: "0 2 * * *",
      restoreProven: { at: 1700000000000, by: "ada@example.com", method: "blind", runId: "run_1" },
      lastRestoreTestAt: 1700000000000, lastRestoreTestOk: true,
      integrityVerified: { at: 1700000000000, how: "seal" },
    }];
    const restore = stub({ status: 200, text: JSON.stringify(wire) });
    const list = await engine.listDownpipes();
    ok("listDownpipes returns a mapped array", Array.isArray(list) && list.length === 1);
    const d = list[0] as { lastRestoreProvenAt?: string; lastRestoreTestAt?: string; lastIntegrityVerifiedAt?: string };
    ok("the nested restoreProven.at is flattened to an ISO lastRestoreProvenAt", typeof d.lastRestoreProvenAt === "string" && d.lastRestoreProvenAt.includes("T"));
    ok("the epoch-ms lastRestoreTestAt is converted to an ISO string", typeof d.lastRestoreTestAt === "string" && d.lastRestoreTestAt.includes("T"));
    ok("the nested integrityVerified.at is flattened to an ISO string", typeof d.lastIntegrityVerifiedAt === "string");
    restore();
  }

  // ========================================================================
  console.log("\n-- error-folding methods: each non-2xx { error } reason is surfaced; success parses --");
  // ========================================================================
  {
    // Each of these methods folds an engine { error } into "<verb>: <reason>: <status>" on a non-2xx.
    const foldCases: Array<{ name: string; verb: string; run: () => Promise<unknown> }> = [
      { name: "setLicence", verb: "set licence", run: () => engine.setLicence("tok") },
      { name: "rollbackUpdate", verb: "roll back update", run: () => engine.rollbackUpdate("tok") },
      { name: "settleUpdate", verb: "settle update", run: () => engine.settleUpdate("tok") },
      { name: "changeBindings", verb: "change bindings", run: () => engine.changeBindings("tok", [], []) },
      { name: "installKeys", verb: "install keys", run: () => engine.installKeys({ token: "t", signerPrivate: "s", breakGlassPublic: "b" }) },
      { name: "rotateBreakGlass", verb: "rotate break-glass", run: () => engine.rotateBreakGlass("t", "b") },
      { name: "setBreakGlassOnly", verb: "break-glass-only", run: () => engine.setBreakGlassOnly("t") },
      { name: "retireBreakGlassToken", verb: "retire break-glass token", run: () => engine.retireBreakGlassToken() },
      { name: "deletePasskeyCredential", verb: "revoke passkey", run: () => engine.deletePasskeyCredential("c1") },
      { name: "setCoverageInventory", verb: "set coverage inventory", run: () => engine.setCoverageInventory({} as never) },
      { name: "reattachMissing", verb: "re-attach sources", run: () => engine.reattachMissing("tok") },
    ];
    for (const c of foldCases) {
      const restore = stub({ status: 400, text: JSON.stringify({ error: "no good" }) });
      const msg = await expectThrow(c.run);
      eq(msg, `${c.verb}: no good: 400`, `${c.name}: a non-2xx { error } is folded into the throw`);
      restore();
    }
    // And each one's no-error non-2xx degrades to the shared failResponse throw.
    for (const c of foldCases) {
      const restore = stub({ status: 502, text: JSON.stringify({ nope: 1 }) });
      const msg = await expectThrow(c.run);
      ok(`${c.name}: a non-2xx with no error degrades to verb + status`, msg.includes(`${c.verb}: 502`));
      restore();
    }
  }

  // ========================================================================
  console.log("\n-- applyUpdate / rampUpdate: 202 queued, error fold, success --");
  // ========================================================================
  {
    // applyUpdate: a migration/breaking LIVE apply under dual control returns the owner-action 202.
    let restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_apply", status: "pending" }) });
    let res = await engine.applyUpdate({ dryRun: false, token: "tok" });
    ok("applyUpdate: a 202 owner-action resolves to status:queued", res.status === "queued");
    ok("applyUpdate: the queued id is carried", res.status === "queued" && res.id === "oa_apply");
    restore();

    // applyUpdate dry-run success carries the structured result.
    restore = stub({ status: 200, text: JSON.stringify({ outcome: "planned" }) });
    res = await engine.applyUpdate({ dryRun: true });
    ok("applyUpdate: a 200 resolves to status:result", res.status === "result");
    restore();

    // applyUpdate non-2xx { error } folds the reason.
    restore = stub({ status: 400, text: JSON.stringify({ error: "incompatible" }) });
    let msg = await expectThrow(() => engine.applyUpdate({ dryRun: false, token: "tok" }));
    eq(msg, "apply update: incompatible: 400", "applyUpdate: a non-2xx { error } is folded");
    restore();

    // applyUpdate non-2xx no-error degrades.
    restore = stub({ status: 500, text: JSON.stringify({ x: 1 }) });
    msg = await expectThrow(() => engine.applyUpdate({ dryRun: false, token: "tok" }));
    ok("applyUpdate: a non-2xx no-error degrades to verb + status", msg.includes("apply update: 500"));
    restore();

    // applyUpdate body assembly: a dry run carries NO token; a live apply with allowDowngrade carries both flags.
    let rec = record(JSON.stringify({ outcome: "planned" }));
    await engine.applyUpdate({ dryRun: true });
    ok("applyUpdate dry-run body omits the token", (rec.calls[0]?.body as { token?: string }).token === undefined);
    rec.restore();
    rec = record(JSON.stringify({ outcome: "promoted" }));
    await engine.applyUpdate({ dryRun: false, token: "tok", allowDowngrade: true });
    ok("applyUpdate live body carries the token", (rec.calls[0]?.body as { token?: string }).token === "tok");
    ok("applyUpdate carries allowDowngrade only when true", (rec.calls[0]?.body as { allowDowngrade?: boolean }).allowDowngrade === true);
    rec.restore();

    // rampUpdate: 202 queued, success, error fold.
    restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_ramp", status: "pending" }) });
    let rampRes = await engine.rampUpdate({ token: "tok", percentage: 10 });
    ok("rampUpdate: a 202 owner-action resolves to status:queued", rampRes.status === "queued");
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ outcome: "ramp-pending" }) });
    rampRes = await engine.rampUpdate({ token: "tok", percentage: 10, allowDowngrade: true });
    ok("rampUpdate: a 200 resolves to status:result", rampRes.status === "result");
    restore();
    restore = stub({ status: 400, text: JSON.stringify({ error: "bad percentage" }) });
    msg = await expectThrow(() => engine.rampUpdate({ token: "tok", percentage: 999 }));
    eq(msg, "ramp update: bad percentage: 400", "rampUpdate: a non-2xx { error } is folded");
    restore();
    restore = stub({ status: 500, text: JSON.stringify({ x: 1 }) });
    msg = await expectThrow(() => engine.rampUpdate({ token: "tok", percentage: 10 }));
    ok("rampUpdate: a non-2xx no-error degrades to verb + status", msg.includes("ramp update: 500"));
    restore();

    // ----------------------------------------------------------------------
    // B8b (the malformed-202 governance-lie at LIVE apply/ramp stakes). applyUpdate and rampUpdate used to
    // decode the 202 INLINE (not via the shared parseJsonOrOwnerAction), so a 202 whose body was not the
    // OwnerActionQueued shape fell through to the structured 2xx parse and coerced a malformed-but-valid body
    // into a false { status:"result" } -- the console telling the owner an engine DEPLOY / traffic ramp had
    // landed while the engine had only QUEUED it (or moved nothing). They now route through the shared decoder,
    // whose B8 fix throws the honest answer-unreadable error for any untrusted 202 body. The sharpest variant
    // is a 202 carrying a body that LOOKS like a successful promote/ramp: the old inline path read it as an
    // applied deploy; it must now throw and never resolve.
    // ----------------------------------------------------------------------
    {
      // applyUpdate: a promote-SHAPED 202 (valid JSON, not the owner-action shape) must never resolve to a
      // false "deployed"; it throws answer-unreadable (status 202), the honest "the engine answered, only the
      // body could not be understood". Capture the real error so the classification the operator sees is asserted.
      let restoreB8b = stub({ status: 202, text: JSON.stringify({ outcome: "promoted", fromVersion: "0.1.2", toVersion: "0.2.0" }) });
      let applyResolved = false;
      let caught: unknown = null;
      try { await engine.applyUpdate({ dryRun: false, token: "tok" }); applyResolved = true; }
      catch (e) { caught = e; }
      restoreB8b();
      ok("B8b: applyUpdate promote-shaped 202 never resolves (no false deploy)", applyResolved === false);
      const applyOutcome = classifyError(caught);
      ok("B8b: applyUpdate promote-shaped 202 throws answer-unreadable, status 202", applyOutcome.kind === "answer-unreadable" && applyOutcome.status === 202);

      // applyUpdate: the bare `{}` probe shape (what the write-fault capability's fulfilMalformed202 used
      // against the sibling decoders) also throws verb + status, never a false result.
      restoreB8b = stub({ status: 202, text: JSON.stringify({}) });
      let msgB8b = await expectThrow(() => engine.applyUpdate({ dryRun: false, token: "tok" }));
      ok("B8b: applyUpdate bare-{} 202 throws verb + status, never a false result", msgB8b.includes("apply update: 202"));
      restoreB8b();

      // applyUpdate: an UNPARSEABLE 202 (truncated JSON) throws honestly too (the other half of malformed OR
      // unparseable, both of which the old inline decode would have mishandled or read as a false success).
      restoreB8b = stub({ status: 202, text: '{"ownerActionQueued":true,' });
      msgB8b = await expectThrow(() => engine.applyUpdate({ dryRun: false, token: "tok" }));
      ok("B8b: applyUpdate unparseable 202 also throws verb + status", msgB8b.includes("apply update: 202"));
      restoreB8b();

      // rampUpdate: the identical guard on the LIVE traffic-shift route -- a ramp-shaped 202 never resolves to
      // a false "ramping"; it throws answer-unreadable (status 202).
      restoreB8b = stub({ status: 202, text: JSON.stringify({ outcome: "ramp-pending", percentage: 10 }) });
      let rampResolved = false;
      caught = null;
      try { await engine.rampUpdate({ token: "tok", percentage: 10 }); rampResolved = true; }
      catch (e) { caught = e; }
      restoreB8b();
      ok("B8b: rampUpdate ramp-shaped 202 never resolves (no false ramp)", rampResolved === false);
      const rampOutcome = classifyError(caught);
      ok("B8b: rampUpdate ramp-shaped 202 throws answer-unreadable, status 202", rampOutcome.kind === "answer-unreadable" && rampOutcome.status === 202);

      // A well-formed owner-action 202 STILL resolves to queued (the fix must not have broken the real deferral
      // path): the guard is precise, not a blanket "throw on every 202".
      restoreB8b = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_b8b", status: "pending" }) });
      const stillQueued = await engine.applyUpdate({ dryRun: false, token: "tok" });
      ok("B8b: a WELL-FORMED owner-action 202 still resolves to queued (no over-throw)", stillQueued.status === "queued" && stillQueued.id === "oa_b8b");
      restoreB8b();
    }
  }

  // ========================================================================
  console.log("\n-- the four routes that still used plain parseJson (deleteRole / deleteGroupRole / terminateUserSessions / rotateBreakGlass) --");
    // Confirmed against a real deployment: the earlier fix routed most 202
    // sites through the shared decoders, but these FOUR still read a 202 with plain parseJson (whose only test
    // is `!r.ok`, and a 202 IS ok), so a malformed or queued 202 coerced to a FALSE success. The headline was
    // deleteRole: with requireConfigApproval ON the engine answers a real 202 { queued: true }, and the old read
    // toasted "Removed <member>" and dropped the row while the member's grant PERSISTED.

    // deleteRole + deleteGroupRole are change-control GATED (parseJsonOrPending): a well-formed queued 202
    // surfaces HONESTLY as { status:"pending" } (the caller shows "queued for approval", never "Removed"), a
    // malformed 202 THROWS answer-unreadable, and a 200 is an applied delete (the guard against over-throw).
    for (const c of [
      { name: "deleteRole", verb: "delete role", run: () => engine.deleteRole("a@x") },
      { name: "deleteGroupRole", verb: "delete group role", run: () => engine.deleteGroupRole("g") },
    ]) {
      type DelResult = { status: string; value?: { deleted: boolean }; changeId?: string };
      let restore = stub({ status: 200, text: JSON.stringify({ deleted: true }) });
      let del = (await c.run()) as DelResult;
      ok(`${c.name}: a 200 resolves to status:applied (no over-throw)`, del.status === "applied" && del.value?.deleted === true);
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg_b8c" }) });
      del = (await c.run()) as DelResult;
      ok(`${c.name}: a well-formed queued 202 surfaces as pending, never a false removal`, del.status === "pending" && del.changeId === "chg_b8c");
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ deleted: true }) });
      const msg = await expectThrow(c.run);
      ok(`${c.name}: a malformed 202 throws verb + status, never a false removal`, msg.includes(`${c.verb}: 202`));
      const kind = classifyError(msg);
      ok(`${c.name}: the malformed-202 throw classifies as answer-unreadable, status 202`, kind.kind === "answer-unreadable" && kind.status === 202);
      restore();
    }

    // terminateUserSessions + rotateBreakGlass are NOT gated engine-side (their handlers answer 200 { ok } or a
    // 4xx, never a 202), so a 202 is never a legitimate answer: BOTH a malformed AND a well-formed queued/owner-
    // action-shaped 202 throw answer-unreadable, because surfacing a "queued" for a route with no approval inbox
    // would itself be a lie. A 200 resolves to the { ok } value unchanged (the guard against over-throw).

    // terminateUserSessions (parseJsonOrPending; the queued shape is { queued:true,id }).
    {
      let restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
      const term = await engine.terminateUserSessions("a@x");
      ok("terminateUserSessions: a 200 resolves to { ok:true } (no over-throw)", term.ok === true);
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg_t" }) });
      let msg = await expectThrow(() => engine.terminateUserSessions("a@x"));
      ok("terminateUserSessions: a well-formed queued 202 throws (route files no change-request), never a false ok", msg.includes("terminate member sessions: 202"));
      ok("terminateUserSessions: that throw classifies as answer-unreadable, status 202", (() => { const k = classifyError(msg); return k.kind === "answer-unreadable" && k.status === 202; })());
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ ok: true }) });
      msg = await expectThrow(() => engine.terminateUserSessions("a@x"));
      ok("terminateUserSessions: a malformed 202 throws verb + status, never a false ok", msg.includes("terminate member sessions: 202"));
      restore();
    }

    // rotateBreakGlass (parseJsonOrOwnerAction; the queued shape is { ownerActionQueued:true,id }). The non-2xx
    // { error }-reason fold and the 200 parse are byte-identical to the hand-rolled reads it replaces (proven by
    // the error-folding block above, which still lists rotateBreakGlass), so only the 202 changes behaviour.
    {
      let restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
      const rot = await engine.rotateBreakGlass("t", "b");
      ok("rotateBreakGlass: a 200 resolves to { ok:true } (no over-throw)", rot.ok === true);
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_k", status: "pending" }) });
      let msg = await expectThrow(() => engine.rotateBreakGlass("t", "b"));
      ok("rotateBreakGlass: a well-formed owner-action 202 throws (route files no owner-action), never a false applied", msg.includes("rotate break-glass: 202"));
      ok("rotateBreakGlass: that throw classifies as answer-unreadable, status 202", (() => { const k = classifyError(msg); return k.kind === "answer-unreadable" && k.status === 202; })());
      restore();

      restore = stub({ status: 202, text: JSON.stringify({ ok: true }) });
      msg = await expectThrow(() => engine.rotateBreakGlass("t", "b"));
      ok("rotateBreakGlass: a malformed 202 throws verb + status, never a false applied or present", msg.includes("rotate break-glass: 202"));
      restore();
    }

  // ========================================================================
  console.log("\n-- changeBindings: a dual-control 202 is queued, NOT a false applied attach --");
  // ========================================================================
  {
    // sources-attach is a high-blast owner action: under dual control the engine returns the owner-action
    // 202 WITHOUT applying. It must resolve to status:queued, never a false applied value (the bug this
    // guards: a 202 was read through parseJson and the console toasted "attached, verified safe").
    let restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_attach", status: "pending" }) });
    let res = await engine.changeBindings("tok", [], []);
    ok("changeBindings: a 202 owner-action resolves to status:queued (not applied)", res.status === "queued");
    ok("changeBindings: the queued owner-action id is carried", res.status === "queued" && res.queued.id === "oa_attach");
    restore();

    // gate-off path (the default): a 200 resolves to the applied value with the attached ids.
    restore = stub({ status: 200, text: JSON.stringify({ attached: ["kv_1"], detached: [] }) });
    res = await engine.changeBindings("tok", [], []);
    ok("changeBindings: a 200 resolves to status:result with the attached ids", res.status === "result" && res.value.attached[0] === "kv_1");
    restore();

    // attachSources forwards the queued result too (never a false { attached }).
    restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_attach2", status: "pending" }) });
    const asRes = await engine.attachSources("tok", []);
    ok("attachSources: forwards the 202 as status:queued", asRes.status === "queued");
    restore();
  }

  // ========================================================================
  console.log("\n-- restore() apply 403 fold + acknowledgeSetup best-effort + resetDemoFresh statuses --");
  // ========================================================================
  {
    // acknowledgeSetup is best-effort: a non-2xx resolves to { ok:false } (it never throws).
    let restore = stub({ status: 500, text: "boom" });
    let ack = await engine.acknowledgeSetup();
    ok("acknowledgeSetup returns ok:false on a non-2xx (never throws)", ack.ok === false);
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
    ack = await engine.acknowledgeSetup();
    ok("acknowledgeSetup returns ok:true on a 200 { ok:true }", ack.ok === true);
    restore();
    // acknowledgeSetup catch arm: fetch throws -> { ok:false }.
    {
      const g = globalThis as unknown as Record<string, unknown>;
      const prev = g.fetch;
      g.fetch = async () => { throw new Error("network down"); };
      ack = await engine.acknowledgeSetup();
      ok("acknowledgeSetup swallows a thrown fetch and returns ok:false", ack.ok === false);
      g.fetch = prev;
    }

    // resetDemoFresh: 200 success, 404 (not demo), 401 (bad token), other status.
    restore = stub({ status: 200, text: JSON.stringify({ ok: true, reset: true, cleared: 3 }) });
    const reset = await engine.resetDemoFresh("admin-tok");
    ok("resetDemoFresh returns the parsed body on a 200", reset.ok === true && reset.reset === true);
    restore();
    restore = stub({ status: 404, text: "" });
    let msg = await expectThrow(() => engine.resetDemoFresh("admin-tok"));
    ok("resetDemoFresh throws a demo-mode message on a 404", msg.includes("not in demo mode"));
    restore();
    restore = stub({ status: 401, text: "" });
    msg = await expectThrow(() => engine.resetDemoFresh("admin-tok"));
    ok("resetDemoFresh throws a token message on a 401", msg.includes("ADMIN_TOKEN was not accepted"));
    restore();
    restore = stub({ status: 500, text: "internal" });
    msg = await expectThrow(() => engine.resetDemoFresh("admin-tok"));
    ok("resetDemoFresh throws a status-bearing message on another non-2xx", msg.includes("reset failed (500)"));
    restore();
  }

  // ========================================================================
  console.log("\n-- raw-text + binary readers: success and non-2xx access-redirect honesty --");
  // ========================================================================
  {
    // getSupportBundle / samlMetadata / exportAudit return raw text on a 2xx.
    let restore = stub({ status: 200, text: "bundle-bytes" });
    eq(await engine.getSupportBundle(), "bundle-bytes", "getSupportBundle returns the raw text on a 200");
    restore();
    restore = stub({ status: 403, text: HTML });
    let msg = await expectThrow(() => engine.getSupportBundle());
    ok("getSupportBundle names an access-redirect non-2xx honestly", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();

    restore = stub({ status: 200, text: "<xml/>" });
    eq(await engine.samlMetadata("c1"), "<xml/>", "samlMetadata returns the raw XML on a 200");
    restore();
    restore = stub({ status: 404, text: "nope" });
    msg = await expectThrow(() => engine.samlMetadata("c1"));
    ok("samlMetadata throws verb + status on a non-2xx", msg.includes("saml metadata: 404"));
    restore();

    restore = stub({ status: 200, text: "id,actor\n1,ada" });
    eq(await engine.exportAudit("csv"), "id,actor\n1,ada", "exportAudit returns the raw CSV on a 200");
    restore();
    restore = stub({ status: 500, text: HTML });
    msg = await expectThrow(() => engine.exportAudit());
    ok("exportAudit names an access-redirect non-2xx honestly", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();

    // getReportPDF / getEvidencePackPDF return bytes on a 2xx and fail honestly on a non-2xx.
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    restore = stub({ status: 200, text: "", arrayBuffer: bytes });
    const pdf = await engine.getReportPDF("posture" as never);
    ok("getReportPDF returns the bytes on a 200", pdf instanceof Uint8Array && pdf.length === 4);
    restore();
    restore = stub({ status: 403, text: HTML });
    msg = await expectThrow(() => engine.getReportPDF("posture" as never));
    ok("getReportPDF names an access-redirect non-2xx honestly", msg.includes(ACCESS_REDIRECT_MARKER));
    restore();
    restore = stub({ status: 200, text: "", arrayBuffer: bytes });
    const pack = await engine.getEvidencePackPDF("cps230");
    ok("getEvidencePackPDF returns the bytes on a 200", pack instanceof Uint8Array && pack.length === 4);
    restore();
    restore = stub({ status: 500, text: "x" });
    msg = await expectThrow(() => engine.getEvidencePackPDF("cps230"));
    ok("getEvidencePackPDF fails through failResponse on a non-2xx", msg.includes("evidence pack pdf: 500"));
    restore();
  }

  // ========================================================================
  console.log("\n-- listHistory envelope unwrap + listAllHistory --");
  // ========================================================================
  {
    let restore = stub({ status: 200, text: JSON.stringify({ entries: [{ runId: "r1" }, { runId: "r2" }] }) });
    let hist = await engine.listHistory("d_1");
    ok("listHistory unwraps the { entries } envelope to an array", Array.isArray(hist) && hist.length === 2);
    restore();
    // An envelope with no entries yields [] (the ?? [] fallback).
    restore = stub({ status: 200, text: JSON.stringify({}) });
    hist = await engine.listHistory("d_1");
    ok("listHistory returns [] when the envelope has no entries", Array.isArray(hist) && hist.length === 0);
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ byDownpipe: { d_1: [{ runId: "r1" }] } }) });
    const all = await engine.listAllHistory();
    ok("listAllHistory returns the byDownpipe map", all.byDownpipe.d_1?.length === 1);
    restore();
  }

  // ========================================================================
  console.log("\n-- listAudit query assembly: filters become query params; empty filters send a bare path --");
  // ========================================================================
  {
    let rec = record(JSON.stringify({ events: [], head: "h" }));
    await engine.listAudit({ actor: "ada", action: "downpipe-create", downpipe: "d_1", outcome: "success", from: "2026-01-01", to: "2026-02-01", before: 1700000000000, limit: 50 });
    const url = rec.calls[0]?.url ?? "";
    ok("listAudit encodes actor", url.includes("actor=ada"));
    ok("listAudit encodes before (a number)", url.includes("before=1700000000000"));
    ok("listAudit encodes limit", url.includes("limit=50"));
    rec.restore();
    rec = record(JSON.stringify({ events: [], head: "h" }));
    await engine.listAudit();
    eq(rec.calls[0]?.url, "https://engine.test/admin/audit", "listAudit with no filters sends a bare path (no query)");
    rec.restore();
  }

  // ========================================================================
  console.log("\n-- optional-field omission arms: each method drops the optional field when absent --");
  // ========================================================================
  {
    // The other half of each exactOptionalPropertyTypes ternary: when the optional field is absent it is
    // omitted from the body entirely (the engine's present-or-absent contract).
    let rec = record(JSON.stringify({ ok: true, email: "a@x" }));
    await engine.passkeyRegisterFinish("a@x", {} as never);
    const rf = rec.calls[0]?.body as { displayName?: string; inviteToken?: string };
    ok("passkeyRegisterFinish omits displayName and inviteToken when absent", rf.displayName === undefined && rf.inviteToken === undefined);
    rec.restore();

    rec = record(JSON.stringify({ ok: true }));
    await engine.addDestination({ endpoint: "https://s3", bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" } as never, "label");
    ok("addDestination omits id when adding (no id supplied)", (rec.calls[0]?.body as { id?: string }).id === undefined);
    rec.restore();

    rec = record(JSON.stringify({ id: "x" }));
    await engine.setRole("a@x", "viewer");
    ok("setRole omits expiresAt for a non-time-boxed grant", (rec.calls[0]?.body as { expiresAt?: string }).expiresAt === undefined);
    rec.restore();

    rec = record(JSON.stringify({ id: "x" }));
    await engine.assignCustomRole("a@x", "r");
    ok("assignCustomRole omits expiresAt for a non-time-boxed grant", (rec.calls[0]?.body as { expiresAt?: string }).expiresAt === undefined);
    rec.restore();

    rec = record(JSON.stringify({ runId: "r1" }));
    await engine.recordDrillEvidence("r1", "offline-rehearsal" as never);
    ok("recordDrillEvidence omits note when absent", (rec.calls[0]?.body as { note?: string }).note === undefined);
    rec.restore();

    // resetDemoFresh's "other status" arm with an EMPTY body: the message omits the ": <txt>" suffix.
    const restore = stub({ status: 503, text: "" });
    const msg = await expectThrow(() => engine.resetDemoFresh("admin-tok"));
    ok("resetDemoFresh on another non-2xx with an empty body omits the body suffix", msg === "reset failed (503)");
    restore();
  }

  // ========================================================================
  console.log("\n-- pure path / URL builders: returnTo guard, encoding, kind dispatch --");
    eq(EngineClient.oidcStartPath("c 1"), "/admin/oidc/start/c%201", "oidcStartPath encodes the connId and omits returnTo when absent");
    eq(EngineClient.oidcStartPath("c1", "/dash"), "/admin/oidc/start/c1?returnTo=%2Fdash", "oidcStartPath threads a relative returnTo");
    eq(EngineClient.oidcStartPath("c1", "//evil.example"), "/admin/oidc/start/c1", "oidcStartPath drops a protocol-relative returnTo");
    eq(EngineClient.oidcStartPath("c1", "https://evil"), "/admin/oidc/start/c1", "oidcStartPath drops a non-relative returnTo");
    eq(EngineClient.samlStartPath("c1", "/back"), "/admin/saml/start/c1?returnTo=%2Fback", "samlStartPath threads a relative returnTo");
    eq(EngineClient.samlStartPath("c1", "//evil"), "/admin/saml/start/c1", "samlStartPath drops a protocol-relative returnTo");

    eq(engine.idpStartUrlFor({ id: "c1", kind: "saml" }, "/x"), "https://engine.test/admin/saml/start/c1?returnTo=%2Fx", "idpStartUrlFor dispatches saml to samlStartPath");
    eq(engine.idpStartUrlFor({ id: "c1", kind: "oidc" }), "https://engine.test/admin/oidc/start/c1", "idpStartUrlFor dispatches oidc to oidcStartPath");
    eq(engine.idpStartUrlFor({ id: "c1", kind: "oauth2" }), "https://engine.test/admin/oidc/start/c1", "idpStartUrlFor dispatches oauth2 to oidcStartPath");
    eq(engine.samlMetadataUrl("c 1"), "https://engine.test/admin/saml/metadata/c%201", "samlMetadataUrl builds the absolute encoded url");
    eq(engine.idpRedirectUri("c1"), "https://engine.test/admin/oidc/callback/c1", "idpRedirectUri builds the absolute callback");
    eq(engine.samlAcsUrl("c1"), "https://engine.test/admin/saml/acs/c1", "samlAcsUrl builds the absolute ACS url");

  // ========================================================================
  console.log("\n-- createIdpConnection body discrimination (SAML wrapped as { proposal }) --");
  // ========================================================================
  {
    let rec = record(JSON.stringify({ ok: true, conn: { id: "c1" } }));
    await engine.createIdpConnection({ presetId: "okta", vars: {}, id: "okta", clientId: "cid", secret: "s", secretMode: "do-plaintext" } as never);
    ok("createIdpConnection sends a preset body flat (no proposal wrapper)", (rec.calls[0]?.body as { proposal?: unknown; presetId?: string }).presetId === "okta");
    rec.restore();
    rec = record(JSON.stringify({ ok: true, conn: { id: "c2" } }));
    await engine.createIdpConnection({ kind: "saml", id: "saml1" } as never);
    ok("createIdpConnection wraps a SAML proposal as { proposal }", (rec.calls[0]?.body as { proposal?: { kind?: string } }).proposal?.kind === "saml");
    rec.restore();
  }

  // ========================================================================
  console.log("\n-- every remaining read/write method: route + verb + parsed result --");
  // ========================================================================
  {
    // Drive each thin wrapper once so its body (route, verb, parse call) executes and the result is checked.
    // Each entry asserts the recorded route + verb and that the parsed result is returned.
    type Case = { name: string; body: string; method?: string; url: string; run: () => Promise<unknown>; check: (r: unknown) => boolean };
    const arr = JSON.stringify([]);
    const obj = JSON.stringify({ ok: true });
    const cases: Case[] = [
      { name: "trigger", body: JSON.stringify({ runId: "r1", index: 0 }), method: "POST", url: "/admin/trigger", run: () => engine.trigger("d_1"), check: (r) => (r as { runId: string }).runId === "r1" },
      // deleteDownpipe is a change-gate-deferrable mutation (parseJsonOrPending): a 200 resolves to
      // { status:"applied", value } and a 202 to { status:"pending", changeId } (the queued path is
      // characterised with the other pending mutations below where applicable).
      { name: "deleteDownpipe", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/downpipes/delete", run: () => engine.deleteDownpipe("d_1"), check: (r) => { const m = r as { status: string; value: { deleted: boolean; swept?: number } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "rosterHygiene", body: JSON.stringify({ scanned: 2, ghosts: [{ key: "dp:x", embeddedId: "y", kind: "key-id-mismatch" }], ghostCount: 1, neverRan: [], neverRanCount: 0 }), url: "/admin/downpipes/roster-hygiene", run: () => engine.rosterHygiene(), check: (r) => (r as { ghostCount: number }).ghostCount === 1 },
      { name: "reconcileRoster", body: JSON.stringify({ removed: 1, rehomed: 0, ghostsRemaining: 0 }), method: "POST", url: "/admin/downpipes/reconcile-roster", run: () => engine.reconcileRoster(), check: (r) => (r as { removed: number }).removed === 1 },
      { name: "drill", body: JSON.stringify({ ok: true }), method: "POST", url: "/admin/drill", run: () => engine.drill("r1"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "licence", body: JSON.stringify({ tier: "community" }), url: "/admin/licence", run: () => engine.licence(), check: (r) => (r as { tier: string }).tier === "community" },
      { name: "updateStatus", body: obj, url: "/admin/update/status", run: () => engine.updateStatus(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "runsAt", body: JSON.stringify({ found: true, runId: "r1" }), url: "/admin/runs/at", run: () => engine.runsAt("d_1", "2026-01-01T00:00:00Z"), check: (r) => (r as { found: boolean }).found === true },
      { name: "whoami", body: JSON.stringify({ method: "access", role: "owner" }), url: "/admin/whoami", run: () => engine.whoami(), check: (r) => (r as { role: string }).role === "owner" },
      { name: "passkeyRegisterBegin", body: obj, method: "POST", url: "/admin/auth/register/begin", run: () => engine.passkeyRegisterBegin("a@x", "Ada", "inv1"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "passkeyLoginBegin", body: obj, method: "POST", url: "/admin/auth/login/begin", run: () => engine.passkeyLoginBegin("a@x"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "passkeyLoginFinish", body: JSON.stringify({ ok: true, email: "a@x" }), method: "POST", url: "/admin/auth/login/finish", run: () => engine.passkeyLoginFinish("ch", {} as never), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "passkeyLogout", body: obj, method: "POST", url: "/admin/auth/logout", run: () => engine.passkeyLogout(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "bootstrapSendLink", body: obj, method: "POST", url: "/admin/auth/bootstrap/send", run: () => engine.bootstrapSendLink(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "terminateOtherSessions", body: obj, method: "POST", url: "/admin/sessions/terminate-others", run: () => engine.terminateOtherSessions(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "terminateUserSessions", body: obj, method: "POST", url: "/admin/sessions/terminate-user", run: () => engine.terminateUserSessions("a@x"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "terminateAllSessions", body: obj, method: "POST", url: "/admin/sessions/terminate-all", run: () => engine.terminateAllSessions(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "listPasskeyCredentials", body: JSON.stringify({ credentials: [] }), url: "/admin/passkey/credentials", run: () => engine.listPasskeyCredentials("a@x"), check: (r) => Array.isArray((r as { credentials: unknown[] }).credentials) },
      { name: "recoverWithCode", body: JSON.stringify({ role: "owner", enrolPasskey: true }), method: "POST", url: "/admin/auth/recovery", run: () => engine.recoverWithCode("a@x", "code"), check: (r) => (r as { enrolPasskey: boolean }).enrolPasskey === true },
      { name: "discoverSources", body: JSON.stringify({ bound: [], account: [] }), url: "/admin/sources/discover", run: () => engine.discoverSources(), check: (r) => Array.isArray((r as { bound: unknown[] }).bound) },
      { name: "getDiscoveryStatus", body: JSON.stringify({ present: false }), url: "/admin/sources/discovery-status", run: () => engine.getDiscoveryStatus(), check: (r) => (r as { present: boolean }).present === false },
      { name: "setDiscoveryAccounts", body: JSON.stringify({ present: true }), method: "POST", url: "/admin/sources/discovery-accounts", run: () => engine.setDiscoveryAccounts(["a"], "a"), check: (r) => (r as { status: string; value: { present: boolean } }).status === "result" && (r as { value: { present: boolean } }).value.present === true },
      { name: "rediscoverCfConfig", body: obj, method: "POST", url: "/admin/downpipes/cf-config/rediscover", run: () => engine.rediscoverCfConfig("d_1"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "setCfConfigMode", body: obj, method: "POST", url: "/admin/downpipes/cf-config/mode", run: () => engine.setCfConfigMode("d_1", "auto"), check: (r) => (r as { status: string; value: { ok: boolean } }).status === "applied" && (r as { value: { ok: boolean } }).value.ok === true },
      { name: "getDestination", body: JSON.stringify({ present: true }), url: "/admin/destination", run: () => engine.getDestination(), check: (r) => (r as { present: boolean }).present === true },
      { name: "verifyDestination", body: obj, method: "POST", url: "/admin/destination/verify", run: () => engine.verifyDestination("d1"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "verifyDestination-default", body: obj, method: "POST", url: "/admin/destination/verify", run: () => engine.verifyDestination(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "listDestinations", body: JSON.stringify({ destinations: [], defaultId: null }), url: "/admin/destinations", run: () => engine.listDestinations(), check: (r) => Array.isArray((r as { destinations: unknown[] }).destinations) },
      { name: "estateSize", body: JSON.stringify({ available: false }), url: "/admin/cost/estate-size", run: () => engine.estateSize(), check: (r) => (r as { available: boolean }).available === false },
      { name: "attachSources", body: JSON.stringify({ attached: ["x"], detached: [] }), method: "POST", url: "/admin/sources/attach", run: () => engine.attachSources("tok", []), check: (r) => (r as { status: string; value: { attached: string[] } }).status === "result" && (r as { value: { attached: string[] } }).value.attached[0] === "x" },
      { name: "getSetupState", body: JSON.stringify({ keysPresent: false }), url: "/admin/setup-state", run: () => engine.getSetupState(), check: (r) => (r as { keysPresent: boolean }).keysPresent === false },
      { name: "testEmailDelivery", body: obj, method: "POST", url: "/admin/email/test", run: () => engine.testEmailDelivery(), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "listReplication", body: JSON.stringify({ byDownpipe: {} }), url: "/admin/replication", run: () => engine.listReplication(), check: (r) => typeof (r as { byDownpipe: unknown }).byDownpipe === "object" },
      { name: "updates", body: JSON.stringify({ current: "v1" }), url: "/admin/updates", run: () => engine.updates(), check: (r) => (r as { current: string }).current === "v1" },
      { name: "status", body: JSON.stringify({ keysPresent: true }), url: "/admin/status", run: () => engine.status(), check: (r) => (r as { keysPresent: boolean }).keysPresent === true },
      { name: "preflight", body: JSON.stringify({ items: [] }), url: "/admin/preflight", run: () => engine.preflight(), check: (r) => Array.isArray((r as { items: unknown[] }).items) },
      { name: "getSupport", body: JSON.stringify({ vendorSealing: false }), url: "/admin/support", run: () => engine.getSupport(), check: (r) => (r as { vendorSealing: boolean }).vendorSealing === false },
      // mintSupportCredential is an OWNER-ACTION the dual-control gate defers (parseJsonOrOwnerAction, B54): a
      // 200 resolves to { status:"result", value } and a 202 to { status:"queued" } (mints NO secret). It read
      // the 202 as a revealable credential until B54, because parseJson only tests `!r.ok` and a 202 is ok.
      { name: "mintSupportCredential", body: JSON.stringify({ clientId: "ci", secret: "se" }), method: "POST", url: "/admin/support/credentials", run: () => engine.mintSupportCredential("diagnostics" as never, 60), check: (r) => { const m = r as { status: string; value: { clientId: string } }; return m.status === "result" && m.value.clientId === "ci"; } },
      { name: "revokeSupportCredential", body: JSON.stringify({ ok: true, scope: "diagnostics" }), method: "POST", url: "/admin/support/credentials/delete", run: () => engine.revokeSupportCredential("diagnostics" as never), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "listRoles", body: arr, url: "/admin/roles", run: () => engine.listRoles(), check: (r) => Array.isArray(r) },
      // deleteRole is change-control GATED (parseJsonOrPending, B8c), so a 200 resolves to { status:"applied", value }
      // and a 202 to { status:"pending" } (the queued path + the malformed-202 throw are characterised in the B8c block).
      { name: "deleteRole", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/roles/delete", run: () => engine.deleteRole("a@x"), check: (r) => { const m = r as { status: string; value: { deleted: boolean } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "listGroupRoles", body: arr, url: "/admin/group-roles", run: () => engine.listGroupRoles(), check: (r) => Array.isArray(r) },
      // deleteGroupRole is change-control GATED (parseJsonOrPending, B8c): same applied/pending shape as deleteRole.
      { name: "deleteGroupRole", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/group-roles/delete", run: () => engine.deleteGroupRole("g"), check: (r) => { const m = r as { status: string; value: { deleted: boolean } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "listCustomRoles", body: arr, url: "/admin/custom-roles", run: () => engine.listCustomRoles(), check: (r) => Array.isArray(r) },
      // deleteCustomRole is change-control GATED, so it resolves to a MutationResult (applied vs pending), not a
      // bare body: a 202 means the delete was QUEUED and nothing was written. It read the 202 as a success until
      // the earlier read, because parseJson only tests `!r.ok` and a 202 is ok. A 200 is still an applied delete.
      { name: "deleteCustomRole", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/custom-roles/delete", run: () => engine.deleteCustomRole("name"), check: (r) => (r as { status: string; value: { deleted: boolean } }).status === "applied" && (r as { value: { deleted: boolean } }).value.deleted === true },
      { name: "idpProviders", body: JSON.stringify({ ok: true, providers: [] }), url: "/admin/oidc/providers", run: () => engine.idpProviders(), check: (r) => Array.isArray((r as { providers: unknown[] }).providers) },
      { name: "idpPresets", body: JSON.stringify({ ok: true, presets: [] }), url: "/admin/idp/presets", run: () => engine.idpPresets(), check: (r) => Array.isArray((r as { presets: unknown[] }).presets) },
      { name: "idpConnections", body: JSON.stringify({ ok: true, connections: [] }), url: "/admin/idp/connections", run: () => engine.idpConnections(), check: (r) => Array.isArray((r as { connections: unknown[] }).connections) },
      { name: "testIdpConnection", body: JSON.stringify({ ok: true, checks: [] }), method: "POST", url: "/admin/idp/test", run: () => engine.testIdpConnection({ presetId: "okta", vars: {}, id: "o", clientId: "c", secret: "s", secretMode: "do-plaintext" } as never), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "requestRestore", body: JSON.stringify({ planHash: "ph" }), method: "POST", url: "/admin/restore/request", run: () => engine.requestRestore({ runId: "r1", reason: "dr" }), check: (r) => (r as { planHash: string }).planHash === "ph" },
      { name: "approveRestore", body: JSON.stringify({ planHash: "ph" }), method: "POST", url: "/admin/restore/approve", run: () => engine.approveRestore("ph"), check: (r) => (r as { planHash: string }).planHash === "ph" },
      // rejectReason is a REQUIRED closed verdict, because a rejected restore used to be a
      // dead end for the requester and for support alike. Omitting it here passed only because
      // JSON.stringify drops an undefined, so the expected body matched a call that was not making it.
      { name: "rejectRestore", body: JSON.stringify({ planHash: "ph", rejectReason: "policy" }), method: "POST", url: "/admin/restore/reject", run: () => engine.rejectRestore("ph", "policy"), check: (r) => (r as { planHash: string }).planHash === "ph" },
      { name: "listApprovals", body: arr, url: "/admin/restore/approvals", run: () => engine.listApprovals(), check: (r) => Array.isArray(r) },
      { name: "verifyRestore", body: JSON.stringify({ ok: true, verified: 3 }), method: "POST", url: "/admin/restore/verify", run: () => engine.verifyRestore({ runId: "r1" }), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "attestRestore", body: JSON.stringify({ ok: true }), method: "POST", url: "/admin/restore/attest", run: () => engine.attestRestore("r1"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "verifyAuditChain", body: JSON.stringify({ intact: true }), url: "/admin/audit/verify", run: () => engine.verifyAuditChain(), check: (r) => (r as { intact: boolean }).intact === true },
      { name: "recordAuditIntent", body: JSON.stringify({ action: "key-ceremony-intent" }), method: "POST", url: "/admin/audit/intent", run: () => engine.recordAuditIntent("key-ceremony-intent"), check: (r) => (r as { action: string }).action === "key-ceremony-intent" },
      { name: "recordDrillEvidence", body: JSON.stringify({ runId: "r1" }), method: "POST", url: "/admin/drill-evidence", run: () => engine.recordDrillEvidence("r1", "offline-rehearsal" as never, "note"), check: (r) => (r as { runId: string }).runId === "r1" },
      { name: "listDrillEvidence", body: arr, url: "/admin/drill-evidence", run: () => engine.listDrillEvidence(), check: (r) => Array.isArray(r) },
      { name: "getCanary", body: JSON.stringify({ live: true }), url: "/admin/canary", run: () => engine.getCanary(), check: (r) => (r as { live: boolean }).live === true },
      { name: "runCanary", body: JSON.stringify({ ok: true, flying: true }), method: "POST", url: "/admin/canary/run", run: () => engine.runCanary(), check: (r) => (r as { flying: boolean }).flying === true },
      { name: "listNotifyChannels", body: arr, url: "/admin/notify/channels", run: () => engine.listNotifyChannels(), check: (r) => Array.isArray(r) },
      // deleteNotifyChannel is change-control GATED (parseJsonOrPending, B53): a 200 resolves to
      // { status:"applied", value } and a 202 to { status:"pending" } (queued, nothing deleted).
      { name: "deleteNotifyChannel", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/notify/channels/delete", run: () => engine.deleteNotifyChannel("id"), check: (r) => { const m = r as { status: string; value: { deleted: boolean } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "listNotifyRules", body: arr, url: "/admin/notify/rules", run: () => engine.listNotifyRules(), check: (r) => Array.isArray(r) },
      // deleteNotifyRule is change-control GATED (parseJsonOrPending, B53): same applied/pending shape.
      { name: "deleteNotifyRule", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/notify/rules/delete", run: () => engine.deleteNotifyRule("id"), check: (r) => { const m = r as { status: string; value: { deleted: boolean } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "listNotifyHistory", body: arr, url: "/admin/notify/history", run: () => engine.listNotifyHistory(), check: (r) => Array.isArray(r) },
      { name: "testNotifyChannel", body: obj, method: "POST", url: "/admin/notify/test", run: () => engine.testNotifyChannel("id"), check: (r) => (r as { ok: boolean }).ok === true },
      { name: "listExpiry", body: arr, url: "/admin/expiry", run: () => engine.listExpiry(), check: (r) => Array.isArray(r) },
      // deleteExpiryItem is change-control GATED (parseJsonOrPending, B53): same applied/pending shape.
      { name: "deleteExpiryItem", body: JSON.stringify({ deleted: true }), method: "POST", url: "/admin/expiry/delete", run: () => engine.deleteExpiryItem("id"), check: (r) => { const m = r as { status: string; value: { deleted: boolean } }; return m.status === "applied" && m.value.deleted === true; } },
      { name: "cleanupAttestExpiry", body: JSON.stringify({ ok: true, updated: true }), method: "POST", url: "/admin/expiry/cleanup-attest", run: () => engine.cleanupAttestExpiry("id"), check: (r) => (r as { updated: boolean }).updated === true },
      { name: "getReport", body: JSON.stringify({ kind: "posture" }), url: "/admin/reports/posture", run: () => engine.getReport("posture" as never), check: (r) => (r as { kind: string }).kind === "posture" },
      { name: "getEvidencePack", body: JSON.stringify({ kind: "evidence-pack" }), url: "/admin/reports/evidence-pack", run: () => engine.getEvidencePack("cps230"), check: (r) => (r as { kind: string }).kind === "evidence-pack" },
      { name: "rto", body: JSON.stringify({ fleet: {} }), url: "/admin/rto", run: () => engine.rto("d_1"), check: (r) => typeof (r as { fleet: unknown }).fleet === "object" },
      { name: "rto-fleet", body: JSON.stringify({ fleet: {} }), url: "/admin/rto", run: () => engine.rto(), check: (r) => typeof (r as { fleet: unknown }).fleet === "object" },
      { name: "getPosture", body: JSON.stringify({ score: 90 }), url: "/admin/posture", run: () => engine.getPosture(), check: (r) => (r as { score: number }).score === 90 },
      { name: "getCoverage", body: JSON.stringify({ hasInventory: false }), url: "/admin/coverage", run: () => engine.getCoverage(), check: (r) => (r as { hasInventory: boolean }).hasInventory === false },
      { name: "getConfigApprovalPolicy", body: JSON.stringify({ requireConfigApproval: false }), url: "/admin/config/approval-policy", run: () => engine.getConfigApprovalPolicy(), check: (r) => (r as { requireConfigApproval: boolean }).requireConfigApproval === false },
      { name: "setConfigApprovalPolicy", body: JSON.stringify({ requireConfigApproval: true }), method: "POST", url: "/admin/config/approval-policy", run: () => engine.setConfigApprovalPolicy(true), check: (r) => (r as { status: string; value: { requireConfigApproval: boolean } }).status === "result" && (r as { value: { requireConfigApproval: boolean } }).value.requireConfigApproval === true },
      { name: "listConfigChanges", body: arr, url: "/admin/config/changes", run: () => engine.listConfigChanges(), check: (r) => Array.isArray(r) },
      { name: "approveConfigChange", body: JSON.stringify({ id: "c1", status: "applied" }), method: "POST", url: "/admin/config/changes/c1/approve", run: () => engine.approveConfigChange("c1"), check: (r) => (r as { status: string }).status === "applied" },
      { name: "rejectConfigChange", body: JSON.stringify({ id: "c1", status: "rejected" }), method: "POST", url: "/admin/config/changes/c1/reject", run: () => engine.rejectConfigChange("c1"), check: (r) => (r as { status: string }).status === "rejected" },
      { name: "getConfigHistory", body: JSON.stringify({ versions: [] }), url: "/admin/config/history", run: () => engine.getConfigHistory(), check: (r) => Array.isArray((r as { versions: unknown[] }).versions) },
      { name: "getConfigVersion", body: JSON.stringify({ found: false }), url: "/admin/config/version", run: () => engine.getConfigVersion(3), check: (r) => (r as { found: boolean }).found === false },
      { name: "getConfigDiff", body: JSON.stringify({ found: true, lines: [] }), url: "/admin/config/diff", run: () => engine.getConfigDiff(1, 2), check: (r) => (r as { found: boolean }).found === true },
      { name: "snapshotConfig", body: JSON.stringify({ created: false }), method: "POST", url: "/admin/config/snapshot", run: () => engine.snapshotConfig(), check: (r) => (r as { created: boolean }).created === false },
      { name: "listOwnerActions", body: arr, url: "/admin/owner-actions", run: () => engine.listOwnerActions(), check: (r) => Array.isArray(r) },
      { name: "approveOwnerAction", body: JSON.stringify({ id: "oa1", status: "armed" }), method: "POST", url: "/admin/owner-actions/oa1/approve", run: () => engine.approveOwnerAction("oa1"), check: (r) => (r as { status: string }).status === "armed" },
      { name: "rejectOwnerAction", body: JSON.stringify({ id: "oa1", status: "rejected" }), method: "POST", url: "/admin/owner-actions/oa1/reject", run: () => engine.rejectOwnerAction("oa1"), check: (r) => (r as { status: string }).status === "rejected" },
    ];
    for (const c of cases) {
      const rec = record(c.body);
      const r = await c.run();
      const call = rec.calls[0];
      rec.restore();
      ok(`${c.name}: hits ${c.url}`, (call?.url ?? "").includes(c.url));
      eq(call?.method, c.method ?? "GET", `${c.name}: method is ${c.method ?? "GET"}`);
      ok(`${c.name}: returns the parsed result`, c.check(r));
    }
  }

  // ========================================================================
  console.log("\n-- config-mutation (parseJsonOrPending) methods: applied + pending --");
  // ========================================================================
  {
    // These all route through parseJsonOrPending; assert both the applied (200) and pending (202) arms.
    type MCase = { name: string; url: string; run: () => Promise<{ status: string }> };
    const mcases: MCase[] = [
      { name: "setRole", url: "/admin/roles", run: () => engine.setRole("a@x", "viewer", "2026-12-31") },
      { name: "setGroupRole", url: "/admin/group-roles", run: () => engine.setGroupRole("g", "viewer" as never) },
      { name: "createCustomRole", url: "/admin/custom-roles", run: () => engine.createCustomRole({ name: "r", label: "R", capabilities: [] } as never) },
      { name: "assignCustomRole", url: "/admin/roles", run: () => engine.assignCustomRole("a@x", "r", "2026-12-31") },
      { name: "assignGroupCustomRole", url: "/admin/group-roles", run: () => engine.assignGroupCustomRole("g", "r") },
      { name: "setCanaryConfig", url: "/admin/canary/config", run: () => engine.setCanaryConfig({ enabled: true } as never) },
      { name: "upsertNotifyChannel", url: "/admin/notify/channels", run: () => engine.upsertNotifyChannel({ kind: "webhook", url: "https://h" } as never) },
      { name: "upsertNotifyRule", url: "/admin/notify/rules", run: () => engine.upsertNotifyRule({ channelId: "c" } as never) },
      { name: "upsertExpiryItem", url: "/admin/expiry", run: () => engine.upsertExpiryItem({ label: "l", kind: "licence", expiresAt: "2026-12-31" } as never) },
      { name: "acceptPostureRisk", url: "/admin/posture/accept", run: () => engine.acceptPostureRisk("chk", "accepted") },
      { name: "unacceptPostureRisk", url: "/admin/posture/unaccept", run: () => engine.unacceptPostureRisk("chk") },
    ];
    for (const c of mcases) {
      let restore = stub({ status: 200, text: JSON.stringify({ id: "x" }) });
      let res = await c.run();
      ok(`${c.name}: a 200 resolves to status:applied`, res.status === "applied");
      restore();
      restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg_x", status: "pending", contentHash: "hx" }) });
      res = await c.run();
      ok(`${c.name}: a 202 resolves to status:pending`, res.status === "pending");
      restore();
    }
  }

  // ========================================================================
  console.log("\n-- owner-action (parseJsonOrOwnerAction) methods: result + queued --");
  // ========================================================================
  {
    type OCase = { name: string; run: () => Promise<{ status: string }> };
    const ocases: OCase[] = [
      { name: "addDestination", run: () => engine.addDestination({ endpoint: "https://s3", bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" } as never, "label", "d1") },
      { name: "removeDestination", run: () => engine.removeDestination("d1") },
      { name: "setDefaultDestination", run: () => engine.setDefaultDestination("d1") },
      { name: "setDiscoveryToken", run: () => engine.setDiscoveryToken("tok") },
      { name: "deleteIdpConnection", run: () => engine.deleteIdpConnection("c1") },
      { name: "setIdpConnectionEnabled", run: () => engine.setIdpConnectionEnabled("c1", true) },
    ];
    for (const c of ocases) {
      let restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
      let res = await c.run();
      ok(`${c.name}: a 200 resolves to status:result`, res.status === "result");
      restore();
      restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa_y", status: "pending" }) });
      res = await c.run();
      ok(`${c.name}: a 202 resolves to status:queued`, res.status === "queued");
      restore();
    }
  }

  // ========================================================================
  console.log("\n-- passkey register/finish + listPasskeyCredentials (no email) + regenerateRecoveryCodes --");
  // ========================================================================
  {
    // passkeyRegisterFinish rides gatedFetch (a step-up 401 retries); a plain 200 verifies.
    let restore = stub({ status: 200, text: JSON.stringify({ ok: true, email: "a@x", role: "owner" }) });
    const fin = await engine.passkeyRegisterFinish("a@x", {} as never, "Ada", "inv1");
    ok("passkeyRegisterFinish parses the verified body", (fin as { ok: boolean }).ok === true);
    restore();

    // listPasskeyCredentials with NO email omits the query param.
    let rec = record(JSON.stringify({ credentials: [] }));
    await engine.listPasskeyCredentials();
    eq(rec.calls[0]?.url, "https://engine.test/admin/passkey/credentials", "listPasskeyCredentials with no email sends a bare path");
    rec.restore();
    // ...and with an email adds the encoded query param.
    rec = record(JSON.stringify({ credentials: [] }));
    await engine.listPasskeyCredentials("a b@x");
    ok("listPasskeyCredentials with an email adds the encoded query", (rec.calls[0]?.url ?? "").includes("email=a%20b%40x"));
    rec.restore();

    // deletePasskeyCredential success arm (the non-2xx fold arm is covered above).
    restore = stub({ status: 200, text: JSON.stringify({ deleted: true }) });
    const del = await engine.deletePasskeyCredential("c1");
    ok("deletePasskeyCredential returns deleted:true on a 200", del.deleted === true);
    restore();

    // regenerateRecoveryCodes rides gatedFetch; a 200 returns the codes.
    restore = stub({ status: 200, text: JSON.stringify({ codes: ["a", "b"] }) });
    const codes = await engine.regenerateRecoveryCodes();
    ok("regenerateRecoveryCodes parses the fresh codes", (codes as unknown as { codes: string[] }).codes.length === 2);
    restore();

    // mintSupportCredential WITHOUT ttlSeconds omits it from the body.
    rec = record(JSON.stringify({ clientId: "c", secret: "s" }));
    await engine.mintSupportCredential("diagnostics" as never);
    ok("mintSupportCredential omits ttlSeconds when absent", (rec.calls[0]?.body as { ttlSeconds?: number }).ttlSeconds === undefined);
    rec.restore();

    // setLicence(null) clears; the success arm parses the status.
    restore = stub({ status: 200, text: JSON.stringify({ tier: "community" }) });
    const lic = await engine.setLicence(null);
    ok("setLicence(null) parses the cleared status", (lic as { tier: string }).tier === "community");
    restore();

    // installKeys success arm + optional operational keys included in the body.
    rec = record(JSON.stringify({ signerPublic: "pub" }));
    const ik = await engine.installKeys({ token: "t", signerPrivate: "s", breakGlassPublic: "b", operationalPublic: "op", operationalPrivate: "opr" });
    ok("installKeys parses the result on a 200", (ik as { signerPublic: string }).signerPublic === "pub");
    ok("installKeys includes operationalPublic when supplied", (rec.calls[0]?.body as { operationalPublic?: string }).operationalPublic === "op");
    rec.restore();

    // changeBindings success arm resolves to status:result carrying attached/detached.
    restore = stub({ status: 200, text: JSON.stringify({ attached: ["a"], detached: ["d"] }) });
    const cb = await engine.changeBindings("tok", [], []);
    ok("changeBindings returns attached/detached on a 200", cb.status === "result" && cb.value.attached[0] === "a" && cb.value.detached[0] === "d");
    restore();

    // reattachMissing success arm returns the re-attach plan outcome.
    restore = stub({ status: 200, text: JSON.stringify({ attached: ["SRC_KV"], alreadyAttached: ["SRC_R2"], unreconstructable: [], affects: { SRC_KV: ["dp1"] } }) });
    const rm = await engine.reattachMissing("tok");
    ok("reattachMissing returns attached/alreadyAttached on a 200", rm.attached[0] === "SRC_KV" && rm.alreadyAttached[0] === "SRC_R2");
    restore();

    // setCoverageInventory success arm returns the stored counts, and its 202 arm is the change-control
    // queue (POST /coverage/inventory is the gated `coverage-inventory` mutation), never a stored record.
    restore = stub({ status: 200, text: JSON.stringify({ kv: 2, r2: 0, d1: 1, secrets: 0 }) });
    const cov = await engine.setCoverageInventory({} as never);
    ok("setCoverageInventory returns the stored counts on a 200", cov.status === "applied" && (cov.value as unknown as { kv: number }).kv === 2);
    restore();
    restore = stub({ status: 202, text: JSON.stringify({ queued: true, id: "chg-cov", status: "pending", contentHash: "h" }) });
    const covQ = await engine.setCoverageInventory({} as never);
    ok("setCoverageInventory reports the gate's 202 as pending, not as stored counts", covQ.status === "pending" && covQ.changeId === "chg-cov");
    restore();

    // rollbackUpdate / settleUpdate / rotateBreakGlass / setBreakGlassOnly / retireBreakGlassToken success arms.
    restore = stub({ status: 200, text: JSON.stringify({ outcome: "rolled-back" }) });
    ok("rollbackUpdate parses the structured result", ((await engine.rollbackUpdate("t")) as { outcome: string }).outcome === "rolled-back");
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ outcome: "applied" }) });
    const settled = await engine.settleUpdate("t");
    ok("settleUpdate parses the structured result", settled.status === "result" && settled.value.outcome === "applied");
    restore();
    // The KEEP direction of a settle is the gated owner action `update-settle`, so a 202 is the queue and
    // must never be read as an outcome (an absent `outcome` used to make the retry ladder re-submit it).
    restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa-settle", status: "pending" }) });
    const settleQ = await engine.settleUpdate("t");
    ok("settleUpdate reports the owner-action 202 as queued, not as a settle outcome", settleQ.status === "queued" && settleQ.id === "oa-settle");
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
    ok("rotateBreakGlass returns ok:true on a 200", ((await engine.rotateBreakGlass("t", "b")) as { ok: boolean }).ok === true);
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ ok: true }) });
    ok("setBreakGlassOnly returns ok:true on a 200", ((await engine.setBreakGlassOnly("t")) as { ok: boolean }).ok === true);
    restore();
    restore = stub({ status: 200, text: JSON.stringify({ retired: true }) });
    const bg = await engine.retireBreakGlassToken();
    ok("retireBreakGlassToken returns retired:true on a 200", bg.status === "result" && bg.value.retired === true);
    restore();
    // Retiring is the gated owner action `break-glass-retire`: a 202 means the static token STILL signs in
    // until a second owner approves, so it must never resolve to a retired record.
    restore = stub({ status: 202, text: JSON.stringify({ ownerActionQueued: true, id: "oa-bg", status: "pending" }) });
    const bgQ = await engine.retireBreakGlassToken();
    ok("retireBreakGlassToken reports the owner-action 202 as queued, not as retired", bgQ.status === "queued" && bgQ.queued.id === "oa-bg");
    restore();

    // passkeyRegisterBegin / passkeyLoginBegin body assembly: optional fields omitted when empty.
    rec = record(JSON.stringify({ ok: true }));
    await engine.passkeyRegisterBegin("a@x");
    const rb = rec.calls[0]?.body as { displayName?: string; inviteToken?: string };
    ok("passkeyRegisterBegin omits displayName and inviteToken when absent", rb.displayName === undefined && rb.inviteToken === undefined);
    rec.restore();
    rec = record(JSON.stringify({ ok: true }));
    await engine.passkeyLoginBegin();
    ok("passkeyLoginBegin omits email when absent", (rec.calls[0]?.body as { email?: string }).email === undefined);
    rec.restore();
  }

  // ========================================================================
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
