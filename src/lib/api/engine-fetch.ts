// engineFetch: the ONE seam every call to the in-account engine admin API passes through, and therefore the
// emit site for the console-diagnostics ring: it ships the engine-call kind first, on its own.
//
// Why here and not at the 36 screen catch sites: a screen that swallows a rejection into a toast is one of
// many, and each would need its own emit (and could forget one). Every engine call, without exception, goes
// through this wrapper, so instrumenting it gives COMPLETE coverage of the engine-call kind, counts an
// honest attempt DENOMINATOR (D4: the bot reasons over a failure RATIO, never a raw count, and the
// denominator must stay honest precisely when every call is failing), and adds no per-screen ceremony.
//
// It is a BYTE-FOR-BYTE pass-through of global fetch: same arguments, same return value, same rejection. It
// adds exactly two side effects, both value-free: it increments the attempt counter, and on a failure it
// pushes ONE closed-class record whose fields come only from the numeric HTTP status or from a total mapper
// over the rejection. It NEVER reads the URL, the request or response body, the headers, or the error's
// message/code/stack, so no customer value has a path into the ring from here.

import {
  faultClassForStatus,
  httpClassForRejection,
  httpClassForStatus,
  noteEngineAttempt,
  recordAdminWrite,
  recordAdminWriteThrown,
  recordEngineCall,
  writeOutcomeForStatus,
} from "../client-diag/ring.ts";
import type { ClientDiagAdminOp } from "../client-diag/vocab.ts";
import { isConsoleBindingAbsentResponse, isConsoleOriginFaultResponse } from "../errors.ts";
import { isEdgeHtmlFaultResponse } from "./topology.ts";

// EngineFetchOpts.adminOp names the PRIVILEGED WRITE this call is making, and it is
// supplied BY THE CALL SITE, which is the only place that knows. It is not inferred here, and the reason is
// the paragraph above: this function is contractually forbidden from reading the URL, and it stays that way.
// A route would have to be parsed to infer the op, a path can carry a customer id, and one route serves two
// ops (an attach and a detach are the same POST, told apart only by the arguments the console itself built).
//
// It is set only on the calls that MUTATE, and only on the real ones: the dry-run reads that share a mutating
// route (the apply plan preview, the rollback plan read) deliberately pass no op, because a refusal there is a
// plan read that failed and is expected on an older engine, not an apply or a rollback the operator lost.
// Recording those would put a phantom rollback failure in the pack on every healthy rollback confirm.
export interface EngineFetchOpts {
  adminOp?: ClientDiagAdminOp;
  deferResponseRecord?: boolean;
}

// EngineFetchOpts.deferResponseRecord suppresses the RESPONSE record for a caller that cannot yet know
// whether a non-2xx is a genuine fault. The one such caller is Transport.gatedFetch, whose step-up ceremony
// OPENS with a 401 { stepUpRequired: true }: that 401 is a normal protocol handshake (the engine asking for
// a fresh passkey assertion on a sensitive action), not a failure, and recording it would fabricate an
// `auth` fault on every successful step-up and drive a false console-engine-calls-failing signal. Such a
// caller takes on the duty of calling noteEngineResponse itself on every path where the non-2xx is really
// surfaced to the operator. The ATTEMPT is still counted, and a REJECTION is still recorded, either way.
//
// The admin-write record is deferred with it, and must be: the step-up ceremony's opening 401 would otherwise
// record every SUCCESSFUL step-up as a `denied-role` refusal of the very write it is about to let through, so
// every dual-controlled save in the console would arrive in the pack as a permissions denial. That is the
// phantom-auth-fault trap the deferral exists for, and an admin-write row is a far more clearly wrong place
// to fall into it.

