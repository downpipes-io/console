// THE OTHER NINE REFUSAL SITES: every remaining raw readErrorReason call site, driven to the sentence a
// customer actually reads.
//
// Run with: node test/validate-nine-refusal-sites.ts
//
// validate-worst-day-refusals.ts closed this defect on the restore apply and deliberately left the rest,
// naming nine sibling call sites with the same shape. This file establishes what each of them put in front
// of a customer, and holds the fix.
//
// THE SHAPE. lib/api/client-transport.ts failResponse folds a CLOSED CLASS into every 403 throw
// (FORBIDDEN_CLASS_MARKER), and components/error-view.ts forbiddenCopy reads it back so that "Your role does
// not permit this action" is said ONLY where the engine's route gate named a capability the caller lacks. A
// call site that reads the body for a reason FIRST and throws on any reason it finds never reaches
// failResponse: no class is folded, forbiddenClass() returns null, and the copy falls to its default. Every
// one of the four 403s then reads as a role denial, including the CSRF-origin one for which the console holds
// a reviewed sentence saying it is "not anything about your role or your permissions".
//
// WHAT WAS DRIVEN, and the verdicts are not uniform:
//
//   installKeys / addOperationalKey / setBreakGlassOnly (client-keys.ts)  DEFECT, fixed.
//       Surface: components/keys/shared.ts renderTokenApply -> errorDetail. All four 403s read the role
//       sentence; now each reads its own.
//   deletePasskeyCredential (client-session.ts)                           DEFECT, fixed, PLUS a second surface.
//       Surface: the revoke row's toast, which spliced the RAW throw. Before: "revoke passkey: forbidden:
//       403". Fixing only the client would have made it "revoke passkey: forbidden-class=engine-capability:
//       403" -- the console's own classifier token in front of a customer, which is the trap
//       validate-worst-day-refusals.ts hit on the batch row. The toast goes through refusalText now.
//   reattachMissing (client-sources.ts)                                   DEFECT, fixed.
//       Surface: "Could not re-attach. " + errMsg -> refusalText. Before, the whole sentence a customer read
//       for a firewall block page was the single word "forbidden".
//   setLicence (client-downpipes.ts)                                      DEFECT, fixed. Same, via
//       engineRefusalText; the 400 verify-before-store reasons this fold exists for still ride verbatim.
//   rollbackUpdate (client-update.ts)                                     DEFECT, fixed. Same, via
//       updateRefusalText, on the recovery control for a live-but-bad version.
//   rollbackPlan / settleRampUpdate (client-update.ts)                    SHAPE PRESENT, NO CUSTOMER READS IT.
//       Both throws are swallowed by their only callers (confirmEngineRollback's catch;
//       runSettleLadder's retry catch). Driven below rather than assumed. Changed anyway so the family reads
//       one way, but reported as inert rather than as a defect fixed.
//
// A SECOND DEFECT FOUND IN A FILE THIS TOUCHED, and it is live on main today with no client change needed.
// screens/access-security/sessions-passkeys.ts refusedMessage is called on exactly one path (the `forbidden`
// branch of the two admin session levers) and spliced errText raw, so it renders the transport's classifier
// token. Its comment justified that by the engine's owner-escalation guard reason needing to survive -- but
// that guard answers 400, not 403 (engine src/admin/client-diag-vocab.ts states it), so on the one path this
// function runs there has never been an engine reason to preserve. It goes through refusalText now.
//
// WHY THIS TEST IS NOT VACUOUS. The trap is an assertion that would pass with its subject absent:
//
//   1. Every assertion is against a LITERAL customer-visible string, never against another call of the code
//      under test, so a rule that broke on both sides would not stay green.
//   2. Each site has a NEGATIVE control as well as a positive one: the class's own sentence must appear AND
//      the role sentence must not. Reverting foldableReason to readErrorReason at any site collapses its
//      403s onto the role sentence and fails the negative half.
//   3. A NO-TOKEN sweep over every rendered string, so a fix that folded the class but leaked it to the
//      customer fails here rather than shipping.
//   4. A POSITIVE TWIN for the negative controls: the engine's own 400 reason must survive VERBATIM at every
//      site that has one. A rule that discarded every message and returned a constant would satisfy every
//      "no token, no role sentence" assertion and would be a worse product.
//   5. The dual-control carve-out is asserted here too: "restore not approved" must still fold on a 403 and
//      still classify as restore-unapproved, so a fix that closed the conflation by dropping the fold
//      entirely fails rather than shipping.
//   6. The two INERT sites are driven through their real callers, so "no customer reads it" is a result
//      rather than a reading of the source.