// noteEngineResponse records a non-2xx response as one closed-class fault, and (when the caller named one) the
// outcome of the privileged write it carried. Every class derives from the NUMERIC status alone, EXCEPT for the
// one response that did not come from the engine at all. A 2xx records no engine-call fault; it records an
// admin-write ONLY for the ops whose success is itself the question.
//
// THE CONSOLE'S OWN 503 IS NOT AN ENGINE FAULT, and counting it as one is the same defect as the row it was
// added to fix. When the console worker has no ENGINE service binding it answers the engine surface itself, with a
// 503 (src/worker.ts). Classified on the numeric status alone, that became {engine-call, 5xx, server}: a fault
// class whose meaning is "the engine answered and failed", written for a request THE ENGINE NEVER RECEIVED. It
// pointed the reader at engine logs that hold no trace of it and fed the bot's console-engine-calls-failing ratio
// with a fabricated engine 5xx. The truth is the one the transport classifier already reaches (classify.ts maps
// the engine-binding-absent kind to `transport`, not `server`): the call did not reach the engine, so no
// engine-side evidence of it can exist. The engine-call row is still WRITTEN, and must be: every call from this
// console is failing, the attempt denominator counts them all, and a seam that dropped the fault would report a
// healthy call ratio on a console where nothing works. It is written with the class the code established.
//
// The privileged write goes the same way. `server-error` says in as many words that the engine SAW the write;
// `unreachable` says it never did and no engine-side record of it can exist, which is exactly what happened. The
// admission is the header gate (a same-origin equality test against a frozen product token, isConsoleBindingAbsent
// Response), because this seam runs before anything has read the body and a body can only be read once.
export function noteEngineResponse(r: Response, adminOp?: ClientDiagAdminOp): void {
  if (isConsoleBindingAbsentResponse(r)) {
    if (adminOp !== undefined) recordAdminWrite(adminOp, "unreachable");
    recordEngineCall("network", "transport");
    return;
  }
  // The SAME rule, one status code over. The console's own worker manufactures 500s: its last-resort handler
  // answers "internal error" when the dispatch throws, and a bound ENGINE service binding whose fetch REJECTS
  // (the engine worker deleted, throwing, or over its resource limits) lands there too. The engine never received
  // the request, so there can be no engine-side record of it.
  //
  // Classified on the bare status, that 500 became {httpClass: "5xx", faultClass: "server"} -- and `server` says
  // in as many words that the ENGINE SAW the call and refused it. The wizard then filed it as `engine-not-ok`
  // and the bot told the support engineer "the evidence is in the engine's own logs, go and read the refusals
  // there. Do NOT chase reachability." There are no refusals to read: the engine is down or absent, and the pack
  // said it was up. That is a row asserting a fact the code never established.
  if (isConsoleOriginFaultResponse(r)) {
    if (adminOp !== undefined) recordAdminWrite(adminOp, "unreachable");
    recordEngineCall("network", "transport");
    return;
  }
  // THE SAME RULE AGAIN, for the 5xx the console worker did not live to stamp. The header gate
  // above only catches a 500 the worker ANSWERED. When the worker never runs (over its CPU or memory limits,
  // script gone, an edge fault), Cloudflare answers for it with its own HTML error page, which carries no header
  // of ours, and this seam filed it as {5xx, server}: the engine saw the call and failed. In the PROXIED topology
  // the engine is a service binding and cannot answer HTML at all, so it did not.
  //
  // This seam MAY NOT READ THE BODY (a body can be read once, and the transport must have it), so the test is the
  // CONTENT TYPE, which is a header: an engine 5xx is jsonError JSON. It is a substring test against a constant
  // this repo ships and it copies nothing out of the response.
  if (isEdgeHtmlFaultResponse(r)) {
    if (adminOp !== undefined) recordAdminWrite(adminOp, "unreachable");
    recordEngineCall("network", "transport");
    return;
  }
  if (adminOp !== undefined) recordAdminWrite(adminOp, writeOutcomeForStatus(r.status));
  if (r.ok) return;
  const httpClass = httpClassForStatus(r.status);
  if (httpClass !== null) recordEngineCall(httpClass, faultClassForStatus(r.status));
}

export async function engineFetch(url: string, init?: RequestInit, opts: EngineFetchOpts = {}): Promise<Response> {
  noteEngineAttempt();
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (err) {
    // The fetch itself threw: no response exists. The class comes from a total mapper that compares the
    // error's name for EQUALITY against two frozen constants and copies nothing. An aborted call (a
    // route change or an unmount cancelled it) is recorded with NO faultClass: it is not a Downpipes
    // fault, and D5 excludes it from the failing signal.
    //
    // A privileged write that threw is recorded here even when the response record is deferred: the engine
    // NEVER SAW this write, so no engine-side evidence of it can exist, and the deferral exists only to keep
    // the step-up ceremony's 401 handshake out of the ring. A handshake needs a response to be a handshake.
    const httpClass = httpClassForRejection(err);
    if (httpClass === "aborted") recordEngineCall("aborted");
    else recordEngineCall(httpClass, "transport");
    if (opts.adminOp !== undefined) recordAdminWriteThrown(opts.adminOp, err);
    throw err;
  }
  if (opts.deferResponseRecord !== true) noteEngineResponse(r, opts.adminOp);
  return r;
}