import { installDomShim, textOf, flushAsync } from "./dom-shim.ts";

installDomShim();

import { Transport } from "../src/lib/api/client-transport.ts";
import { installKeys, addOperationalKey, setBreakGlassOnly } from "../src/lib/api/client-keys.ts";
import { deletePasskeyCredential } from "../src/lib/api/client-session.ts";
import { reattachMissing } from "../src/lib/api/client-sources.ts";
import { rollbackUpdate, rollbackPlan, settleRampUpdate } from "../src/lib/api/client-update.ts";
import { setLicence } from "../src/lib/api/client-downpipes.ts";
import { errorDetail, refusalText } from "../src/components/error-view.ts";
import { errMsg } from "../src/screens/sources/shared.ts";
import { updateRefusalText, engineRefusalText } from "../src/screens/licence/shared.ts";
import { refusedMessage } from "../src/screens/access-security/sessions-passkeys.ts";
import { classifyError, forbiddenClass, FORBIDDEN_CLASS_MARKER, RESTORE_UNAPPROVED_REASON } from "../src/lib/errors.ts";

let failures = 0;
let checks = 0;
function ok(label: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// THE ROLE SENTENCE, quoted once. It is the exact text the defect put in front of operators whose role was
// fine, on nine controls.
const ROLE_SENTENCE = "Your role does not permit this action";

// THE FOUR 403s the engine's own perimeter and gates produce, by the bodies they actually answer with.
const BODY_CAPABILITY = { error: "forbidden", required: "keys.ceremony" };
const BODY_AUTHZ = { error: "forbidden" };
const BODY_CSRF = { error: "csrf origin check failed" };
const BLOCK_PAGE = "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>error 1020</body></html>";

// A sentence from each class's reviewed copy, short enough to be unambiguous and long enough that no other
// class's copy contains it.
const CSRF_MARK = "not anything about your role or your permissions";
const NOT_ENGINE_MARK = "did not arrive in the engine's own form";
const AUTHZ_MARK = "deliberately did not say which permission was missing";

let fetchCalls = 0;

function stub(status: number, body: unknown, contentType = "application/json"): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    fetchCalls++;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  };
}

// caught drives a REAL client call against the stubbed fetch and returns what it threw (or null).
async function caught(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  return null;
}

const t = new Transport("https://engine.example.test");

// A site is a real client call plus the REAL surface that renders its failure, so the string asserted is the
// string a customer reads.
type Site = { name: string; call: () => Promise<unknown>; render: (err: unknown) => string };

const SITES: Site[] = [
  {
    name: "install keys",
    call: () => installKeys(t, { token: "tok", signerPrivate: "s", breakGlassPublic: "b" }),
    // keys/shared.ts renderTokenApply's catch: err.textContent = errorDetail(e).
    render: errorDetail,
  },
  {
    name: "add operational key",
    call: () => addOperationalKey(t, { token: "tok", operationalPublic: "p", operationalPrivate: "q" }),
    render: errorDetail,
  },
  {
    name: "break-glass-only",
    call: () => setBreakGlassOnly(t, "tok"),
    render: errorDetail,
  },
  {
    name: "revoke passkey",
    call: () => deletePasskeyCredential(t, "cred-1"),
    // access-security/sessions-passkeys.ts: toast "Could not revoke this passkey. <refusalText>".
    render: (err) => `Could not revoke this passkey. ${refusalText(err)}`,
  },
  {
    name: "re-attach sources",
    call: () => reattachMissing(t, "tok"),
    // sources/tiers.ts: err.textContent = "Could not re-attach. " + errMsg(e).
    render: (err) => `Could not re-attach. ${errMsg(err)}`,
  },
  {
    name: "roll back update",
    call: () => rollbackUpdate(t, "tok"),
    // licence/rollback.ts, update-console-check.ts, update-components-advanced.ts all render updateRefusalText.
    render: updateRefusalText,
  },
  {
    name: "set licence",
    call: () => setLicence(t, "licence-token"),
    // licence/activation.ts: formError.textContent = engineRefusalText(err).
    render: engineRefusalText,
  },
];

async function main(): Promise<void> {
  // =================================================================================================
  console.log("\n1. THE FOUR 403s, at every site a customer can reach, through the REAL surface");
  // =================================================================================================
  // Positive: the class's own sentence. Negative: the role sentence is absent. Both halves, every class,
  // every site. The negative half is what a revert to readErrorReason fails.
  const CLASSES: { label: string; status: number; body: unknown; contentType?: string; mark: string }[] = [
    { label: "engine-csrf (the origin check pre-empts every cookie-borne save)", status: 403, body: BODY_CSRF, mark: CSRF_MARK },
    { label: "not-engine-body (a WAF block page the engine never saw)", status: 403, body: BLOCK_PAGE, contentType: "text/html", mark: NOT_ENGINE_MARK },
    { label: "engine-authz (the DO's funnel, which names nothing)", status: 403, body: BODY_AUTHZ, mark: AUTHZ_MARK },
  ];

  for (const site of SITES) {
    console.log(`\n  -- ${site.name} --`);
    for (const c of CLASSES) {
      stub(c.status, c.body, c.contentType ?? "application/json");
      const err = await caught(site.call);
      const text = site.render(err);
      ok(`${site.name} / ${c.label}: reads its own reviewed sentence`, text.includes(c.mark));
      ok(`${site.name} / ${c.label}: does NOT claim a role denial`, !text.includes(ROLE_SENTENCE));
    }
    // The ONE 403 that IS a role denial still says so: the positive control for the negative ones above.
    stub(403, BODY_CAPABILITY);
    {
      const err = await caught(site.call);
      const text = site.render(err);
      ok(`${site.name} / engine-capability: the role sentence IS said, because the gate named a capability`, text.includes(ROLE_SENTENCE));
    }
  }

  // =================================================================================================
  console.log("\n2. NO CONSOLE-INTERNAL TOKEN REACHES A CUSTOMER (the trap the restore walk hit)");
  // =================================================================================================
  // The console's internal tokens must never surface; the engine's own words may. Every rendered string
  // above and below is swept: the class marker, any class name, and the rate-limit marker.
  const INTERNAL = [FORBIDDEN_CLASS_MARKER, "engine-capability", "engine-authz", "engine-csrf", "not-engine-body", "retry-after="];
  for (const site of SITES) {
    for (const body of [BODY_CAPABILITY, BODY_AUTHZ, BODY_CSRF]) {
      stub(403, body);
      const text = site.render(await caught(site.call));
      const leaked = INTERNAL.filter((tok) => text.includes(tok));
      ok(`${site.name}: no internal token in the 403 copy (${leaked.join(", ") || "none"})`, leaked.length === 0);
    }
    // A 429 folds RATE_LIMIT_MARKER the same way, and the same rule applies to it.
    stub(429, { error: "rate limited" });
    {
      const text = site.render(await caught(site.call));
      ok(`${site.name}: no internal token in the 429 copy`, !INTERNAL.some((tok) => text.includes(tok)));
    }
  }

  // =================================================================================================
  console.log("\n3. THE POSITIVE TWIN: the engine's own 400 reason still rides VERBATIM");
  // =================================================================================================
  // This is what stops the fix being "discard every message". Each site is given the refusal the engine
  // really makes there, and the customer must read the engine's words.
  const REASONS: { name: string; call: () => Promise<unknown>; render: (e: unknown) => string; status: number; reason: string }[] = [
    { name: "install keys", call: () => installKeys(t, { token: "tok", signerPrivate: "s", breakGlassPublic: "b" }), render: errorDetail, status: 400, reason: "a signer key is already installed; set confirmRekey to replace it" },
    { name: "add operational key", call: () => addOperationalKey(t, { token: "tok", operationalPublic: "p", operationalPrivate: "q" }), render: errorDetail, status: 409, reason: "an operational key is already present" },
    { name: "revoke passkey", call: () => deletePasskeyCredential(t, "c"), render: (e) => `Could not revoke this passkey. ${refusalText(e)}`, status: 400, reason: "cannot revoke the last passkey of the sole Owner; enrol another key or appoint a second Owner first" },
    { name: "re-attach sources", call: () => reattachMissing(t, "tok"), render: (e) => `Could not re-attach. ${errMsg(e)}`, status: 400, reason: "the deploy token is missing the Workers edit scope" },
    { name: "roll back update", call: () => rollbackUpdate(t, "tok"), render: updateRefusalText, status: 400, reason: "no recorded known-good version to roll back to" },
    { name: "set licence", call: () => setLicence(t, "x"), render: engineRefusalText, status: 400, reason: "licence signature did not verify under the pinned vendor key" },
  ];
  for (const r of REASONS) {
    stub(r.status, { error: r.reason });
    const text = r.render(await caught(r.call));
    ok(`${r.name}: the engine's ${r.status} reason survives verbatim`, text.includes(r.reason));
    ok(`${r.name}: and it is not replaced by the role sentence`, !text.includes(ROLE_SENTENCE));
  }
  // errorDetail is the renderTokenApply surface and it deliberately does NOT show a raw engine reason (it is
  // the classified sentence only), so the two key sites above are checked at the CLIENT instead: the reason
  // must be in the throw, which is what any reason-showing surface would read.
  {
    stub(409, { error: "an operational key is already present" });
    const err = await caught(() => addOperationalKey(t, { token: "tok", operationalPublic: "p", operationalPrivate: "q" }));
    ok("add operational key: the engine's 409 reason is in the throw (the fold still happens off the marker statuses)", String((err as Error).message).includes("an operational key is already present"));
  }

  // =================================================================================================
  console.log("\n4. THE CARVE-OUT: 'restore not approved' must still fold, on a 403");
  // =================================================================================================
  // The one 403 the shape gate cannot name. classifyForbiddenBody tests `error` against the engine's frozen
  // tokens and this reason is not among them, so without the carve-out it returns the honest residual
  // not-engine-body and a customer is told a firewall refused their restore when a colleague has not signed
  // it yet. Asserted rather than assumed to survive: a fix that closed the conflation by dropping the fold
  // fails here.
  {
    stub(403, { error: RESTORE_UNAPPROVED_REASON });
    const reason = await t.foldableReason(new Response(JSON.stringify({ error: RESTORE_UNAPPROVED_REASON }), { status: 403, headers: { "content-type": "application/json" } }));
    ok("foldableReason still folds the dual-control reason on a 403", reason === RESTORE_UNAPPROVED_REASON);
    const err = new Error(`restore: ${RESTORE_UNAPPROVED_REASON}: 403`);
    ok("and it classifies as restore-unapproved, NOT forbidden", classifyError(err).kind === "restore-unapproved");
    ok("and it carries no forbidden class, so it never reaches the firewall copy", forbiddenClass(err) === null);
    ok("and the not-engine-body sentence is NOT what a customer would read for it", !refusalText(err).includes(NOT_ENGINE_MARK));
  }
  // The negative control for the carve-out: an ORDINARY 403 reason must NOT be folded, or the guard is
  // vacuous. This is the assertion that fails if foldableReason is reduced to "fold everything".
  {
    const r = new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    ok("foldableReason returns null for an ordinary 403 reason (the guard is not vacuous)", (await t.foldableReason(r)) === null);
  }
  // AND AT THE CUSTOMER SENTENCE, through the real restore client. setLicence lives in the same module as
  // restore(), so an edit there that broke the carve-out would show up here rather than only in the walk's
  // own file. This is the assertion that says what a customer waiting on a colleague's approval reads.
  {
    const { restore } = await import("../src/lib/api/client-downpipes.ts");
    const { blockError } = await import("../src/components/error-view.ts");
    stub(403, { error: RESTORE_UNAPPROVED_REASON });
    const err = await caught(() => restore(t, { runId: "run-1", confirm: true }));
    const card = textOf(blockError(err, () => {}, { origin: "restore" })).replace(/\s+/g, " ");
    ok("a dual-control 403 reads as awaiting approval, driven through the real restore", card.includes("Awaiting approval"));
    ok("and names the maker-is-not-checker rule, so the operator knows what to do", card.includes("must differ from you"));
    ok("and is NOT told a firewall refused it", !card.includes(NOT_ENGINE_MARK));
    ok("and is NOT told their role is at fault", !card.includes(ROLE_SENTENCE));
  }

  // =================================================================================================
  console.log("\n5. THE TWO INERT SITES, driven through their real callers rather than read");
  // =================================================================================================
  // rollbackPlan and settleRampUpdate carry the same shape and NO customer reads either throw. That is a
  // claim about the callers, so the callers are driven.
  {
    const { rampSettleWithBudget } = await import("../src/screens/licence/update-retry.ts");
    stub(403, BODY_CSRF);
    fetchCalls = 0;
    const run = await rampSettleWithBudget({ settleRampUpdate: (tok: string) => settleRampUpdate(t, tok) } as never, "tok", { graceMs: 0, settleBackoffMs: [] });
    ok("settleRampUpdate: a 403 is swallowed by the ladder, which returns no definitive answer", run.definitive === null && run.lastSeen === null);
    ok("settleRampUpdate: the ladder really called the client (the swallow is not an empty loop)", fetchCalls > 0);
  }
  {
    // rollbackPlan's only caller is confirmEngineRollback, whose catch sets paired=false and proceeds to a
    // plain confirm. Drive the client throw and assert the caller's own branch value, then that the throw
    // carries the class so a LATER caller that does surface it inherits the right shape.
    stub(403, BODY_CSRF);
    const err = await caught(() => rollbackPlan(t));
    ok("rollbackPlan: a 403 throws (the caller's catch is the only reader)", err !== null);
    ok("rollbackPlan: and the throw carries the folded class, so a future surface renders the right sentence", forbiddenClass(err) === "engine-csrf");
    ok("rollbackPlan: which is NOT the role sentence", !errorDetail(err).includes(ROLE_SENTENCE));
  }

  // =================================================================================================
  console.log("\n6. refusedMessage: the admin session levers stop printing a classifier token");
  // =================================================================================================
  // Called on exactly one path (the `forbidden` branch of terminate-user / terminate-all), where the
  // transport folds a class and never the body's words. Before this, the parenthesis held
  // "terminate member sessions: forbidden-class=engine-capability: 403".
  {
    const HINT = "Needs the roles.write capability.";
    const csrf = new Error(`terminate member sessions: ${FORBIDDEN_CLASS_MARKER}=engine-csrf: 403`);
    const msg = refusedMessage(csrf, HINT);
    ok("refusedMessage: no classifier token reaches the operator", !INTERNAL.some((tok) => msg.includes(tok)));
    ok("refusedMessage: the CSRF class reads as itself", msg.includes(CSRF_MARK));
    ok("refusedMessage: the capability hint still accompanies it", msg.includes("roles.write"));
    ok("refusedMessage: it does not assert a role denial for a CSRF fault", !msg.includes(ROLE_SENTENCE));
    const cap = refusedMessage(new Error(`terminate member sessions: ${FORBIDDEN_CLASS_MARKER}=engine-capability: 403`), HINT);
    ok("refusedMessage: a genuine capability denial DOES read as one (the positive control)", cap.includes(ROLE_SENTENCE) && cap.includes("roles.write"));
    // The 400 guards land on the callers' OTHER branch. Their reason must survive there, which is the
    // reachable half of the fix.
    ok(
      "the 400 owner-escalation guard's own words survive on the branch that really carries them",
      refusalText(new Error("terminate member sessions: cannot act on an Owner: 400")).includes("cannot act on an Owner"),
    );
    ok(
      "and the transport's verb and status do not ride into that sentence",
      !refusalText(new Error("terminate member sessions: cannot act on an Owner: 400")).includes("400"),
    );
  }

  // =================================================================================================
  console.log("\n7. THE RENDER HAPPENED (a 'does not contain' assertion cannot pass by producing nothing)");
  // =================================================================================================
  await flushAsync();
  {
    const { blockError } = await import("../src/components/error-view.ts");
    stub(403, BODY_CSRF);
    const err = await caught(() => setLicence(t, "x"));
    const el = blockError(err, () => {}, {});
    const h3 = el.querySelector("h3");
    ok("blockError produced a heading for the folded 403", h3 !== null && textOf(h3).trim().length > 0);
    ok("and the card's own text carries the CSRF sentence", textOf(el).replace(/\s+/g, " ").includes(CSRF_MARK));
    for (const site of SITES) {
      stub(403, BODY_CSRF);
      const text = site.render(await caught(site.call));
      ok(`${site.name}: the surface produced non-empty copy`, text.trim().length > 20);
    }
  }

  // =================================================================================================
  console.log("\n8. THE REVOKE TOAST, DRIVEN THROUGH THE REAL SCREEN (not through a copy of its expression)");
  // =================================================================================================
  // Sections 1 to 3 render through the console's SHARED helpers (errorDetail / errMsg / updateRefusalText /
  // engineRefusalText), which ARE the surface at those sites. The passkey revoke is different: its copy is an
  // inline template in the row's catch block, so asserting a re-typed copy of that template would pass with
  // the screen absent. A mutation run proved exactly that -- reverting the toast to the raw throw left every
  // other check green. So the REAL section is rendered, the REAL Revoke button is clicked, the REAL confirm
  // modal is answered, and the toast the operator would read is taken out of the live toast region.
  {
    const { sessionsAndPasskeysSection } = await import("../src/screens/access-security/sessions-passkeys.ts");
    const { EngineClient } = await import("../src/api.ts");
    const { setCaller } = await import("../src/lib/store.ts");
    const { installNav } = await import("../src/lib/nav.ts");
    const { qs } = await import("./dom-shim.ts");
    const { click, findButtonByText, SN } = await import("./validate-stable-components-shared.ts");

    installNav({ navigate: () => undefined, onUnauthorised: () => undefined, refreshIdentity: async () => undefined, onAuthenticated: async () => undefined, signOut: () => undefined });
    setCaller({ method: "access", email: "owner@example.test", role: "owner", groups: [], isOnlyOwner: true } as never);

    // One fetch stub, routed by path: the list load succeeds so a row exists to press, and the delete is the
    // CSRF 403. Nothing about the client or the screen is stubbed.
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/admin/passkey/credentials/delete")) {
        return new Response(JSON.stringify(BODY_CSRF), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/admin/passkey/credentials")) {
        return new Response(JSON.stringify({ credentials: [{ credentialId: "cred-abc123", createdAt: new Date().toISOString(), alg: -7, transports: ["internal"] }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const section = sessionsAndPasskeysSection(new EngineClient("https://engine.example.test"));
    document.body.appendChild(section);
    await flushAsync();
    const revoke = qs(SN(section), '[data-dp="access-security.button.revoke"]');
    ok("the real Revoke control rendered for the loaded credential", revoke !== null);
    if (revoke !== null) {
      click(revoke);
      await flushAsync();
      // Answer the REAL confirm modal, so the ordering (confirm, then the call) stays part of the test.
      const dialog = qs(SN(document.body), ".dialog--modal");
      ok("the real confirm modal opened before anything was sent", dialog !== null);
      if (dialog !== null) {
        const confirm = findButtonByText(dialog, "Revoke passkey");
        ok("the confirm modal offers its confirm control", confirm !== undefined);
        if (confirm !== undefined) {
          click(confirm);
          await flushAsync();
          await flushAsync();
        }
      }
      const region = qs(SN(document.body), ".toast-region--assertive");
      const toastText = region === null ? "" : textOf(region).replace(/\s+/g, " ").trim();
      ok(`the real toast rendered something (${JSON.stringify(toastText.slice(0, 60))})`, toastText.length > 20);
      ok("the real toast names the action that failed", toastText.includes("Could not revoke this passkey"));
      ok("the real toast carries NO console-internal classifier token", !INTERNAL.some((tok) => toastText.includes(tok)));
      ok("the real toast reads the CSRF class as itself", toastText.includes(CSRF_MARK));
      ok("the real toast does NOT claim a role denial", !toastText.includes(ROLE_SENTENCE));
    }
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} ${checks - failures}/${checks} checks`);
  if (failures > 0) process.exitCode = 1;
  if (failures > 0) process.exit(1);
}

await main();
