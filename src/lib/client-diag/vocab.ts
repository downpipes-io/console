// The FROZEN closed vocabulary for the console-diagnostics support-pack section. This is the CONSOLE MIRROR of the
// engine's canonical `src/admin/client-diag-vocab.ts`. The console and the engine are separate repos, so
// the lists cannot be imported across the boundary; instead they are defined once per repo and a
// CONFORMANCE test (test/validate-client-diag.ts) asserts the two are EQUAL, member for member and cap for
// cap (the AUTO_HEAL_REFUSAL_CODES drift-guard pattern). A member added on one side and not the other
// fails that test, so the vocabularies cannot silently drift apart.
//
// INVARIANT I2 (STRUCTURALLY VALUE-FREE): the client-diagnostics record has ZERO free-string fields. Every
// string field is a member of one of the closed unions below, checked by SET MEMBERSHIP against the frozen
// allowlist; every numeric goes through a clamp. A smuggled customer value cannot be a set member and is
// therefore structurally dropped, on the console at the ring's write boundary and again on the engine at
// the receiver. Every member here is a PRODUCT CONSTANT, provably value-free: none is derived from a URL,
// path, header, error message/name/code/stack, field name, email, label, or any other customer or server
// text.

// kind -- what fired (14). A closed product classifier, never error text.
export const CLIENT_DIAG_KINDS = [
  "engine-call", // a fetch to the engine API failed
  "contract-drift", // a 2xx body did not match the expected shape
  "bulk-outcome", // a bulk action reported partial/failed results
  "boot-fault", // app-root error boundary / failed initial render
  "unhandled", // window unhandledrejection / onerror (non-Abort)
  "deep-link-lost", // a deep link resolved to no screen
  // apply-outcome -- HOW A LIVE RESTORE APPLY ENDED, recorded on EVERY ending and not only the bad
  // ones. A kind of its own rather than another engine-call/bulk-outcome row, because the question it answers
  // (did my restore write anything?) must not COALESCE with the restore screen's other traffic: the
  // coalescing key is the closed tuple, so a plan read that 500s and an apply that wrote nothing would
  // otherwise be one row. Its applyClass is the whole discriminator; its count is how many applies ended that
  // way, so three retries of the same ending read as three.
  "apply-outcome",
  // fanout-degraded -- a bulk protect went ahead against the DEFAULT destination only, because the
  // destination list could not be read, so the replicas the operator would have chosen were never created. Its
  // EXISTENCE is the discriminator the gap asks for (destListReadFailed AND fellBackToDefault together): an
  // operator who simply chose the default never produces this row, and the two states are no longer identical
  // in the pack. A kind of its own for the same reason as above: as an engine-call row on the sources screen
  // it collided, tuple for tuple, with a discovery blip.
  "fanout-degraded",
  // capability-fault -- a BROWSER CAPABILITY the console asked for at a named point in the key or
  // recovery ceremony, and did not get. A kind of its OWN, and the reason is the whole point of the gap: the
  // first two builds of it recorded the refusal as `unhandled`, whose faultClass mapper answers other for a
  // synthetic throw. So a REFUSED identity.key download and an unrelated null-deref on the same screen produced
  // the SAME row, byte for byte, and on /access a refused recovery-codes download, a dead clipboard copy and a
  // console bug all coalesced into one row with a count of three. `unhandled` is defined to mean a console
  // DEFECT that reached no catch site; a browser that declines a download is not a defect, and counting it as
  // one inflates the defect signal while destroying the evidence.
  //
  // The discriminators are `capability` (what the browser would not do), `surface` (which ceremony asked, and
  // therefore what the customer has lost) and `capabilityOutcome` (whether the capability was absent or
  // present-and-refused). All three are in the coalescing tuple, so they discriminate.
  "capability-fault",
  // console-build-check (G153) -- WHAT BUILD THE BROWSER IS ACTUALLY BEING SERVED. The engine cannot probe a
  // console behind Cloudflare Access, so the operator's browser is the only witness that an applied console
  // update is really being served. Today the engine's update record says the console component applied and
  // NOTHING contradicts it: a CDN that kept serving the old assets, an asset deploy that failed, or an Access
  // page in front of /__build.json all leave the pack saying applied with no evidence the new build never
  // reached anyone. buildCheckClass is the whole discriminator, and `unstamped` is the quiet one: an unstamped
  // bundle blinds the console-update verdict itself, so the screen can read up to date two releases behind.
  "console-build-check",
  // console-rollback (G153) -- the operator pressed the post-apply console rollback. Its EXISTENCE is the
  // rollbackAttempted the gap asks for, and rollbackClass is how it ended. It is a kind of its own because
  // the case it exists for is the one the engine cannot record: a rollback POST that never arrives leaves no
  // engine-side rollback record at all, so a rollback that double-failed after a failed apply is invisible
  // unless the client says it tried.
  "console-rollback",
  // identity-unresolved (G155) -- the caller's identity report (/who) did NOT resolve, so caller() is null and
  // every client-side capability gate in the console falls back to the least-privileged `viewer`. Its own kind
  // because an engine-call row cannot answer the ticket: the screens that go grey make many other engine calls,
  // so a 5xx row on the security screen does not say WHICH call failed, and an actual Owner seeing every
  // control greyed out reads identically to a genuine viewer. This row says the report was ABSENT rather than
  // LOW, which is the whole question. A 401 is NOT recorded here: it is the ordinary lapsed session and it
  // routes to the signed-out screen, so recording it would fabricate a fault on every expiry.
  "identity-unresolved",
  // restore-gate-blocked (G198) -- the console did NOT offer Apply on a restore plan, and this says WHY. The
  // four preconditions of the client apply gate were previously indistinguishable, in the tab and in the pack:
  // no approval yet, no attributable caller and the client could not compute the hash it matches on all
  // rendered the same unarmed panel and recorded nothing at all. gateBlockClass separates them. The LEGITIMATE
  // state (a plan genuinely awaiting a second approver) is deliberately NOT recorded: it is the flow working as
  // designed, it persists for as long as the approver takes, and a poll that recorded it would cry wolf every
  // five seconds of a healthy dual-control ceremony.
  "restore-gate-blocked",
  // wire-anomaly (G216) -- an engine-supplied wire value that the console could not use: it did not parse, it
  // was not finite, it was negative where only a count is meaningful, or it was absent. Every one of these
  // sites silently coerced (a timestamp to 0, a count to 0, a URL to a truncated string) or crashed one screen,
  // and the pack's OWN copy of the same row is clamped by the pack builder, so the pack can read clean while
  // the console-visible copy was corrupt. fieldClass says which class of field, `anomaly` says how it was
  // wrong; the VALUE never travels, because a malformed URL or id can embed customer data.
  "wire-anomaly",
  // transport-fault (G122, G145, G147) -- HOW the transport failed, in the vocabulary the console's OWN
  // classifier already computes and then throws away. The engine-call row cannot answer these tickets, and it
  // is worth being exact about why, because the row LOOKS like it should:
  //
  //   An Access login page served as a 200 where JSON was expected records NOTHING today. It is a 2xx, so no
  //   engine-call row is written; parseJson recognises it and throws before the drift recorder, deliberately
  //   (an Access lapse is not engine drift). So the single most common every screen errors report leaves the
  //   ring completely empty, and the pack reads as a healthy console.
  //
  //   A wrong engine URL (a web page answered) records `contract-drift/malformed-body`, which is the same row
  //   a genuine engine JSON bug produces. You are pointed at the wrong address and the engine sent us
  //   rubbish are one row.
  //
  //   A CONSOLE_ORIGIN/CORS block and a real engine outage BOTH record `engine-call/network/transport`, byte
  //   for byte. They are the same row and they are opposite tickets: one is a setup step on a healthy engine,
  //   the other is an outage. The ONE fact that separates them is that the unauthenticated health probe
  //   answers while the authenticated data call is blocked, and that fact exists only in the browser.
  //
  // transportClass is the whole discriminator and it is in the coalescing tuple.
  "transport-fault",
  // read-degraded (G122, G123) -- a FIRE-AND-FORGET engine READ failed and its failure was swallowed into a
  // degraded chip or a fail-open gate. Every one of these catch sites is a deliberate `catch {}`: the console
  // must not alarm on a blip, so the chip keeps its last value, the setup gate opens, the recovery banner
  // stays down. The design is right and the silence is the bug: the operator reports identity pending
  // forever, the recovery banner never appeared, Apply a restore is missing, and the pack cannot say
  // which read was failing, or whether the engine ever received it.
  //
  // An engine-call row does not answer this. It carries `screen`, and these reads all fire from whatever
  // screen the operator happens to be on, so a 5xx on the control-plane status read and a 5xx on the credential
  // count read are ONE row on the Overview. callClass says WHICH read went quiet, and it is in the tuple.
  "read-degraded",
  // onboarding-step (G125) -- a step of the setup wizard ended, and this says which step and how. The wizard is
  // the flow with the LEAST engine-side evidence and the most tickets: the connect step's transport failure
  // never reaches the engine at all, the readiness poll exhausting is a client-side timer, and a wizard allowed
  // to finish against an erroring engine leaves the engine's own status looking merely unconfigured.
  //
  // A transport-fault row on the onboarding screen is not enough, and the reason is the gap's own list: the
  // ticket is which STEP failed, and connect, install, generate, readiness-poll and finish all render on the
  // same route. obStep and obOutcome are both in the tuple.
  "onboarding-step",
  // discovery-connect (G129) -- what the account-discovery token actually SAW. This closes the console half of
  // the gap. The three states the most common onboarding ticket confuses are all rendered to the DOM and
  // discarded: a token the engine ACCEPTED that then saw zero accounts, an account whose product listings
  // FAILED (a scope gap), and an account that is genuinely EMPTY. On screen the last two are two different
  // grey hints; in the pack they are both nothing at all.
  //
  // discoveryOutcome is the discriminator. It deliberately does NOT subdivide a REFUSED token set into
  // scope-insufficient / token-invalid / cf-api-error: the console only has the engine's refusal prose, and
  // guessing a closed class from prose the console does not own would be a classifier that silently mislabels
  // on the next engine wording change. That subdivision belongs to the engine's own discovery state (the gap's
  // `discoveryHealth` half), where the fail class is known rather than inferred.
  "discovery-connect",
  // claim-exchange (G112) -- the licence claim-code exchange with the vendor control plane. This one is not a
  // gap in the ring's coverage, it is a gap in its REACH: the exchange is a direct fetch to the control-plane
  // host, not an /admin/* call, so it never passes the engineFetch seam and the ring has never seen it. Five
  // distinct faults collapse into two operator-facing strings, and the pack carries neither.
  //
  // claimResult is the discriminator, and it is what tells a customer's own network fault apart from a vendor
  // 5xx, a CORS regression after a control-plane deploy, the 8-second timeout, and a 200 that came back with
  // no token at all.
  "claim-exchange",
  // admin-write (G171, G175, G177, G180) -- a PRIVILEGED CONSOLE WRITE and how it ended. Its shape is always
  // the same: the engine AUDITS THE WRITES THAT SUCCEED, so a write it REFUSED leaves no audit event, no config
  // event, and no trace of any kind. The refusal is a toast the operator dismissed. The pack then shows dual
  // control off, the departed employee still holding a role, the binding unattached, the known-bad version
  // still live, and NOTHING anywhere saying that anyone ever tried to change it. The operator's I turned that
  // on last week and the pack's it is off are both true, and support has no way to see that.
  //
  // A generic engine-call row cannot answer any of these tickets, and the reason is structural: engine-call
  // carries `screen`, and the security screen alone posts approval-policy, sign-in-context, change-number and
  // posture writes, so a 403 on any of them is ONE row. adminOp says WHICH privileged write, which no route id
  // and no screen id can say: several ops share one screen, and one route carries two ops (an attach and a
  // detach are the same POST, told apart only by the arguments the console itself built).
  //
  // adminOp is chosen by the CALL SITE, never derived from the request URL and never from the engine's refusal
  // prose. The call site knows exactly which privileged write it is making; a URL would have to be parsed (and
  // a path can carry a customer id, which is why engine-fetch.ts is contractually forbidden from reading one),
  // and the prose is engine text this console does not own, so a classifier over it would silently mislabel on
  // the next engine wording change. Both fields are in the coalescing tuple.
  "admin-write",
  // recovery-refusal (G196, G214) -- a DISASTER-RECOVERY refusal: a control-plane reconcile, an estate import
  // or a signed-export download that did not go through. These flows run exactly when the engine is FRESH OR
  // WIPED, so the durable audit ring the rest of the product leans on is EMPTY and the engine may hold no
  // record of anything at all. Several of the refusal classes (an export that will not parse, a signature left
  // blank) never reach the engine even in principle: they are decided in the browser, so the browser is the
  // ONLY witness there can ever be.
  //
  // recoveryCode reuses the frozen DP-R vocabulary the console ALREADY stamps into the refusal the operator is
  // reading (lib/recovery-refusal-codes.ts), so the code the customer quotes down the phone and the code in the
  // pack are one token. recoveryOp separates the three flows, which share those codes: a DP-R12 on a reconcile
  // and a DP-R12 on an estate import are different tickets. Both are in the tuple.
  "recovery-refusal",
  // identity-stale-gate (G155) -- A CAPABILITY-GATED SCREEN RENDERED WHILE THE CALLER IDENTITY WAS UNRESOLVED.
  // This is the state `identity-unresolved` cannot express, and it is the one the ticket is actually about.
  // identity-unresolved fires only when the whoami read THROWS. The commoner fault is a RACE: the router paints
  // the first screen before the boot-time identity round trip returns, every gate on that render reads
  // caller()?.role ?? "viewer", and nothing re-renders the screen when the identity later lands. An actual Owner
  // deep-linking to /security therefore sees every control greyed "owner only", the whoami read SUCCEEDED, and
  // the pack was byte-identical to a genuine viewer's: no row at all, on either side.
  //
  // The row says one thing and it is not a role: THE GATES ON THIS SCREEN WERE COMPUTED BEFORE THE IDENTITY
  // REPORT ARRIVED. `screen` says which screen was gated blind. A genuine viewer whose identity resolved before
  // the render produces NO row, so "your role really is viewer" and "we gated you as a viewer because we had not
  // asked yet" are now different evidence. Deliberately says NOTHING about what the role turned out to be: the
  // caller's role is a customer value and has no field to travel in.
  "identity-stale-gate",
  // update-channel-unverified (G171) -- THE ENGINE CONSULTED THE UPDATE CHANNEL AND THE VERDICT WAS NOT VERIFIED.
  // The engine returns {configured, verified, reason} to the console on every GET /admin/updates, and the console
  // reads `!upd.configured || !upd.verified` and silently hides the chip. So a channel whose signature has been
  // failing for six weeks and a healthy channel with nothing new to offer BOTH show no chip, and the pack was
  // identical for both: status.updateChannelConfigured is Boolean(env.UPDATE_CHANNEL_URL && env.UPDATE_SIGNER_PUBLIC),
  // an env-var presence check that stays true while the signature has been failing for a month. It is not a verdict.
  //
  // channelReasonClass is the discriminator, SELECTED from the engine's reason text and never carrying it: the
  // channel URL, the signer key and the platform's own error prose have no field to travel in.
  "update-channel-unverified",
  // intent-dropped (G229) -- the console BUILT A REQUEST that silently DISCARDED something the operator typed.
  // The restore request builder drops a half-filled option on the floor: a Max records that did not parse, a
  // cf-config or media edit token with no account id beside it, a D1 database with no tables, a redirect target
  // with an empty binding. The engine NEVER SEES the dropped intent, so no engine-side record of it exists or
  // could exist: the plan it answers is the plan for the request it was actually sent, and it is correct about
  // it. `intentClass` says WHICH option was discarded, and it is the whole row: the typed value is a Cloudflare
  // edit token or an account id and there is no field on the record for one.
  "intent-dropped",
  // probe-outcome (G238) -- an OPERATOR-INITIATED TEST and how it ended. These are the richest per-surface
  // diagnostics in the product (a destination verify, an IdP connection test, a notify or SIEM test send, an
  // email test), and they are computed, rendered once and stored NOWHERE, so an intermittent failure and a
  // vendor that has since been fixed are both unreconstructable. probeSurface says which test and probeOutcome
  // how it ended, and BOTH are needed: a red cert check on an IdP test and a 403 from a SIEM endpoint are not
  // the same ticket. `ok` is a member, deliberately: it fails every morning and works on retry is a claim
  // about the RATIO of good runs to bad, and a ring that recorded only the failures could not answer it.
  "probe-outcome",
  // form-rejected (G240) -- the console's OWN client-side validator turned an operator away, or quietly
  // replaced what they typed. No request is made, so the engine sees NOTHING: a customer blocked at setup for a
  // week, or one whose contracted rate was silently swapped for the vendor preset, produces zero remote
  // evidence, and a console validator that has drifted TIGHTER than the field catalogue is undetectable in the
  // field. formField is the catalogue control id (a closed product vocabulary, never the typed value: these
  // fields hold endpoints, ARNs, account ids and rates) and rejectOutcome separates a REFUSAL the operator can
  // see from a COERCION they cannot.
  "form-rejected",
  // catalogue-degraded (G243) -- the console did not OFFER Cloudflare configuration, or offered it against a
  // catalogue it could not trust, and catalogueClass is why. The console's own hint text is the only place any
  // of this is said today and it dies with the render. The classes separate the four states the ticket the
  // wizard stopped offering Cloudflare configuration confuses: an under-scoped discovery token, an engine that
  // predates the feature, a source that was never added, and an account the token can read nothing in. Joined
  // to the engine's own discoveryHealth (which knows whether the zone listing was DENIED) the pair resolves the
  // first two, which neither half can do alone.
  "catalogue-degraded",
  // feature-probe (G250) -- WHICH DIAGNOSIS THE CONSOLE REACHED about a route it could not read. The console
  // systematically conflates a live 5xx with a route that was never built (the pending-the-engine tile), maps
  // every failure of the config-approvals read to feature-absent, and presents a whoami 500 as a benign
  // degrade, so support cannot tell BROKEN from UNBUILT. featureClass names the route family and featureOutcome
  // the verdict, and the verdict is the point: `origin-rejected` is the console's CONSOLE_ORIGIN diagnosis (the
  // fetch threw with no response AND the unauthenticated health probe answered in the same breath), which the
  // console computes today and then throws away, and `engine-url-unparseable` is a setup wizard that never
  // built a client at all, so every other row in this ring is silent by construction.
  "feature-probe",
  // gov-gate (G252) -- a GOVERNANCE GATE the CONSOLE applied, which by construction leaves no engine-side trace.
  // A role-gate refusal greys a control out and makes NO request, so there is no 403 and no audit row anywhere.
  // A change-number prompt SKIPPED because the policy read failed proceeds without a reference, and the engine's
  // own 400 count (configIntegrity.changeControlRefusals) shows the refusal without ever saying the console
  // never asked. govGate is which gate, and adminOp (the same closed op vocabulary the admin-write rows use, so
  // the two join) is which action it fell on.
  "gov-gate",
  // console-skew (G254) -- WHICH CONSOLE BUILD IS ACTUALLY RUNNING, expressed as its RELATION to the engine that
  // is answering it. The pack carries engine.version and has never carried anything at all about the browser's
  // build, so a skewed pair (a dead Approve button, a feature that is silently off, an origin still serving the
  // old assets) is indistinguishable from a defect. The row is a CLASS, not a version string, and that is not a
  // redaction compromise but the better evidence: the version alone would still need the engine's to be read
  // against, and this row IS that comparison, made in the one place that can see both.
  "console-skew",
  // material-rejected (G256) -- OPERATOR KEY OR CEREMONY MATERIAL the console REFUSED. Every one of these
  // refusals is decided in the BROWSER and no request is made, so the engine holds no record of it and could
  // not: a pasted recovery share that will not decode, and a stored ceremony result the console read back and
  // threw away (so it asks the operator to run the whole key ceremony again), are both invisible. The screen
  // says "that does not look right" and the pack says nothing at all.
  //
  // materialClass is the whole discriminator and it is chosen at the REJECT BRANCH, which already knows exactly
  // why it refused: the decoder throws on a non-canonical length, a character outside the alphabet, base64
  // padding (a share pasted from a standard-base64 tool), or a byte above ASCII (a smart-quoted or reflowed
  // paste out of an email client). NOTHING about the material rides: not the pasted text, not the offending
  // character, not its position, not a length. A length is a fingerprint of the secret and the class already
  // says the length was wrong.
  "material-rejected",
  // contract-skew (G261, G289) -- THE CONSOLE WAS HANDED DATA IT COULD NOT INTERPRET, AND RENDERED SOMETHING
  // PLAUSIBLE ANYWAY. This is the quietest failure in the product and the one with the most expensive tickets,
  // because every symptom of it reads as a defect or as genuinely empty state: an unknown IdP preset becomes a
  // generic globe tile, an unknown source-type id becomes a cryptic label in the cost table, a v9 snapshot whose
  // `roles` came back as something other than an array reports 0 role grants when there were 12, a missing
  // `connections` array turns three live IdP connections into three empty add-a-provider tiles, an unknown change kind renders
  // an Approve button the engine will always refuse, a change with no description asks an operator to approve
  // prose that is not there, and a client watch ceiling that has drifted from the engine's run ceiling ends the
  // flight animation early. The pack carries engine.version, so support can see WHICH engine is deployed; it has
  // never carried the fact that the console SAW something it did not recognise, so drift and defect are one.
  //
  // contractClass is HOW the contract was broken, fieldFamily is WHICH family of data broke it, and both are in
  // the coalescing tuple: without fieldFamily an unknown IdP preset and an unknown source-type id are one row,
  // and without contractClass a `connections` array that arrived MALFORMED and one that was simply ABSENT are
  // one row, which are different engine bugs. The unrecognised VALUE never rides: a new enum member could be an
  // operator-named preset id or a customer's own source label.
  "contract-skew",
  // fleet-drill (G287) -- ONE FLEET-DRILL SESSION, as the CONSOLE assembled it. The engine records each drill it
  // actually handled (§4.3 carries lastRestoreTestAt/Ok/Reason per downpipe), so the per-pipe outcomes are in
  // the pack already. What was never anywhere is the SHAPE OF THE SESSION: how many pipes the console targeted,
  // how many it silently could not target at all, whether the loop finished or was cut short, and whether it
  // exhausted its 429 retries. Those four facts are exactly what separates the tickets that look identical:
  //
  //   Drill evidence shows 8 of 30 downpipes on one date. Was that a deliberate partial drill, or a fleet drill
  //   that hit a 401 at pipe 9 and aborted? The engine sees the same 8 either way.
  //
  //   One downpipe never appears in ANY drill. collectDrillTargets skips a downpipe whose latest history row
  //   carries no runId, silently, so it is not that the drill failed: the drill was never attempted, and the
  //   pipe simply is not in the evidence. Absence of a row is the same absence a never-run pipe produces.
  //
  //   A large-fleet drill that failed after exhausting its capped 429 retries produced a toast and nothing else.
  //
  // drillFact says WHICH of the session's counts the row carries and `count` carries it; drillAbort says how the
  // session ended. Both are in the tuple, so an aborted session's counts never coalesce with a clean session's.
  // NO DOWNPIPE IDS RIDE. The gap proposed capping failed ids at 25; this ring has no field for an id and will
  // not grow one, and it does not need to: the pipe-level outcomes are already in §4.3, keyed by pipe. What was
  // missing is the session, and the session is counts.
  "fleet-drill",
  // owner-action-refusal (G300) -- a DUAL-CONTROL owner action the approve/reject did not go through on. The
  // engine audits owner-action propose/approve/execute/reject, so every action that COMPLETED is in the pack.
  // A refusal is the one thing that is not: it is a toast the operator dismissed, and the proposal sits in the
  // inbox looking untouched. "Nobody rejected it and it just vanished" is then unanswerable from the pack,
  // because the pack agrees with the customer: nothing happened.
  //
  // ownerActionCode is the discriminator and adminOp (owner-action-approve / owner-action-reject) says which
  // route it fell on. It matters that they are separate members rather than one "refused": a self-approval is
  // the maker != checker rule WORKING (the operator needs a second owner, and support says so down the phone),
  // a not-owner refusal is a ROLE problem (the person approving does not hold the owner-reserved capability),
  // and a terminal-state refusal means the action was ALREADY decided or has EXPIRED underneath them, which is
  // the ticket itself. The engine cannot separate the first two: it answers 403 for both.
  "owner-action-refusal",
  // role-delete-impact (G301) -- a custom role was DELETED, and this is how many grants still referenced it at
  // the moment it went. Every one of those members silently falls to the viewer floor server-side, so the
  // custom-role-change delete event rides in the pack and the CONSEQUENCE (Bob lost restores) rides nowhere.
  // `count` carries the number of surviving grants, and a delete that affected NOBODY is recorded too, with a
  // count of zero: without the zero row, "we tidied up roles and nothing broke" and "we tidied up roles and
  // downgraded four people" would both be an absence.
  "role-delete-impact",
  // csp-violation (G304) -- the browser BLOCKED something the page asked for, under the console's own strict
  // Content-Security-Policy. The console worker's /csp-report route 204-discards every report it is sent, and
  // it has nowhere to put one anyway (it is a stateless asset worker, not the engine), so the evidence has
  // never existed. The browser's own `securitypolicyviolation` event is the witness that CAN reach the pack:
  // it fires in the same page that holds the ring, so a blocked script rides inside the customer's own bundle.
  //
  // cspDirective and cspBlocked are both in the tuple, and both are needed. The documented incident (a stale
  // hashed chunk silently blocked after an update, leaving a broken pre-paint) is {script-src, self}: the
  // console's OWN asset, blocked by its own policy. A third-party injection attempt is {script-src, external}.
  // A theme that renders wrong is {style-src, inline}. An engine call blocked by connect-src is a setup fault
  // and is {connect-src, external}. Without both fields these are one row, and they are four different tickets.
  //
  // NOTHING from the report body rides: not the blocked URI, not the source file, not the line, not the script
  // sample. A blocked URI is an attacker-supplied string by definition on the case that matters most.
  "csp-violation",
  // input-dropped (G308) -- the console SILENTLY DISCARDED part of what the operator pasted, before any request
  // was made. splitPems keeps the certificate blocks that match and drops whatever did not; the coverage
  // inventory parser skips a line with no id. Neither the console nor the engine ever saw the dropped block, so
  // the submission is smaller than the paste and no evidence of that exists anywhere: at the next SAML cert
  // rotation, weeks later, sign-in breaks and §4.17 ssoFailures points at the key, which is the wrong end.
  //
  // dropSurface says which paste and dropFact says which of the two numbers the row carries, so accepted and
  // dropped are separate rows and both are in the tuple. Rows are written ONLY when something was dropped: a
  // clean paste is the ordinary state and recording it would cry wolf on every save.
  "input-dropped",
  // handoff-dropped (G310) -- a WIZARD OR DEEP-LINK HAND-OFF lost the operator's earlier pick between steps. The
  // one-shot prefill is consumed and dropped in the browser, and the assembled source spec simply OMITS a field
  // that was expected and absent, so the operator sees an empty wizard ("I clicked Protect this zone and nothing
  // was selected") or a generic engine 400 on create, and support cannot tell a broken product journey from
  // operator error. handoffClass is the whole row: the query string, the zone id, the account id and the binding
  // name are all customer values and none of them has a field here.
  "handoff-dropped",
  // ceremony-step (G328) -- a BROWSER-SIDE KEY-CEREMONY OR CREDENTIAL-ENROLMENT STEP and how it ended. This is
  // the deliberate no-custody blind spot: the split, the in-browser encryption, the printable-payload round-trip
  // check and the recovery-codes copy all happen in the browser and NOTHING about them has ever left it, so a
  // customer whose ceremony keeps failing is debugged from screenshots, and a paper backup that turns out corrupt
  // in a real disaster has no record that the console warned them at the time.
  //
  // `ok` is a member of ceremonyOutcome and it is not padding: "the recovery codes were never saved because the
  // copy silently failed" is answered by the ABSENCE of an ok row beside the presence of a failed one, and a
  // ceremony that was run and worked must be tellable from one that was never run at all.
  //
  // NO MATERIAL RIDES, and the list of what does not is the point: no key bytes, no share bytes, no ciphertext,
  // no payload fragment, no decode offset, and deliberately not N or the threshold. N and the threshold are the
  // customer's own custody design and they are a fingerprint of it; the step enum, the outcome and a coarse
  // fault class answer every ticket without them.
  "ceremony-step",
  // storage-blocked (G336) -- the BROWSER REFUSED to keep something the console asked it to keep. On a
  // locked-down enterprise profile localStorage and sessionStorage throw on access, and every call site in the
  // console swallows that throw by design (a preference that will not persist must never break a flow). The
  // result is a console that loses half-filled wizards, forgets which engine it is pointed at, and re-enables
  // auto-refresh over a motion-sensitivity pause, with NOTHING anywhere admitting the browser is the cause. It
  // is a kind of its own because it is not an engine call, not a console defect and not a capability the
  // customer pressed a button for: it is an environment fact, and the fix is a browser-policy fix.
  //
  // The discriminators are `storageArea` (which store), `storageClass` (WHY: denied by policy, out of quota, or
  // absent from the host) and `storageSurface` (WHAT the customer lost), and all three are in the coalescing
  // tuple. Without them a blocked localStorage and a full sessionStorage would be one row, and a lost draft and
  // a forgotten engine URL would be one row: three tickets with three different answers, told apart by nothing.
  // The stored VALUE is never read: the key is not recorded either (a draft id can carry a run id).
  "storage-blocked",
  // renderer-degraded (G345) -- WHICH RENDERER WAS ACTUALLY LIVE on the topology map, and why it was not the
  // full one. "The map is frozen / is a static diagram for one user" is a browser-policy ticket (a blocked
  // canvas, an extension freezing requestAnimationFrame) whose only evidence today is a Copy-view-diagnostics
  // block that reaches support ONLY if the customer manually pastes it.
  //
  // It is a STATE row, not a fault row, and `none` is a member on purpose: the pack must be able to say the
  // renderer WAS live, or "the map is frozen" and "the customer never opened the map" are the same evidence.
  // For the same reason `reduced-motion` is a member and is not counted as a browser fault: a static frame the
  // operator ASKED for is a legitimate state, and telling it apart from a canvas the browser refused is the
  // whole point (one is an accessibility preference, the other is a policy the customer must change).
  //
  // WebGL is deliberately NOT a cause. The console's live view is canvas2d; it never asks for a WebGL context,
  // so a browser without WebGL renders the full live map, and a webgl-blocked row would fire on a perfectly
  // healthy session. That is exactly the wolf-cry this vocabulary refuses.
  "renderer-degraded",
  // focus-landing (G346) -- WHERE KEYBOARD FOCUS ACTUALLY LANDED after a navigation whose activating control
  // was itself the navigation. This is the FIRST member of this vocabulary that can see the accessibility
  // surface at all: no member of every
  // union here for keyboard / a11y / accessib / tablist / roving / focus is set, so a keyboard user
  // who could not arrow past the first tab produced a pack byte-identical to a healthy one.
  //
  // The shell moves focus to <main> after every real navigation, which is right for an ordinary route change
  // and wrong for a tablist whose sections each own a route (the Keys sections, the Notifications areas):
  // there the arrow key IS the navigation, so the shell's move takes focus off the tab the operator just
  // selected and every further arrow does nothing. A screen therefore DECLARES where focus belongs and the
  // shell honours it, and the declaration is ignored unless the named element is connected when the shell
  // reads it, so a stale intent can never park focus on a detached node.
  //
  // THE CONSOLE ALREADY COMPUTED THAT DISCRIMINATION AND THREW IT AWAY: its reader collapsed no intent was
  // declared and the declared element was not mounted into one null, and the second of those two IS the
  // defect. focusOutcome is that fact, kept. It is a STATE row on the tablist population rather than a fault
  // row, for the same reason `none` is a member of degradeCause: without an honoured row the pack cannot say
  // the mechanism was working, and a tablist that is broken and a tablist the customer never touched carry
  // identical evidence.
  //
  // VALUE-FREE like every kind above (I2): the row is three product constants (the kind, the closed
  // focusOutcome, and the compile-time `screen` literal) and two clamped integers. No element, id, label,
  // accessible name, selector or key is recorded, so the row cannot carry anything the operator typed.
  "focus-landing",
] as const;
export type ClientDiagKind = (typeof CLIENT_DIAG_KINDS)[number];

// screen -- the route TEMPLATE id (I3: a compile-time literal, NEVER read from location/history/router
// params at runtime). `boot` is the pre-ready bring-up sentinel; `unknown-route` is the total-mapper
// fallback that never echoes location/pathname/search/hash.
export const CLIENT_DIAG_SCREENS = [
  "overview",
  "destinations",
  "sources",
  "downpipes",
  "restore",
  "access",
  "idp",
  "notifications",
  "integrations",
  "keys",
  "security",
  // config-changes / owner-actions (G217) -- THE TWO APPROVAL INBOXES, PRISED OUT OF THE `security` BUCKET.
  // Both used to fall into it (PATTERN_PREFIXES maps "/config" and "/security" alike), and G217's ticket is
  // verbatim "the config approvals / owner approvals / integrations page never finishes loading". A render throw
  // inside a .then with no .catch is nearly always a TypeError, so the two screens emitted the byte-identical
  // tuple {unhandled, security, other, unhandled-rejection, TypeError} and COALESCED into one row with a bumped
  // count. They are two different screens with two different remedies, and support could not tell which one the
  // customer was looking at. A screen id is a route TEMPLATE and a product constant, so this costs no custody.
  "config-changes", // /config/changes -- the pending config-change approval inbox
  "owner-actions", // /security/owner-actions -- the owner-approval inbox
  "updates",
  "support",
  "settings",
  "boot", // pre-ready bring-up / pre-router crash sentinel
  "unknown-route", // total-function fallback; never echoes location
] as const;
export type ClientDiagScreen = (typeof CLIENT_DIAG_SCREENS)[number];

// httpClass -- engine-call only (5). `aborted` is recorded but EXCLUDED from the
// console-engine-calls-failing signal (a navigation-cancelled/unmount fetch is not a Downpipes fault).
export const CLIENT_DIAG_HTTP_CLASSES = ["4xx", "5xx", "network", "timeout", "aborted"] as const;
export type ClientDiagHttpClass = (typeof CLIENT_DIAG_HTTP_CLASSES)[number];

// faultClass -- a total pure mapper's output (7). The single `other` bucket NEVER touches error text (it is
// a mapped fallback, not a stringified message/name/code/stack).
export const CLIENT_DIAG_FAULT_CLASSES = ["auth", "not-found", "conflict", "rate-limited", "server", "transport", "other"] as const;
export type ClientDiagFaultClass = (typeof CLIENT_DIAG_FAULT_CLASSES)[number];

// driftClass -- class ONLY, never the offending value or the field name (4, review B5). The console records
// that a closed field held an unrecognised value, or that an expected field was absent, and NOTHING about
// which value or which field: those are the exact texts the class stands in for, and they are engine- or
// customer-derived.
export const CLIENT_DIAG_DRIFT_CLASSES = ["unknown-enum", "malformed-body", "missing-field", "version-skew"] as const;
export type ClientDiagDriftClass = (typeof CLIENT_DIAG_DRIFT_CLASSES)[number];

// reasonClass -- bulk-outcome only (6). It classifies HOW a batch ended, never WHICH items failed: an item
// identity (a binding name, a downpipe name) is a customer label and has no field to occupy.
//
// selection-dropped (G284) is not a failure of the batch at all, it is a failure of the batch's INPUT: rows the
// operator had selected VANISHED from under them (a background refresh dropped the selection entries for rows
// that no longer exist, data-table.ts setRows) and the loop then ran over the survivors without saying so. "I
// selected 20 downpipes and only 17 were acted on" produced no evidence anywhere: the loop's own counts are
// self-consistent (17 attempted, 17 done) and the pack agreed with them. The count on this row is HOW MANY
// vanished, and it is recorded only when a bulk action is actually CLICKED after a silent drop, never on the
// legitimate drop that follows a successful bulk delete (the rows are meant to be gone, and the selection is
// cleared, which resets the counter before it can be read).
export const CLIENT_DIAG_REASON_CLASSES = ["partial", "all-failed", "validation", "auth", "server", "selection-dropped"] as const;
export type ClientDiagReasonClass = (typeof CLIENT_DIAG_REASON_CLASSES)[number];

// bulkAction -- bulk-outcome only (6, G284). WHICH bulk operation the row is about. Without it every bulk loop
// in the console coalesced into ONE row: a bulk DELETE that half-failed and a bulk RUN that half-failed are the
// same tuple (kind bulk-outcome, screen downpipes, reasonClass partial) and the first one written wins. "My
// bulk delete half-failed last Tuesday" and "my bulk run half-failed" arrive as one row with a count of two.
// It is chosen by the CALL SITE (each loop knows exactly which operation it is), never derived from the verb
// string the modal renders (that is operator-facing prose and it is not a closed member of anything).
export const CLIENT_DIAG_BULK_ACTIONS = ["create", "run", "disable", "delete", "protect", "drill", "restore-apply"] as const;
export type ClientDiagBulkAction = (typeof CLIENT_DIAG_BULK_ACTIONS)[number];

// applyClass -- apply-outcome only (6). It answers ONE question, the one the ticket asks: how much did this
// live restore apply actually WRITE? The four in-band endings are separated because a support engineer acts
// differently on each, and before this they were not separable at all (a clean apply recorded nothing, and
// "recorded nothing" was also what a restore that never ran looked like):
//
//   wrote-all             the engine applied, reported no failures, and wrote at least one record. The happy
//                         ending, recorded EXPLICITLY so its absence means something.
//   wrote-some            the engine applied, wrote some records and failed others. Half-applied: a retry
//                         must be scoped to the remainder, not re-run whole.
//   wrote-none            the engine applied, reported NO failures, and wrote NO records. SUCCESS WAS
//                         REPORTED AND NOTHING WAS WRITTEN. This is the ending the ticket is really about, and
//                         it was previously indistinguishable from a clean full apply and from no apply at all.
//   wrote-none-all-failed the engine applied, wrote nothing, and every record failed. A total refusal at the
//                         destination, which is a different ticket from the line above.
//   unknown-shape         a 2xx that is not an apply result at all, so the console cannot say what was
//                         written and must not guess.
//   not-sent              the apply POST itself did not come back (transport, timeout, a refusal). Recorded so
//                         the count of apply ATTEMPTS the client made can be lined up against the engine's own
//                         restore-apply audit events: attempts with no matching audit event never arrived.
//
// It is a class, never a number of records and never a record name: the counts belong to the engine's own
// audit event, which is signed, and the record names are customer data.
export const CLIENT_DIAG_APPLY_CLASSES = ["wrote-all", "wrote-some", "wrote-none", "wrote-none-all-failed", "unknown-shape", "not-sent"] as const;
export type ClientDiagApplyClass = (typeof CLIENT_DIAG_APPLY_CLASSES)[number];

// capability -- capability-fault only (4). WHAT the browser would not do. The class is chosen by the CALL
// SITE, which knows exactly which platform capability it asked for; it is never parsed out of an error,
// because the reporter takes no error argument at all.
//
//   blob-download    a Blob + object URL + <a download> click the browser refused. This is the delivery path
//                    for identity.key, the recipient and signer files, the recovery sheet, the custody shares
//                    and the recovery codes: everything the customer must keep to be able to recover.
//   tab-open         a blob-URL tab the browser refused. The printable recovery sheet opens this way.
//   clipboard        navigator.clipboard.writeText refused, or the API is absent in this host.
//   webcrypto-keygen the in-browser key ceremony could not generate a key pair. There is then NO key material
//                    at all, so there is nothing to save and no future backup could ever be recovered. This is
//                    the site both earlier builds left entirely uncovered: the ceremony rendered err.message
//                    into a field__error and reported nothing anywhere.
export const CLIENT_DIAG_CAPABILITIES = ["blob-download", "tab-open", "clipboard", "webcrypto-keygen"] as const;
export type ClientDiagCapability = (typeof CLIENT_DIAG_CAPABILITIES)[number];

// surface -- capability-fault only (5). WHICH CEREMONY asked, and therefore WHAT THE CUSTOMER HAS LOST. This
// is the field that makes the row actionable, and a route id cannot stand in for it, because several of these
// share one route and one of them (the ceremony inside onboarding) is not on the keys route at all:
//
//   key-ceremony         the first, browser-only key ceremony (the keys screen and the onboarding carousel).
//                        A refused download here means identity.key does not exist on the customer's disk, and
//                        identity.key is the ONLY thing that can decrypt their backups.
//   break-glass-rotation a rotation of the break-glass key. The OLD key still works, so the loss is recoverable
//                        and the ticket is a different one. That difference is why this is not `key-ceremony`.
//   recovery-codes       the one-time passkey recovery codes, shown once and never again (and, on the
//                        regenerate path, shown once AFTER the previous set has already been invalidated). A
//                        refusal here plus a later lost passkey is a permanent lock-out.
//   recovery-sheet       the printable public-fingerprint sheet. It holds no secret, so a refusal costs the
//                        customer a record, not their recoverability.
//   integrations-copy    an endpoint copied for a pull vendor. Not recovery material at all: it is here so a
//                        dead clipboard on the integrations screen is TOLD APART from a dead clipboard on the
//                        recovery codes, which was one of the exact coalescings this gap was refuted for.
//   map-diagnostics      the topology map's Copy-view-diagnostics block (G345). The block is the console's own
//                        remote-support affordance, and a clipboard the browser refuses is precisely how it
//                        never reaches support. Its own surface member, so a dead clipboard on the map is told
//                        apart from a dead clipboard on the recovery codes: one costs a diagnosis, the other
//                        costs the customer their recoverability.
export const CLIENT_DIAG_SURFACES = ["key-ceremony", "break-glass-rotation", "add-operational-key", "recovery-codes", "recovery-sheet", "integrations-copy", "map-diagnostics", "restore-receipt"] as const;
export type ClientDiagSurface = (typeof CLIENT_DIAG_SURFACES)[number];

// capabilityOutcome -- capability-fault only (2). WHY the console did not get the capability.
//
//   refused     the capability is present and the browser DECLINED its use: a download policy, a permissions
//               policy, a write outside a user gesture, a keygen that threw. A fault to investigate.
//   unavailable the capability is NOT PRESENT in this host. navigator.clipboard is absent on a plain-http
//               self-host, and WebCrypto is absent outside a secure context. That is a LEGITIMATE
//               configuration, not a console defect, and the customer's remedy is a different one (serve the
//               console over HTTPS, or use the control that does not need the capability). It is recorded,
//               because the operator still did not get the thing they pressed the button for and the pack must
//               say so. It is kept SEPARATE because counting it as a refusal would report a perfectly healthy
//               browser as a broken one, and because the earlier build folded it into `unhandled`, which meant
//               every Copy press on a plain-http host inflated the console-DEFECT counter.
export const CLIENT_DIAG_CAPABILITY_OUTCOMES = ["refused", "unavailable"] as const;
export type ClientDiagCapabilityOutcome = (typeof CLIENT_DIAG_CAPABILITY_OUTCOMES)[number];

// bootClass -- boot-fault only (2, G197). WHICH bring-up step failed. A boot-fault carrying only a faultClass
// says the console did not come up and refuses to say how, and these two failures need completely different
// answers, so folding them together would leave the row unactionable:
//
//   chunk-preload-failed   the update flow could not pre-load this build's own lazy chunks before a
//                          console-including apply. The asset swap then renames the chunks under the RUNNING
//                          session, so a later dynamic import 404s mid-flight and the session breaks in the
//                          middle of the update. The preloader swallows the failure by design (it must never
//                          block the update the operator asked for), which is exactly why it left no trace.
//   nav-bridge-uninstalled a screen asked the navigation bridge to move, sign out or re-resolve identity
//                          BEFORE app.ts installed the real handlers. The bridge's defaults are no-ops, so the
//                          request is swallowed whole: every click does nothing, no error is thrown, and
//                          nothing is written anywhere. A total-silence fault by construction.
export const CLIENT_DIAG_BOOT_CLASSES = ["chunk-preload-failed", "nav-bridge-uninstalled"] as const;
export type ClientDiagBootClass = (typeof CLIENT_DIAG_BOOT_CLASSES)[number];

// buildCheckClass -- console-build-check only (5, G153). What the ORIGIN was serving when the console asked it
// what build it serves (/__build.json, cache: no-store). The reader collapsed all four failures to null, so the
// post-apply check could only ever say "not confirmed":
//
//   confirmed     the origin served the expected version. Recorded EXPLICITLY, so its ABSENCE after an applied
//                 console update means something rather than nothing.
//   wrong-version the origin answered, and kept answering with a DIFFERENT version for the whole bounded poll.
//                 The new assets are not being served (a CDN still holding the old build, an asset deploy that
//                 did not land), while the engine's update record says the console component applied.
//   unreachable   /__build.json did not answer at all (the fetch threw, or a non-2xx).
//   non-json      it answered with something that is not JSON. An Access login page interposed on the console's
//                 own origin looks exactly like this, and it is a different remedy from a stale CDN.
//   unstamped     THE ORIGIN answered valid JSON with no usable version, so the assets it just landed carry no
//                 version stamp.
//   running-unstamped THE RUNNING BUNDLE in this tab carries no baked __CONSOLE_VERSION__ define. A DIFFERENT
//                 FACT ABOUT A DIFFERENT ARTEFACT, and the two used to be one member and therefore one row.
//                 console-version.ts's own header calls them "two distinct questions, deliberately separated"
//                 (what THIS RUNNING CODE is, versus what THE ORIGIN SERVES RIGHT NOW), and the ring re-merged
//                 them: {console-build-check, updates, unstamped} was emitted by the licence screen for an
//                 unstamped RUNNING bundle and by the post-apply check for an unstamped ORIGIN read, they
//                 coalesced on the tuple key, and support could not tell "the update verdict was computed blind
//                 and no apply ever happened" from "an apply landed assets with no stamp". Different remedies.
//                 The running-unstamped fact still matters on its own: with no version to compare,
//                 consoleUpdateAvailable is false however far behind the running console is, so the screen reads
//                 "up to date" two releases late.
export const CLIENT_DIAG_BUILD_CHECK_CLASSES = ["confirmed", "wrong-version", "unreachable", "non-json", "unstamped", "running-unstamped"] as const;
export type ClientDiagBuildCheckClass = (typeof CLIENT_DIAG_BUILD_CHECK_CLASSES)[number];

// rollbackClass -- console-rollback only (6, G153). How the console rollback ended, in the engine's OWN
// outcome vocabulary (StandaloneRollbackResult.outcome) so the client row and the engine's rollback record use
// one language, plus `not-sent` for the case the engine cannot have a record of:
//
//   reverted / reverted-unverified / already / no-target / failed  the engine answered, and this is what it said.
//   not-sent  the rollback POST did not come back (transport, timeout, a refusal). There is then NO engine-side
//             rollback record to compare against, and this row is the only evidence the operator ever tried.
export const CLIENT_DIAG_ROLLBACK_CLASSES = ["reverted", "reverted-unverified", "already", "no-target", "failed", "dry-run", "not-sent"] as const;
export type ClientDiagRollbackClass = (typeof CLIENT_DIAG_ROLLBACK_CLASSES)[number];

// gateBlockClass -- restore-gate-blocked only (4, G198). WHY the console kept Apply disabled on a restore plan
// whose approval the operator believes is in place. Each member is a DIFFERENT ticket and a different remedy,
// and before this they were one indistinguishable "not approved yet" panel:
//
//   plan-hash-failed    restorePlanHash() could not compute the binding key in this browser (WebCrypto absent
//                       outside a secure context, or the digest threw). The client then has NOTHING to match an
//                       approval against, so Apply can NEVER arm however many approvers sign. The screen showed
//                       the ordinary "awaiting approval" copy and the null hash was swallowed.
//   no-caller-identity  the caller has no attributable identity (the bare-token break-glass path carries no
//                       email), so the maker-checker compare has no left-hand side and the gate cannot arm.
//   plan-hash-mismatch  an approval for THIS RUN exists and is approved, and its planHash is NOT the one this
//                       console computed. The approver really did sign, and the console is matching on a
//                       different key: the operator's report ("it is approved and Apply is still greyed out")
//                       is exactly right. This is the fault the ticket describes, and it is invisible today.
//   self-approval       the only approval for this plan is the caller's own. Maker must not be checker, so the
//                       gate is behaving correctly, and the operator (who signed it themselves) cannot see why.
//
// The fifth state, an approval that simply has not been given yet, is NOT a member and is NOT recorded: it is
// the dual-control ceremony working as designed (see the kind's note above).
export const CLIENT_DIAG_GATE_BLOCK_CLASSES = ["plan-hash-failed", "no-caller-identity", "plan-hash-mismatch", "self-approval"] as const;
export type ClientDiagGateBlockClass = (typeof CLIENT_DIAG_GATE_BLOCK_CLASSES)[number];

// fieldClass -- wire-anomaly only (6, G216). WHICH CLASS of engine-supplied field was unusable. It is a class,
// never the field's name and never its value: a malformed URL or a malformed id can carry customer data, and
// the whole point of the row is that the value is not to be trusted.
//
// G298 adds the four field classes the console COARSENS rather than crashes on. Each was a value the console
// could not interpret and then rendered as a plausible-looking verdict, which is worse than an error: an
// unrecognised whoami method was read as the break-glass TOKEN FALLBACK posture (a false claim that the
// customer's security posture is degraded), an unknown downpipe status became "unknown" on the map, an
// unparseable lastRunAt became a "-" beside runs that plainly exist, and a non-finite byte figure became a 0.
export const CLIENT_DIAG_FIELD_CLASSES = [
  "timestamp",
  "count",
  "seal-at",
  "stored-url",
  "b64url-id",
  "run-id-missing",
  "auth-method", // trust-chips: the whoami method this console build does not know (G298)
  "status-enum", // topology/tiles: a downpipe status enum this console build does not know (G298)
  "source-kind", // topology: a source kind this console build cannot draw (G298)
  "bytes", // topology/tiles: a byte figure that was not a finite number (G298)
  "duration", // reports: an RTO/duration in seconds that was not a finite, non-negative number (G298)
  // cadence (G298): the downpipe config's cadenceSeconds, read by the ONE freshness seam (map.ts
  // cadenceSecondsOf) that the map, the downpipes table and the Overview fleet roll-up all go through. It is its
  // own class and not `count`, because of what its coarsening DOES: a cadence this build cannot read is nulled,
  // and a null cadence DISABLES THE STALENESS TEST ALTOGETHER. The downpipe then renders green on the map and
  // "Ok" in the table however old its last good run is, and the pack said nothing at all. It is the false-SAFETY
  // twin of `timestamp`: one is a stamp that cannot be dated, the other is the yardstick it would have been
  // dated against, and support must be able to tell "the engine sent a cadence this console cannot read" from
  // "this backup is genuinely fresh". `missing` (an engine that does not send the field) and `non-finite` (a
  // field that arrived in a shape this build cannot read) are the two anomalies it takes.
  "cadence",
  // The THREE PROTECTION-STATEMENT recency stamps (G303). A generic `timestamp` row cannot close this gap and
  // that is the whole of it: the three stamps make three DIFFERENT claims on the Overview, and a corrupt one
  // reads as a healthy one. `restore-test-at` corrupt means the downpipe says a restore has been tested and the
  // customer believes their recovery is proven; `integrity-verified-at` corrupt means it says integrity-checked;
  // `restore-proven-at` corrupt means it claims offline restorability. As one `timestamp` row they coalesce into
  // a single count on the Overview screen and support cannot say WHICH assurance the customer has lost.
  "restore-test-at",
  "integrity-verified-at",
  "restore-proven-at",
  // blackout-minute (G303): the stored blackout WINDOW bound, in minutes since midnight. minutesToTime CLAMPS an
  // out-of-range engine value into 0..1440, so a corrupt bound renders as a plausible end-of-day time and the
  // operator's next save writes that clamped value back, silently rewriting the customer's own schedule. It is
  // not a timestamp and not a count: it is the one field whose coercion EDITS the customer's configuration.
  "blackout-minute",
  // The LICENCE and ESTATE malformations (G307). Each one silently DISARMS a cue the customer is relying on, and
  // each disarms a different one, so each is its own class: an unparseable notAfter disarms the whole renews-soon
  // machinery ("we never saw a renewal warning before our Enterprise token lapsed"), a band triple that fails the
  // all-or-nothing parse withholds the band line and the over-band nudge on a MIS-MINTED token, a non-finite or
  // negative estate figure withholds the estate size and the over-band check, and an artefactSha384 that is not
  // 96 hex is a build-provenance stamp the console will not show. The malformed VALUE never rides: a corrupt
  // licence field is exactly the value that is not to be trusted.
  "licence-not-after",
  "licence-band",
  "estate-figure",
  "artefact-sha",
  // The DRILL-EVIDENCE stamp (G330). The Overview picks the newest drill evidence by parsing recordedAt, and an
  // entry whose stamp will not parse falls back to the FIRST entry in the list, so the card can quietly show
  // stale evidence as if it were the latest. Its own class, because the remedy is an engine-side data fix and
  // the symptom (a drill date that does not move) is nothing like a corrupt run timestamp.
  "drill-recorded-at",
] as const;
export type ClientDiagFieldClass = (typeof CLIENT_DIAG_FIELD_CLASSES)[number];

// anomaly -- wire-anomaly only (4, G216). HOW the value was wrong: it did not parse, it was not a finite
// number, it was negative where only a count is meaningful, or it was absent where the screen needs it.
//
// The gap proposed a fifth member, `render-threw`, for the seal instant that takes the whole run drawer down
// when it will not convert to a date (one run row opens to nothing while every other row is fine). That site is
// now GUARDED rather than crashing: the drawer renders the rest of the run and states the check honestly as
// absent, and the corrupt instant is recorded as `unparseable`, which is what it actually is. A member that no
// site can emit is dead vocabulary, so it is not in the list.
//
// unknown-enum (G298) is the fifth: the value ARRIVED, it parsed, and it is simply not a member of the closed
// set this console build knows. It is a distinct anomaly from `unparseable` (which is a corrupt value) and from
// `missing` (which is an absent one), and the distinction is the whole ticket: an unknown enum member after an
// engine update is VERSION SKEW and the fix is to update the console, while an unparseable value is corruption
// and the fix is not. The unrecognised member itself never rides: it may be attacker- or corruption-influenced,
// and on the topology it can be a customer-named source kind.
// out-of-range (G303): the value PARSED, is finite and is not negative, and still lies outside the range the
// field is defined over, so the console coerced it to the nearest legal value rather than showing it. None of the
// other members fit a blackout minute of 3000: it is not unparseable, not non-finite and not negative. A clamp is
// a silent edit of the customer's data, and it needed a name of its own.
export const CLIENT_DIAG_ANOMALIES = ["unparseable", "non-finite", "negative", "missing", "unknown-enum", "out-of-range"] as const;
export type ClientDiagAnomaly = (typeof CLIENT_DIAG_ANOMALIES)[number];

// errorClass -- unhandled / boot-fault (10, G217). The JS ERROR CLASS of a fault nobody caught, chosen by SET
// MEMBERSHIP against this frozen list of platform error constructors. This is the "text may SELECT a closed
// member, never pass through" rule: the thrown value's `name` is compared against the list and a non-member
// yields `other`, so a custom error whose name carried a customer value cannot ride. The message and the stack
// are never read at all. It matters because a screen frozen on skeleton rows is nearly always a TypeError
// inside a .then with no .catch, and a row that cannot say even that much is one bucket for every defect the
// console has.
export const CLIENT_DIAG_ERROR_CLASSES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
  "other",
] as const;
export type ClientDiagErrorClass = (typeof CLIENT_DIAG_ERROR_CLASSES)[number];

// faultSource -- unhandled only (2, G217). WHICH CHANNEL the uncaught fault arrived on, which is what tells the
// two customer-visible symptoms apart:
//
//   unhandled-rejection a promise nobody caught. This is the screen that never finishes loading: a render throw
//                       inside a .then with no .catch leaves the skeleton rows up forever and no error on screen.
//   window-error        a synchronous throw nobody caught. The screen is already painted and a control stops
//                       working, which is a different report and a different place to look.
export const CLIENT_DIAG_FAULT_SOURCES = ["unhandled-rejection", "window-error"] as const;
export type ClientDiagFaultSource = (typeof CLIENT_DIAG_FAULT_SOURCES)[number];

// transportClass -- transport-fault only (9, G122/G145/G147/G152). WHAT the transport failure actually WAS, in the
// console's own already-computed classification (lib/errors.ts ErrorKind, resolved by components/error-view.ts
// blockError). Each member is a different ticket with a different remedy:
//
//   access-redirect     an Access login page arrived where engine data was expected. The engine NEVER SAW the
//                       request. The remedy is to re-authenticate at the Access edge. Served as a 200 (the
//                       usual case) this records NOTHING today, so the most common "every screen errors"
//                       report currently produces an empty ring.
//   html-not-engine     a generic web page answered: a wrong engine URL, an engine that is not deployed, or a
//                       proxy or hosting placeholder in front of it. Again the engine never saw the request.
//                       A re-authentication cannot fix an address that is not the engine, and today this is
//                       indistinguishable from an engine that sent a malformed body.
//   origin-rejected     THE CORS FINGERPRINT. The fetch threw with no response AND the unauthenticated health
//                       probe was reachable in the same breath: the engine is up and answering, and does not
//                       allow this console's origin, so the browser blocks the authenticated response. This is
//                       a SETUP STEP (set CONSOLE_ORIGIN), not an outage, and the health-probe divergence is
//                       the only thing that separates the two. It exists solely in the browser: no engine-side
//                       record of a CORS-blocked response can exist, because the response was made and then
//                       discarded by the browser.
//   engine-unreachable  the fetch threw AND health was not reachable either (or was never probed). A genuine
//                       outage or an unreachable address. The honest counterpart to origin-rejected.
//   rate-limited        the engine's own limiter answered 429. Recoverable by pacing, never a server fault.
//   server-error        the engine answered with a 5xx (or another non-2xx that is not one of the above). The
//                       engine DID see the request, so an engine-side trace exists to line this up against.
//   forbidden           a role denial the engine returned on a direct request. Recorded because it means a
//                       client-side capability gate let the operator reach a control the engine then refused,
//                       which is a console defect, not a permissions question.
//   stored-url-invalid  the REMEMBERED engine URL would not construct a client at all (an old non-https origin
//                       a later build rejects). No engine call is ever attempted, so the ring would otherwise
//                       hold nothing whatsoever: the console simply boots to "Not connected" and the operator
//                       reports that every screen is dead. It is a transport fault with no transport.
//   engine-binding-absent (G152) THIS CONSOLE'S OWN DEPLOY HAS NO ENGINE SERVICE BINDING. On the default
//                       single-hostname topology the console worker proxies /admin, /support and /metrics to the
//                       engine over a service binding; a console redeploy that drops the binding used to let
//                       those paths FALL THROUGH to the static assets, so the SPA's own index.html was served at
//                       HTTP 200 where engine JSON was expected. Three different observers were then all told
//                       something false: the console classified its own shell as `html-not-engine`, whose remedy
//                       is "correct the engine URL" and whose URL was correct; a Prometheus scrape of /metrics
//                       got HTML with a 200, so the customer's monitoring reported health while nothing was
//                       being backed up; and the engine, which never received one of these requests, appeared
//                       perfectly healthy in the pack. A CONFIGURATION FAULT IN THE CONSOLE AND AN ENGINE OUTAGE
//                       HAVE COMPLETELY DIFFERENT REMEDIES, and this is the member that separates them. The
//                       worker now answers its own 503 with a frozen code instead of the shell, and this class
//                       is what the browser records when it sees it. It can only ever be produced by this
//                       console's own worker, so it names the console's deploy and nothing about the engine.
//                       THE BOUND ON IT (G152, driven): the ring rides to the engine ONLY on the customer's
//                       Generate action, which POSTs to /admin/support/bundle. That is an ENGINE surface, reached
//                       over the very binding that is missing, so THE PACK CANNOT BE BUILT WHILE THIS FAULT IS
//                       LIVE: the row is recorded if and only if the pack that would carry it is refused. It
//                       reaches a pack in one shape only, a post-mortem, where this tab watched the 503s and the
//                       operator generated the pack after the binding came back without reloading (the ring is
//                       in-memory, so a reload ends the observation). EVERY PACK BEARING THIS CLASS WAS THEREFORE
//                       GENERATED WHILE THE BINDING WAS PRESENT, which is why the bot reads it in the past tense and
//                       never sends anyone to restore a binding whose absence would have stopped the pack
//                       existing. Live, the evidence is not the pack: it is the 503 named on screen with the
//                       right remedy (error-view.ts, and it is what a failed Generate shows), and on /metrics.
//
// TWO ErrorKinds are deliberately NOT members and are deliberately NOT recorded (noise discipline):
//   unauthorised      a 401 is the ordinary lapsed session. It routes to the sign-in screen, which is the flow
//                     working. Recording it would put a transport fault in the pack every time a session
//                     expired, exactly as recording the step-up ceremony's opening 401 fabricated an auth fault
//                     on every SUCCESSFUL step-up.
//   restore-unapproved  an apply awaiting a distinct second approver. That is dual control working as designed.
export const CLIENT_DIAG_TRANSPORT_CLASSES = [
  "access-redirect",
  "html-not-engine",
  "origin-rejected",
  "engine-unreachable",
  "rate-limited",
  "server-error",
  "forbidden",
  "stored-url-invalid",
  "engine-binding-absent",
  // console-origin-fault (G250): THE CONSOLE'S OWN WORKER MANUFACTURED THE 500. Its last-resort handler answers a
  // 500 carrying a frozen header when the dispatch throws, and a BOUND ENGINE service binding whose fetch REJECTS
  // lands there too: the engine worker deleted, throwing on boot, or over its resource limits. The engine never
  // received the request, so it is not `server-error` (which asserts the engine saw the call and refused it, and
  // sends support to refusal logs that hold no trace of it), not `engine-unreachable` (something answered: this
  // console), and not `engine-binding-absent` (the binding is present; the remedy there is the console's wrangler
  // configuration, and here it is the engine's deployment). Admitted by a header equality test against a token
  // this console defines, so nothing a server sent can reach the row.
  "console-origin-fault",
] as const;
export type ClientDiagTransportClass = (typeof CLIENT_DIAG_TRANSPORT_CLASSES)[number];

// callClass -- read-degraded only (6, G122/G123). WHICH swallowed read went quiet. Each one drives a specific
// thing the operator can SEE being wrong, and that is why the class must name the read and not the screen:
//
//   status                the authenticated status read behind the credentials "needs attention" count. It fails
//                         open to the previous chip value, so an expired credential can sit unflagged.
//   setup-state           the guided-setup facts. A failure fails OPEN (no gating), so the wizard's strip
//                         vanishes and Overview can read "nothing is configured" on a configured engine.
//   control-plane-status  the recovery latch. A failure leaves the recovery banner ABSENT, so an engine whose
//                         scheduler control plane has been WIPED (backups silently stopped) shows no banner at
//                         all. This is the read whose silence is most expensive, and the ticket the gap names.
//   update-chip           the update verdict. A failure leaves the chip hidden, so an available update is
//                         invisible and the operator reports being stuck on an old build.
//   passkey-logout        the server-side session teardown on sign-out. It is fire-and-forget by design, so a
//                         failure means the passkey session cookie was NOT cleared server-side: the operator
//                         signed out and the session survived. Nobody is told, on either side.
//
// The gap (G123) proposed a sixth member, `downpipe-count`, for the count the command palette gates its
// downpipe-scoped commands on. There is no such READ: nothing in the console ever populates the registry
// context's `downpipeCount` (shell/registry.ts hasDownpipes reads it, and no producer writes it), so there is
// no request that can fail and nothing to record. A member no site can emit is dead vocabulary that reads like
// coverage, so it is not in the list. The absent producer is a separate defect and belongs in its own change.
// dest-bucket-list / dest-downpipes-list (G240) are the destination form's two ADVISORY reads. Neither
// blocks the form, and that is the problem: a failed account/bucket listing leaves the operator TYPING a
// bucket name into a form that would have offered it, and a failed downpipes read silently disables the
// circular-backup safety check (an archive written into its own source grows without bound). A safety check
// that could not run is not a safety check that passed, and nothing said so.
export const CLIENT_DIAG_CALL_CLASSES = ["status", "setup-state", "control-plane-status", "update-chip", "passkey-logout", "dest-bucket-list", "dest-downpipes-list"] as const;
export type ClientDiagCallClass = (typeof CLIENT_DIAG_CALL_CLASSES)[number];

// obStep -- onboarding-step only (6, G125). WHICH step of the setup wizard. They share one route, so `screen`
// cannot stand in for this.
//
// keys-precheck is a step of its own and NOT part of `install`, and the distinction is the whole point. The
// configure card, resumed with no in-tab key material, does a ONE-SHOT status read to ask "does the engine
// already hold its keys?" (carousel-cards-configure-ready.ts). That read is not an install: nothing is posted
// and no key material exists. Its catch used to write {install, transport-error} unconditionally -- with no
// status check at all, so an engine that ANSWERED 500 or 401 to the probe wrote the row whose own definition
// below says the engine "never saw it, so no engine-side evidence of this can ever exist" -- and it COALESCED
// with the genuine install-POST row from steps.ts. The install row therefore could not be trusted to mean an
// install had been attempted. It has its own step now, and it earns one: when this read fails the wizard tells
// an operator whose engine ALREADY HAS working keys to go back and generate them again, which is the one
// instruction that would destroy them.
export const CLIENT_DIAG_ONBOARDING_STEPS = ["connect", "generate", "install", "keys-precheck", "readiness-poll", "finish"] as const;
export type ClientDiagOnboardingStep = (typeof CLIENT_DIAG_ONBOARDING_STEPS)[number];

// obOutcome -- onboarding-step only (12, G125). HOW the step ended. `ok` is a member and is recorded, so the
// ABSENCE of an ok on a step means the operator never got through it, rather than meaning nothing.
//
// THE RULE THE FOUR POLL ENDINGS ENFORCE, AND THE ONE THIS VOCABULARY BROKE TWICE: A MEMBER WHOSE MEANING
// ASSERTS A FACT MAY ONLY BE WRITTEN WHERE THE CODE ESTABLISHED THAT FACT. `transport-error`, `readiness-unread`
// and `poll-went-quiet` all assert, in as many words, that the engine did not answer. A call site that writes one
// of them for an engine that answered a 500 is not being vague, it is putting a FALSE CLAIM in the pack: the bot
// renders readiness-unread to the support engineer as "fix the engine's reachability first" while forty 500s sit
// in the customer's own logs. Every failed engine call in the wizard therefore goes through engineFaultOutcome
// (steps.ts), which decides answered-and-refused against never-reached from the thrown value's numeric status,
// and the poll's exhaustion legs are split on the SAME axis:
//
//   ok                        the step completed.
//   engine-not-ok             the engine ANSWERED the health probe and reported itself not healthy. It is
//                             reachable, so this is not a connect fault, and the remedy is the engine's logs.
//   transport-error           NO ANSWER FROM THE ENGINE REACHED THE CONSOLE, and the console did not establish
//                             why. The fetch threw, or it timed out, or some other server answered with a web
//                             page where engine JSON was expected. What the code DID establish is the only thing
//                             this member claims: nothing the engine sent was received, so no engine-side record
//                             of the call can be joined to it. It no longer means "an outage", and it must not be
//                             read as one: the two states that used to fall in here and are NOT outages, a lapsed
//                             Cloudflare Access session and a console with no ENGINE binding, have their own
//                             members now (`unauthorised` and `engine-binding-absent`), because in both of them
//                             the engine is up and healthy and this row was sending support to go and revive it.
//   engine-binding-absent     THIS CONSOLE'S OWN DEPLOY HAS NO ENGINE SERVICE BINDING, so the call never left the
//                             console: its own worker answered the engine surface with a 503 carrying a frozen
//                             code (worker.ts), and the transport admits that code by equality. THE ENGINE IS UP
//                             AND HAS RECEIVED NOTHING. The remedy is the console's wrangler configuration, and it
//                             is the console that is redeployed, so this must never be filed under a member that
//                             asserts the engine was unreachable: `transport-error` and the poll's unreachable
//                             legs all did, and the wizard told an operator whose engine is perfectly healthy to
//                             go and fix its reachability. See the transportClass member of the same name.
//
//                             ITS REACH IN A PACK IS BOUNDED, AND THE BOUND IS HONEST (G152). The only vehicle for
//                             a client-diagnostics row is the customer's deliberate Generate action, which POSTs
//                             the ring to /admin/support/bundle on the SAME engine base the wizard was using; when
//                             that base is this console's own bindingless origin, the pack POST meets the same 503
//                             and no pack can be built. So the row rides only where the base later changes or the
//                             binding is restored while the tab lives. It is still written, and it earns its place
//                             on the two counts the pack is not the judge of: it is what stops the wizard writing
//                             a FALSE unreachability row about a healthy engine, and it is what puts the correct
//                             sentence on the operator's screen, which is the sentence they quote to support.
//   health-ok-status-failing  THE ACCESS SIGNATURE. The unauthenticated health probe passed and the
//                             authenticated status read then failed. Health is reachable and authenticated
//                             traffic is not: an Access policy that does not admit this operator, or a
//                             CONSOLE_ORIGIN that does not name this console. The customer's report is health
//                             passes but it keeps kicking me to sign-in, and this is the exact state.
//   unauthorised              the authenticated read returned a clean 401. An ordinary sign-in, not a fault of
//                             the wizard, but recorded HERE (unlike everywhere else) because a 401 at the
//                             CONNECT step is the operator being unable to start at all, and telling it apart
//                             from health-ok-status-failing is the whole diagnosis.
//   access-verdict-unresolved the sign-in verdict line could not be resolved, so the wizard rendered no verdict
//                             and the operator cannot see whether Access is enforced.
//   poll-exhausted            the readiness poll ran to its bound and the engine never reported the keys
//                             present. The customer's it sat on Waiting for two minutes is this, and it is a
//                             pure client-side timer: the engine has no record that anyone waited.
//   ack-failed                the completion acknowledgement did not land, so the wizard finished and the
//                             engine still believes setup is incomplete. The operator reports I finished setup
//                             but Overview still says nothing is configured, which is precisely true.
export const CLIENT_DIAG_ONBOARDING_OUTCOMES = [
  "ok",
  "engine-not-ok",
  "transport-error",
  "health-ok-status-failing",
  "unauthorised",
  "access-verdict-unresolved",
  "poll-exhausted",
  "readiness-unread",
  "readiness-refused",
  "poll-went-quiet",
  "poll-refused",
  "engine-binding-absent",
  // console-origin-fault (G250): the poll's ticks were answered by THIS CONSOLE'S OWN WORKER with a 500 it
  // manufactured, so the engine received none of them. It answers to neither of the two questions the five legs
  // above are the product of (did the poll ever read the engine, how did the final tick end), exactly as the
  // bindingless leg does not, and it is tested beside it. It is NOT `engine-not-ok` (the engine did not answer and
  // refuse: there are no refusals in its logs), NOT the unreachable legs (nothing establishes that the engine is
  // unreachable; the console faulted on the proxied call) and NOT `engine-binding-absent` (the binding is there).
  // The remedy is the engine's deployment or the console's dispatch, and the wizard says so on screen.
  "console-origin-fault",
  "ack-failed",
] as const;
export type ClientDiagOnboardingOutcome = (typeof CLIENT_DIAG_ONBOARDING_OUTCOMES)[number];

// obSecret -- onboarding-step only (3, G125). WHICH KEY THE ENGINE KEPT REPORTING ABSENT when the readiness
// poll ran out. It is the other half of the poll-exhausted split: a `poll-exhausted` row that names no secret
// cannot tell a HALF-KEYED engine (the ceremony wrote the signer and then failed, which router-keys.ts
// documents as a real reachable state: "nothing, or only the secrets named before the failure, was set") from
// an install that never took at all. The poll emits ONE ROW PER SECRET STILL ABSENT at exhaustion, so a
// half-keyed engine writes one row and a wholly unkeyed one writes two or three, and the two are countable
// rather than merely different. Absent on every other step and on `readiness-unread` (which by definition never
// learned what was absent).
//
// The three members are the engine's own key-ceremony secret NAMES, which are product constants: they are the
// same three slots on every engine ever built, they name no customer, and no key material or secret VALUE can
// reach this field (the console never sees one; it reads three booleans off the readiness status).
export const CLIENT_DIAG_ONBOARDING_SECRETS = ["signer", "break-glass", "operational"] as const;
export type ClientDiagOnboardingSecret = (typeof CLIENT_DIAG_ONBOARDING_SECRETS)[number];

// channelReasonClass -- update-channel-unverified only (6, G171). WHY the engine's update-channel verdict came
// back unverified. The engine hands the console `{configured, verified, reason?}`; `reason` is FREE TEXT that
// can embed the channel URL, the signer key id and the platform's own error prose, so it is READ ONLY TO SELECT
// one of these four members and is NEVER carried (classifyChannelReason, classify.ts; the recordRecoveryRefusal
// idiom). A clamp of that reason into the pack would be a leak with a length bound on it, which is not a
// redaction.
//
//   signature   the channel answered and its signature did not verify against the configured signer public key.
//               The customer is silently frozen on whatever release they are on: this is the six-week outage
//               that produces "the console never told us an update was available".
//   unreachable the engine could not reach the channel host at all.
//   malformed   the channel answered and the manifest would not parse or did not match its expected shape.
//   none        the engine reported unverified and gave no reason the classifier recognises. A HONEST fallback
//               that says "unverified, cause unstated", never a guess and never the text.
//
// The two members below are the MISCONFIGURED channel, and they are the reason this row was refuted the first
// time. The emit used to be gated on the engine's `configured` flag, which is the engine's VERDICT and not the
// operator's INTENT: the engine answers configured:false for an unparseable UPDATE_CHANNEL_URL, a non-https one
// and an UPDATE_SIGNER_PUBLIC that will not parse -- three states in which both env vars are set and the
// operator plainly meant to have updates. So a truncated or whitespace-mangled paste of the signer key (a
// base64url blob the operator pastes by hand, and one of the likeliest ways a channel silently freezes) produced
// ZERO rows and a pack byte-identical to a healthy verified channel. The emit is now keyed on channelIntended.
//
//   bad-url        UPDATE_CHANNEL_URL is missing beside a set key, unparseable, or not https.
//   bad-signer-key UPDATE_SIGNER_PUBLIC is missing beside a set URL, or will not parse as a pinned verifier.
//                  A mangled paste. The remedy is a fresh copy of the key, and it is nobody's signature failure.
export const CLIENT_DIAG_CHANNEL_REASON_CLASSES = ["signature", "unreachable", "malformed", "bad-url", "bad-signer-key", "none"] as const;
export type ClientDiagChannelReasonClass = (typeof CLIENT_DIAG_CHANNEL_REASON_CLASSES)[number];

// discoveryOutcome -- discovery-connect only (5, G129). WHAT THE TOKEN SAW. The most common onboarding ticket
// ("Verify and save always fails", "it said verified but nothing shows", "my account shows as empty") is three
// different faults wearing one sentence, and the console renders all three to the DOM and keeps none:
//
//   verified-accounts-seen  the engine took the token and at least one account is visible. The healthy ending,
//                           recorded EXPLICITLY so its absence means something.
//   verified-zero-accounts  the engine took the token and ZERO accounts came back. "It said verified, and no
//                           accounts show." The token is real and its account-read scope is not. Today this is
//                           a toast that says "verified" and then nothing.
//   refused                 the engine refused the token set. Its FAIL CLASS (invalid / scope / CF API / a
//                           verify timeout) is deliberately not guessed from the engine's prose here; the
//                           engine's own discovery state is where that belongs.
//   listing-errors          the account view rendered WITH per-account or per-product listing errors: the token
//                           is good, and its read scopes do not cover everything asked. A SCOPE GAP.
//   listing-empty           the account view rendered with NO listing errors and NO resources across all four
//                           products: the account really is EMPTY. The remedy is the opposite of a scope gap,
//                           and on screen the two are two nearly identical grey hints.
//
// The error STRINGS the screen shows ("Could not list: ...") never travel: they are Cloudflare API prose and
// can name an account, a bucket or a namespace. Only their EXISTENCE, as a class, does.
export const CLIENT_DIAG_DISCOVERY_OUTCOMES = ["verified-accounts-seen", "verified-zero-accounts", "refused", "listing-errors", "listing-empty"] as const;
export type ClientDiagDiscoveryOutcome = (typeof CLIENT_DIAG_DISCOVERY_OUTCOMES)[number];

// claimResult -- claim-exchange only (9, G112). HOW the licence claim-code exchange with the vendor control
// plane ended. The screen collapses all of these into two strings, one of which is actively misleading (a
// control plane that ANSWERED with a 500 is reported to the operator as "could not be reached", which sends
// them to check their own network):
//
//   success           the exchange returned a usable licence token. Recorded so its absence means something.
//   shape-rejected    the operator typed something in the claim field that is NOT a claim code, and the screen
//                     silently fell through to the paste-a-token path without a word. A near-miss code (a
//                     transposed character, a missing group) therefore produces a "paste a token" error, and
//                     the operator is steered to the wrong fix entirely. Recorded ONLY for a NON-EMPTY value:
//                     an empty claim field is the operator legitimately using the token path, and recording
//                     that would fire on every single healthy token activation.
//   not-recognised    the control plane answered 404. The code is genuinely not known to it.
//   http-4xx          the control plane answered with some other 4xx. A malformed request, a rejected origin,
//                     or a route that moved.
//   http-5xx          THE VENDOR OUTAGE. The control plane answered, and answered with a server error. The
//                     customer's network is fine. Today this reads to them as "check your connection".
//   empty-token-200   the control plane answered 200 with NO usable token. A control-plane deploy that changed
//                     the response shape does exactly this, and it looks like an outage to everyone.
//   timeout           the 8-second AbortController fired. Slow, not broken.
//   network-or-cors   the fetch threw. The customer's own network, or a CORS regression at the control plane
//                     (which would hit EVERY customer at once, and which is why it must be separable from the
//                     one customer's flaky wifi that looks identical to them).
//   parse-failure     a response body that would not parse as JSON.
export const CLIENT_DIAG_CLAIM_RESULTS = [
  "success",
  "shape-rejected",
  "not-recognised",
  "band-full",
  "http-4xx",
  "http-5xx",
  "empty-token-200",
  "timeout",
  "network-or-cors",
  "parse-failure",
] as const;
export type ClientDiagClaimResult = (typeof CLIENT_DIAG_CLAIM_RESULTS)[number];

// adminOp -- admin-write only (35, G171/G175/G177/G180). WHICH privileged write the console attempted. Every
// member is a PRODUCT CONSTANT naming an operation, chosen by the call site that makes it. It is never a route
// string, never a target (no email, no credential id, no binding name, no channel URL, no role name): those are
// the customer values the whole record exists to do without, and none of them has a field to travel in.
//
// The grouping is the four gaps this closes:
//
//   update-*        (G171) the safe-apply lifecycle. A PRE-FLOW refusal never reaches the engine's update
//                   record at all, so an apply, ramp, rollback or settle the engine turned away leaves the DO
//                   saying `rollbackNeeded` with no evidence anyone ever tried to act on it. The stage is the
//                   discriminator: "rollback keeps failing" and "settle never completed" are different tickets
//                   on the same screen, and today they are the same row.
//   role-* / group-role-* / custom-role-* / passkey-revoke / terminate-*  (G175) the access-control levers. The
//                   worst of these to reconstruct is terminate-all-sessions during a suspected compromise: the
//                   operator pressed it, saw an error, and nobody can say whether the sessions are dead. This is
//                   one of the ops whose SUCCESS is recorded too (see ADMIN_OPS_RECORDING_SUCCESS), because the
//                   question the ticket asks is exactly "did it apply".
//   recovery-codes-regenerate  (G177) the worst single case in the audit: regenerate errored, and now neither
//                   the old codes nor the new ones work. Its success is recorded for the same reason.
// recovery-codes-confirm  (STAGED-RECOVERY-CODES-CONFIRM-GATE) the save-confirm panel's own
//                   "Continue", fired after a self-add enrolment (most often the forced re-enrolment after a
//                   recovery-code sign-in) staged a fresh set over an existing one. Whether this ever reached
//                   the engine is exactly the fact that decides which set is live: a refused or lost confirm
//                   means the OLD codes are still the working ones, which is safe but invisible without this
//                   row. Its success is recorded too, for the same reason recovery-codes-regenerate's is.
//   approval-policy-set / change-number-policy-set / signin-context-set / posture-*  (G177) the governance
//                   toggles. "I turned dual control on last week" and a pack that says it is off.
//   notify-* / expiry-* / idp-connection-* / credential-*  (G177) the remaining unaudited admin writes.
//   source-attach / source-detach / source-reattach  (G180) the binding safety harness. The owner's stated
//                   number-one fear. An attach and a detach are the SAME POST, so only the call site can tell
//                   them apart, and a refused write emits no sources-attached event: it is invisible today.
export const CLIENT_DIAG_ADMIN_OPS = [
  "update-apply",
  "update-ramp",
  "update-rollback",
  "update-settle",
  "role-set",
  "role-delete",
  "group-role-set",
  "group-role-delete",
  "custom-role-create",
  "custom-role-delete",
  "passkey-revoke",
  "terminate-user-sessions",
  "terminate-other-sessions",
  "terminate-all-sessions",
  "recovery-codes-regenerate",
  "recovery-codes-confirm",
  "break-glass-retire",
  "approval-policy-set",
  "change-number-policy-set",
  "signin-context-set",
  "posture-accept",
  "posture-unaccept",
  "notify-channel-upsert",
  "notify-channel-delete",
  "notify-rule-upsert",
  "notify-rule-delete",
  "expiry-item-set",
  "expiry-item-delete",
  "idp-connection-upsert",
  "idp-connection-delete",
  "idp-connection-toggle",
  // The zero-downtime SAML signing-cert rollover (engine owner action `idp-conn-cert`). It is its own op
  // rather than a shade of the upsert because an operator refused at the rollover needs the row to name the
  // rollover, not the connection edit they never attempted. It was OWED from: this list is a
  // MIRROR of engine/src/admin/client-diag-vocab.ts, the engine checks membership on receipt, and an adminOp
  // the engine's set does not hold fails the record CLOSED at client-diag-receive.ts:220, dropping the WHOLE
  // diagnostic row rather than the one field. So it could not land on this side alone, and it did not: the
  // engine admitted it first, and the frozen count in test/validate-client-diag.ts VOCAB_PAIRS and the two
  // call sites moved with it.
  "idp-connection-cert-rollover",
  "credential-mint",
  "credential-delete",
  "source-attach",
  "source-detach",
  "source-reattach",
  // The DOWNPIPE and DESTINATION ops (G252). They were absent because no console call site named them, and the
  // gap is why they are needed: these are the controls a role gate most often greys out (the Delete button is
  // greyed out for our admin and we do not know why), and a gov-gate row cannot say WHICH control was refused
  // without an op to name it. They are privileged writes in their own right, so they belong in this vocabulary
  // whether or not a gate ever fires on them.
  "downpipe-run",
  "downpipe-edit",
  "downpipe-toggle",
  "downpipe-delete",
  "destination-verify",
  "destination-set-default",
  "destination-upsert",
  "destination-delete",
  // The PUSH / OTLP / RESTORE-APPLY / DISCOVERY ops (G252). Every one of them is change-controlled (each is a
  // requireChange call site), so each is an action a skipped change-number prompt can fall on, and a gov-gate row
  // that cannot name which one is a row that says a governance control misfired somewhere.
  "push-upsert",
  "push-toggle",
  "push-clear",
  "otlp-upsert",
  "otlp-toggle",
  "otlp-clear",
  "restore-apply",
  "discovery-token-set",
  "discovery-token-clear",
  "discovery-accounts-set",
  // The DUAL-CONTROL INBOX ops (G300). They name which owner-action route a refusal fell on, and the two are not
  // interchangeable: reject deliberately does NOT require maker != checker (a proposer may withdraw their own
  // action), so a self-approval refusal is only ever possible on approve, and a not-owner refusal on either.
  "owner-action-approve",
  "owner-action-reject",
  // The OFFBOARDING IdP-CLEANUP ATTESTATION (G305). The operator ticks "I have removed this person in our IdP",
  // the console POSTS that attestation as a SECOND, separately-failable write, and it is the one op where the
  // SUCCESS matters as much as the failure: the ticket is a compliance review asking whether the attestation was
  // recorded at all, so it is in ADMIN_OPS_RECORDING_SUCCESS and an `applied` row proves the control was in force.
  "idp-cleanup-attest",
] as const;
export type ClientDiagAdminOp = (typeof CLIENT_DIAG_ADMIN_OPS)[number];

// ownerActionCode -- owner-action-refusal only (12, G300). WHY a dual-control approve or reject did not go
// through. Every member is established by something the code ACTUALLY TESTED: the SHAPE of the engine's 403 body
// (errors.ts classifyForbiddenBody), the identity whoami resolved, or the console's own re-read of its own inbox.
// The engine's refusal PROSE is never read and never classified.
//
// THE AUTHORITY AXIS IS TESTED BEFORE THE LIFECYCLE, AND THAT ORDER IS THE FIX. The fate used to
// be read off the inbox FIRST, and the inbox listing is CALLER-SCOPED: the engine's canRequesterSeeOwnerAction
// shows an owner every record and shows everyone else only their OWN proposals. A non-owner's re-read therefore
// CANNOT contain somebody else's action, so "gone from the listing" was true BY CONSTRUCTION for them, and a
// plain permissions refusal was filed as `already-decided` -- "a second owner rejected or ran it, go and read the
// audit" -- for an action that was still pending and that nobody had decided. The demoted owner is the live case:
// the inbox repaints only when the (id, status) signature changes, so their card stays on screen and their
// Approve still fires. The fate is now consulted ONLY for a caller whose listing is COMPLETE (an owner).
//
// AND A BARE 403 IS NOT AN AUTHORITY FACT: THE BODY SHAPE DECIDES. "Only an AuthError becomes a
// 403, so a 403 on these routes IS 'you may not approve'" was written here three times and the engine contradicts
// it. FOUR things answer 403 to this one call, three of them are not about the caller's authority at all, and the
// transport discarded the body, so all four arrived as the identical throw and all four were recorded as
// not-owner: the capability gate ({error:forbidden, required, have}), the DO's anti-enumeration AuthError funnel
// (a BARE {error:forbidden}, whose live producer here is the PROPOSER having lost owner), the CSRF-origin check
// (which 403s EVERY cookie-borne save in the console when a deploy drops CONSOLE_ORIGIN), and a Cloudflare WAF
// block page the engine never saw. Three opposite remedies wore one label. The shape gate returns a closed
// ForbiddenClass and the four are four members now.
export const CLIENT_DIAG_OWNER_ACTION_CODES = [
  "self-approval", // the caller is the proposer: maker != checker refuses them, and a second owner is needed
  // not-owner: THE ENGINE'S ROUTE CAPABILITY GATE refused THIS CALLER, and it says so in the one way that names
  // the caller as the one refused: the 403 body carries the `required` capability it wanted and the `have` role
  // the caller holds (engine router-core gate()). It covers the viewer who reached the inbox by deep link and the
  // owner who was DEMOTED with the card still on their screen. It is NOT inferred from the status alone (three
  // other things answer 403 here, and none of them is this) and NOT from the console's role mirror (a
  // mirror-derived not-owner on a 400 would contradict the engine, which had just let that caller through its own
  // owner gate). Neither the capability nor the role is read out of the body: only that `required` is there.
  "not-owner",
  // expired: THE GAP'S HEADLINE TICKET ("I proposed it a fortnight ago and it just vanished; nobody rejected
  // it"). The action's own expiry has passed, so the engine will never carry it out and no rejection was ever
  // made: the proposer must propose it again. It is established from an OWNER'S re-read of the inbox (the engine
  // applies lazy expiry and drops an effective-expired record from the listing) against the record's expiresAt,
  // never from a status: the engine collapses expired, already-decided, bare-token and self-approval into ONE
  // 400, so the status can distinguish nothing here, and a member that claimed it could (the `terminal-state`
  // this replaces, keyed on a 409/404/410 the routes never return) had no producer at all while the ticket it was
  // written for coalesced into the residual.
  "expired",
  // already-decided: a SECOND owner decided the action underneath this operator. Three states reach it and all
  // three have the same remedy (there is nothing to re-propose; go and read who decided it in the audit): the
  // record was REJECTED or EXECUTED (it drops out of the listing before its expiry), or it was APPROVED and is
  // ARMED for the proposer's one-shot re-submit, which the engine STILL LISTS with status "approved". The armed
  // one used to land in the residual, because the fate looked only at presence and expiry and never at the status
  // the engine had just handed back.
  "already-decided",
  // identity-unresolved: the refusal landed while whoami had NOT resolved, so the console holds NO identity to
  // judge the caller by. It is the state that makes self-approval reachable at all (isMineOwnerAction is false on
  // a null caller, so an unresolved operator is offered Approve on their OWN proposal), and it must have its own
  // member rather than being folded into not-owner: with no caller, "not owner" is a fact the code never
  // established, and a row that asserts it sends support hunting a permissions problem that may not exist.
  "identity-unresolved",
  // bare-token: the caller is on the ADMIN_TOKEN break-glass, which has no attributable identity, and dual
  // control refuses it by design (canApproveOwnerAction, reasonCode "bare-token": an approver who cannot be named
  // cannot be the second pair of eyes). The console holds the fact BEFORE it calls (whoami resolved with a null
  // email), and it used to record it as the residual, byte-identical to an owner whose approve the engine turned
  // down for a reason nobody can see. The remedy is specific and it is not "look at the engine": sign in with an
  // attributable identity (Access or a passkey) and approve as that person.
  "bare-token",
  // engine-authz-refused: THE ENGINE'S AUTHORISATION FUNNEL refused, WITHOUT NAMING A CAPABILITY, and that is
  // exactly as much as the console may claim. The DO maps every AuthError to a 403 whose public
  // body is the bare { error: "forbidden" } on purpose (anti-enumeration: a refusal must not enumerate the
  // capability or role a route requires), so it is SHAPE-DISTINCT from the route capability gate above, which
  // names `required`. It must not be filed as not-owner, because on an approve THE CALLER IS NOT NECESSARILY THE
  // ONE REFUSED: the live producer is a PROPOSER who lost owner between propose and approve, which the DO
  // re-resolves when it replays the proposer's action (scheduler-do-dual-control, AUTH-46), and the operator
  // being told "no" is a perfectly good second owner. A not-owner row there sends support to re-grant owner to a
  // person who has it. The remedy is to read WHICH gate refused from the engine's own authz-refusal ledger, which
  // the pack carries (the DO's single AuthError funnel counts the closed gate); a reject by a custom role holding
  // keys.ceremony without being an owner is the other producer.
  "engine-authz-refused",
  // engine-csrf: THE ENGINE'S CSRF CHECK refused, and NOBODY'S AUTHORITY IS IN QUESTION. It pre-empts the route
  // dispatch entirely for every cookie-borne (passkey/oidc/saml) non-GET request, so an engine deployed with
  // CONSOLE_ORIGIN unset 403s EVERY save in the whole console, not merely this approve. Filed as not-owner (which
  // it was) it read as a governance refusal of one owner on one action, and the console-wide outage that actually
  // caused it was invisible: three opposite remedies wore one label. The engine's own auth-signal names the
  // sub-class (csrf-origin-unset = a deploy dropped the variable; csrf-origin-mismatch = a foreign Origin was
  // presented, a security event), so this row plus that signal is a complete diagnosis.
  "engine-csrf",
  // edge-blocked: the 403 carried NO refusal shape this engine emits (an HTML block page, a proxy's plain text,
  // an unrecognised JSON error), so something IN FRONT of the engine refused the call and the engine may never
  // have seen it: a Cloudflare WAF rule (error 1020, and a rate-limit rule whose action is Block answers 403
  // rather than 429), a corporate proxy. The remedy is the customer's own edge, and NOTHING else in the pack can
  // say so -- not even the engine's auth signals, because the engine was never asked. It is the honest residual
  // of the 403 shape gate and is never coerced into one of the engine's own classes.
  "edge-blocked",
  // engine-refused: the engine answered with a refusal status that is not a 403 (the DO maps every non-authz
  // refusal it makes -- expired, already-decided, bare-token, self-approval, a missing record, an integrity
  // failure -- to a 400), the caller is a resolved, attributable owner who is not the proposer, and the action is
  // still live in this owner's own inbox. Every classified refusal above has been excluded, so this is the honest
  // residual and nothing more: its reason is the engine's own and is not read here. It says nothing about WHICH
  // status: a 500 (the DO threw) and a 429 (rate-limited, nothing was decided) reach it too, and the engine-call
  // record beside it carries the distinct faultClass that separates them.
  "engine-refused",
  // answer-unreadable: THE ENGINE ANSWERED 2xx AND THE BODY COULD NOT BE READ. It is NOT unreachable, and that
  // distinction is the whole of this member: on an approve, a 2xx means the engine ACCEPTED the approval and (for
  // a DO-executed kind) ALREADY CARRIED THE ACTION OUT -- the destination is repointed, the connection is gone --
  // and only the reply was mangled (a proxy truncating a body, a middlebox rewriting it). Recording that as
  // `unreachable` ("nothing establishes that any engine saw it, and no engine-side record of it can exist") sends
  // support away from an action that HAS run and IS in the audit chain. The body is inspected locally to see that
  // it is not JSON and is then discarded; only this class rides.
  "answer-unreadable",
  // unreachable: the call got NO answer from an engine. It threw with no status at all, so nothing establishes
  // that any engine saw it, and no engine-side record of it can exist. It covers a dead network, this console's
  // own worker refusing for want of an ENGINE binding, and a web page answering at the engine's address. A lapsed
  // Access session is NOT here and records nothing: it is the ordinary overnight state.
  "unreachable",
] as const;
export type ClientDiagOwnerActionCode = (typeof CLIENT_DIAG_OWNER_ACTION_CODES)[number];

// cspDirective -- csp-violation only (7, G304). WHICH CSP directive blocked the resource, read off the browser's
// own SecurityPolicyViolationEvent.effectiveDirective by SET MEMBERSHIP: a directive name that is not a member
// (a future directive, a browser-specific one) becomes `other` rather than riding as a string.
//
// EVERY MEMBER IS A DIRECTIVE THIS CONSOLE'S OWN POLICY DECLARES (worker.ts buildCsp), and that is the rule that
// decides membership. The producer is the set-membership map itself: cspDirectiveFor emits whichever member the
// browser names, so a directive the policy states is a directive the browser can report and the ring can carry.
// A directive the policy does NOT state is one this console can never be told about by name, and a member for it
// would be coverage-shaped nothing.
//
// `frame-src` was a member and is REMOVED for exactly that reason: buildCsp states default-src, script-src,
// style-src, connect-src, img-src, font-src, form-action, frame-ancestors, base-uri and object-src, and it does
// NOT state frame-src. The console embeds no frames. An injected off-origin frame refused by the default-src
// fallback is still RECORDED -- as `other`, with its cspBlocked class beside it -- which is the honest row: the
// policy that refused it was not a frame-src, and naming one would assert a directive this console never sent.
export const CLIENT_DIAG_CSP_DIRECTIVES = ["script-src", "style-src", "connect-src", "img-src", "font-src", "form-action", "other"] as const;
export type ClientDiagCspDirective = (typeof CLIENT_DIAG_CSP_DIRECTIVES)[number];

// cspBlocked -- csp-violation only (5, G304). WHAT CLASS of resource was blocked, derived from the report's
// blockedURI by comparing it against two frozen browser keywords and against the page's OWN origin. The URI is
// read and DISCARDED: the classifier returns a member of this union and copies nothing, which matters more here
// than anywhere else in the ring, because on an injection attempt the blocked URI is an ATTACKER-CHOSEN STRING
// and it would be riding straight into a sealed bundle a support engineer opens.
export const CLIENT_DIAG_CSP_BLOCKED = [
  "self", // the console's own origin: the stale-hashed-chunk incident, a real asset the policy would not run
  "inline", // an inline script or style: a pre-paint or theme break, or an injected inline payload
  "eval", // eval / new Function / wasm-eval
  "external", // a cross-origin URI: a third-party script, a blocked engine call, an injection attempt
  "other", // the browser reported neither a keyword nor a URI this classifier could place
] as const;
export type ClientDiagCspBlocked = (typeof CLIENT_DIAG_CSP_BLOCKED)[number];

// cspInlineOrigin -- csp-violation only (2, G304). WHICH inline script was blocked: the console's OWN sanctioned
// pre-paint, or something else. It exists because the two states that actually occur under this console's policy
// -- a stale pre-paint hash after a deploy (a BROKEN DEPLOY) and an injected inline payload (a SECURITY INCIDENT)
// -- both report blockedURI "inline" under script-src, and coalesced into one row told apart by nothing.
//
// It is a read of the PAGE'S OWN STATE, never of the report: the sanctioned pre-paint sets a marker when it
// EXECUTES, so an inline violation with the marker ABSENT is the pre-paint itself having been blocked, and one
// with the marker PRESENT is an inline script that is not ours. A boolean the console established for itself,
// not a string an attacker chose.
export const CLIENT_DIAG_CSP_INLINE_ORIGINS = [
  "sanctioned-prepaint", // the marker is absent: the console's own pre-paint script did not run, so IT was blocked. A stale hash, i.e. a broken deploy.
  "unsanctioned", // the marker is present: the pre-paint ran, so the blocked inline payload is not the console's. An injection attempt.
] as const;
export type ClientDiagCspInlineOrigin = (typeof CLIENT_DIAG_CSP_INLINE_ORIGINS)[number];

// deleteFate -- role-delete-impact only (2, G301). WHETHER the delete the count belongs to actually HAPPENED.
// Under change control a custom-role-delete is answered 202 { pending: true } and NOTHING is written: the role
// still exists and nobody was floored. Without this member the queued proposal and the applied deletion are one
// byte-identical row asserting that N people lost access, and a support engineer follows it to the wrong root
// cause -- a pack that is worse than the silence it replaced.
export const CLIENT_DIAG_DELETE_FATES = [
  "applied", // the engine deleted the role. The grants below ARE floored to viewer at their holders' next request.
  "queued-for-approval", // change control deferred it (202). The role STILL EXISTS, nobody is floored, and the count is the blast radius the deletion WOULD have, not one it had.
] as const;
export type ClientDiagDeleteFate = (typeof CLIENT_DIAG_DELETE_FATES)[number];

// dropSurface -- input-dropped only (2, G308). WHICH paste lost part of itself.
export const CLIENT_DIAG_DROP_SURFACES = ["idp-cert-paste", "coverage-inventory-paste"] as const;
export type ClientDiagDropSurface = (typeof CLIENT_DIAG_DROP_SURFACES)[number];

// dropFact -- input-dropped only (2, G308). WHICH of the paste's two numbers this row carries; `count` carries
// the number. Both rows are written together, and both are needed: "one of two certs was dropped" and "one of
// nine was dropped" are the same droppedCount and very different tickets, and the accepted count is the only
// thing that separates them.
export const CLIENT_DIAG_DROP_FACTS = ["accepted", "dropped"] as const;
export type ClientDiagDropFact = (typeof CLIENT_DIAG_DROP_FACTS)[number];

// handoffClass -- handoff-dropped only (3, G310). WHICH hand-off lost its intent between the click and the form,
// and, for the two that end in a broken create, WHETHER THE ENGINE EVER HEARD ABOUT IT.
//
// It held five members, then three, and now holds two. Every removal is the same lesson.
//
// `prefill-zone-unmatched` and `prefill-account-unmatched` went first: they described a deep link that NAMED a
// zone or an account the discovery catalogue no longer returns, and no console screen has ever emitted such a
// link (tokenSourceCreatePath can build one and the editor can parse one, but every in-app route to
// /downpipes/new carries the source TYPE alone). With no producer they were dead vocabulary, and the recorders
// that wore their names were in fact firing on the ordinary multi-zone Add-a-source click, the designed journey.
//
// `wizard-binding-lost` (, R3) went for the same reason, and it hid better. Its recorder existed, it
// read a real null check, and it typechecked. It was still unreachable TWICE OVER: its guard needed
// chosenType = "kv" | "r2" | "d1", and the radio rows write only workers/stream/images/artifacts; and the
// binding-backed kinds do not come down this path AT ALL. They are the CHECKBOX selection, held in
// chosenMulti KEYED BY THE BINDING NAME, so on the one path that has bindings the binding cannot go missing:
// it is the map key. The class survived review because WizType still listed kv/r2/d1 as a leftover, which kept
// the branch alive to the compiler. WizType is now the four radio types and the branch is unrepresentable.
//
// The suite was GREEN on it, which is the part worth remembering: the test called recordHandoffDropped(
// "wizard-binding-lost") directly and asserted the ring gave it back. That proves the RING can carry the class.
// It never proved the PRODUCT can put it there. A pack section that can never be honestly populated is worse
// than an honest absence: it tells a support engineer the evidence was looked for and not found.
//
// `wizard-account-lost` (, R4) went the same way, and it took TWO members to replace it honestly.
//
// It asserted a LOSS BETWEEN THE WIZARD'S STEPS, and the wizard cannot lose an account: each of the four
// discovered-row apply() closures writes the account id in the same block as the binding, and Continue stays
// disabled until a row is picked, so the spec builder is unreachable with a null account from any wizard control.
// The one state that reached it was an INBOUND URL pairing a binding with an account-scoped type and no account,
// where the operator never picked an account and nothing was lost between anything.
//
// And it CONFLATED TWO OPPOSITE TICKETS into one coalesced row. The wizard SENDS the accountless spec (there is a
// real 400 in the customer's engine logs to go and find); the advanced editor REFUSES THE SAVE LOCALLY and makes
// no request at all (there is nothing in any log, anywhere). Same kind, same screen, same class, so they merged
// on the tuple key and the commoner one buried the other. The remedies are different too: validate the inbound
// link, versus give the cf-config create path an account picker. So the class now names WHICH, and a support
// engineer reading the row knows whether the engine ever heard about it.
export const CLIENT_DIAG_HANDOFF_CLASSES = [
  "prefill-type-invalid", // a deep link named a source type this console build does not know
  // wizard-spec-account-absent: the wizard's spec builder reached an account-scoped source (workers, stream,
  // images, artifacts) with no account id, and the spec WAS SENT to the engine, which answers a shape 400 the
  // operator cannot attribute to anything. Its only producer is an inbound deep link that carried a BINDING plus
  // an account-scoped TYPE and named no account: no console screen emits such a link (add-source-success pairs
  // ?binding= only with kv/r2/d1/secrets; every other in-app route to /downpipes/new carries the type alone), so
  // the row names a malformed URL from outside the console, and the engine DID see the request.
  "wizard-spec-account-absent",
  // editor-refused-account-absent: the ADVANCED EDITOR refused the create locally, because the account-scoped
  // source it was asked to save carries no account. NO REQUEST IS MADE, so there is nothing to find in any engine
  // log, and that is the fact this class exists to carry. It is reached from the DESIGNED Add-a-source cf-config
  // link (which names a type and no account) through the wizard's own "Use the advanced editor" control, so it is
  // the commoner of the two by a wide margin, which is exactly why it must not share a row with the one above.
  "editor-refused-account-absent",
] as const;
export type ClientDiagHandoffClass = (typeof CLIENT_DIAG_HANDOFF_CLASSES)[number];

// ceremonyStep -- ceremony-step only (4, G328). WHICH browser-side ceremony step ran. Each is a step whose
// failure costs the customer a different thing: the paper round-trip check is the ONE validity proof on the
// long-term backup (it fails when the printable payload is truncated), the tier-1/2 encrypt is the key file
// itself, the Shamir split is the M-of-N custody design, and the recovery-codes copy is the artefact that is
// shown once and never again.
export const CLIENT_DIAG_CEREMONY_STEPS = ["paper-roundtrip-check", "tier12-encrypt", "shamir-split", "recovery-codes-copy"] as const;
export type ClientDiagCeremonyStep = (typeof CLIENT_DIAG_CEREMONY_STEPS)[number];

// ceremonyOutcome -- ceremony-step only (2, G328). `ok` is recorded as well as `failed`, and it must be: the
// ticket "the recovery codes were never saved" is answered by which of the two rows exists, and a ceremony that
// ran and worked has to be distinguishable from one that was never run.
export const CLIENT_DIAG_CEREMONY_OUTCOMES = ["ok", "failed"] as const;
export type ClientDiagCeremonyOutcome = (typeof CLIENT_DIAG_CEREMONY_OUTCOMES)[number];

// ceremonyFault -- ceremony-step only (5, G328). The COARSE class of what went wrong, chosen from the thrown
// value's CONSTRUCTOR NAME and nothing else (its message can carry a decode offset or a byte count, and both
// are fingerprints of key material). `webcrypto` is a locked-down or non-secure-context SubtleCrypto, `oom` is a
// RangeError out of a large allocation, `decode` is a payload that would not round-trip, `clipboard-denied` is a
// browser that declined the write. On an `ok` outcome there is no fault member at all.
export const CLIENT_DIAG_CEREMONY_FAULTS = ["webcrypto", "oom", "decode", "clipboard-denied", "other"] as const;
export type ClientDiagCeremonyFault = (typeof CLIENT_DIAG_CEREMONY_FAULTS)[number];

// ---- G346: WHERE KEYBOARD FOCUS LANDED ---------------------------------------------------------------------
//
// focusOutcome -- focus-landing only (3). The population is navigations for which a screen DECLARED where
// focus belongs, which is exactly the tablist-owns-a-route population and nothing else; an ordinary route
// change declares nothing and records nothing, so this union never fires on the healthy common path.
//
//   honoured          the declared control was mounted and took focus. THE HEALTHY MEMBER, and the one that
//                     makes the others mean something: without it a tablist that is broken and a tablist the
//                     customer never touched are the same evidence (absence), which is the whole reason this
//                     surface was invisible.
//   dropped-detached  a screen declared where focus belongs and the named element was NOT CONNECTED when the
//                     shell read it, so focus fell back to <main>. THIS IS THE DEFECT, in the pack's own
//                     words: the tab moved, focus did not follow, and every further arrow key does nothing
//                     until the operator re-focuses the tablist by hand. It is the regression sentinel for a
//                     repair whose failure mode is a RACE (the shell's swap-and-focus runs in a later task
//                     than the render that scheduled the declaration, under a view transition), so it can
//                     come back from a change to the transition and never from a change to the tablist.
//   consumed-quiet    a quiet same-screen re-render consumed the declaration without moving focus at all.
//                     The intent is deliberately consumed there so it cannot leak forward onto the NEXT
//                     navigation, and the customer symptom is the same one: the tab did not take focus. Its
//                     own member because the remedy is different (an in-place re-render arriving on top of a
//                     tab activation), and folding it into dropped-detached would send support hunting a
//                     mount race that did not happen.
//
// Value-free by construction: three product constants, none derived from any DOM node, label, accessible name,
// selector, key or customer text.
export const CLIENT_DIAG_FOCUS_OUTCOMES = ["honoured", "dropped-detached", "consumed-quiet"] as const;
export type ClientDiagFocusOutcome = (typeof CLIENT_DIAG_FOCUS_OUTCOMES)[number];

// writeOutcome -- admin-write only (7). HOW the privileged write ended, derived from the NUMERIC HTTP status
// alone (writeOutcomeForStatus in ring.ts) or from the transport rejection. It is deliberately NOT the engine's
// guard identity: last-Owner, last-passkey and owner-escalation all answer 400, and the only thing that
// separates them is the engine's refusal SENTENCE, which this console does not own. The gaps site that
// subdivision engine-side (an adminDenials ring next to the guard that fired), which is where the fail class is
// KNOWN rather than guessed, and this row is its client-side counterpart: the ATTEMPT, which the engine cannot
// record because a refused write leaves it no event to attach one to.
//
//   applied          the engine took the write. Recorded ONLY for the ops in ADMIN_OPS_RECORDING_SUCCESS, where
//                    "did it actually apply" IS the ticket. For every other op a success is already an engine
//                    audit event, and recording it here would only fill the ring's caps with good news and
//                    evict the refusals underneath it.
//   refused-validation  a 400/422 (and any other 4xx that is not one of the below). The engine looked at the
//                    write and turned it down: a shape refusal, or one of its guards.
//   denied-role      a 401/403. A capability gate the console let the operator through and the engine did not,
//                    which is a console defect as much as a permissions answer.
//   conflict         a 404/409/412. The target moved, was already gone, or the precondition had shifted.
//   rate-limited     a 429. Recoverable by pacing, never a fault of the write.
//   server-error     a 5xx. The engine SAW the write, so an engine-side trace exists to line this up against.
//   unreachable      the fetch threw: the engine never saw the write at all, and no engine-side evidence of it
//                    can ever exist. This is the member that makes the client row worth having.
export const CLIENT_DIAG_WRITE_OUTCOMES = [
  "applied",
  "refused-validation",
  "denied-role",
  "conflict",
  "rate-limited",
  "server-error",
  "unreachable",
] as const;
export type ClientDiagWriteOutcome = (typeof CLIENT_DIAG_WRITE_OUTCOMES)[number];

// ADMIN_OPS_RECORDING_SUCCESS -- the ops whose APPLIED outcome is recorded, because for these the question the
// ticket asks is "did it take", and an absent row is then a fact rather than an ambiguity. Every other op
// records only its non-applied endings (noise discipline: a healthy console writes no admin-write row at all,
// so a row in the pack always means something went wrong, and the per-kind cap is never spent on successes).
export const ADMIN_OPS_RECORDING_SUCCESS: ReadonlySet<ClientDiagAdminOp> = new Set<ClientDiagAdminOp>([
  // "Sign out everyone errored; are the sessions actually dead?" is the single worst incident in G175 to
  // reconstruct, and it is answerable only if the applied ending is on the record too.
  "terminate-user-sessions",
  "terminate-other-sessions",
  "terminate-all-sessions",
  // "I regenerated my recovery codes, it errored, and now neither set works." Whether the engine invalidated
  // the old set is ITS fact to record; whether the console ever got a success back is this row.
  "recovery-codes-regenerate",
  // "I set up a new passkey after a recovery sign-in, and now I don't know which codes are mine." Whether
  // the staged set actually went live is ITS fact (the engine's own recovery-codes-generated audit event);
  // whether the console's confirm call ever reached it and got a success back is this row.
  "recovery-codes-confirm",
  // "Rollback keeps failing while a known-bad version is live." A rollback that DID apply, once, changes the
  // whole diagnosis, and a rollback POST that never arrived leaves the engine no record to disagree with.
  "update-rollback",
  // "The console said IdP removal was recorded for a departed employee, but the audit export has no entry." (G305)
  // This is the one op whose whole purpose is to PROVE a control was in force, so an absent `applied` row is the
  // proof's absence, and it is the answer the compliance review is actually asking for. The console used to toast
  // "IdP removal recorded" whether the attestation write landed or not; now the toast tells the truth and the ring
  // carries both endings.
  "idp-cleanup-attest",
]);

// recoveryOp -- recovery-refusal only (4, G196/G214). WHICH disaster-recovery flow was refused. The four share
// one refusal vocabulary and are four different tickets, so the flow is a discriminator in its own right: a
// verification refusal on a break-glass reconcile (the plane is wiped, the operator is holding the ADMIN_TOKEN)
// and the same refusal on a cross-environment estate import (a fresh engine, an Owner session, a signer.pub
// from the recovery kit) send support to completely different places.
//
// estate-import-sealed is the browser-unseal counterpart of estate-import (lib/sealed-export-unseal.ts):
// the console verifies the SEALED wrapper's signature and unseals its body entirely in the browser, then hands
// the recovered plaintext to the same estate-import DO path via POST /control-plane/import-sealed. It is its
// own op, not a re-use of estate-import, because most of ITS refusals (a wrong key, a corrupt capsule or body)
// can only ever be decided in the browser and have no plaintext-import equivalent.
//
// cp-acknowledge (defect 23) is the ACKNOWLEDGE-ONLY latch clear, and it is its own op rather than a re-use of
// cp-restore for the same reason estate-import-sealed is not a re-use of estate-import: the operator standing
// in front of it is a different one. cp-restore is a break-glass holder over a WIPED plane; cp-acknowledge is
// an authenticated owner whose configuration is already back and whose banner will not go down. Folding them
// would put "the rebuild was refused" and "the estate recovered and the console could not say so" in one
// coalesced row, and they send support to opposite places.
export const CLIENT_DIAG_RECOVERY_OPS = ["cp-restore", "cp-restore-sealed", "cp-acknowledge", "estate-import", "estate-import-sealed", "export-download"] as const;
export type ClientDiagRecoveryOp = (typeof CLIENT_DIAG_RECOVERY_OPS)[number];

// recoveryCode -- recovery-refusal only (11, G196/G214). The frozen DP-R refusal codes, MIRRORED from
// lib/recovery-refusal-codes.ts (the validator asserts the two lists are set-equal, so a code added there and
// not here cannot silently fail to reach the pack). They are already stamped into the message the operator
// reads, which is the half of G214 that must survive an engine too dead to build a pack at all; this is the
// other half, so the same token rides in the pack when there IS one.
//
// DP-R01..R06 are decided in the BROWSER and never reach the engine: no engine-side record of them can exist,
// by construction. DP-R10..R14 are the engine's own refusals, keyed to the status it answered with.
//
// DP-R15/R16/R17 SPLIT DP-R12 (G155's sibling refutation, and G196's). DP-R12 was EVERY 400, so the ticket's own
// list -- "wrong token vs signature vs shape vs no-custody vs not-Owner" -- collapsed three of its five states
// into ONE row that coalesced on the tuple key. The console cannot subdivide a 400 by reading the engine's prose
// (the prose can name a bucket or a key, and a classifier over a sentence the console does not own mislabels the
// moment the engine rewords itself), so the ENGINE now returns a CLOSED `refusalClass` member in its 400 body
// and the console admits it BY SET MEMBERSHIP against the frozen list below, mapping it to a code. A body that
// carries no recognised member still lands on DP-R12, which keeps the mapper total and keeps an old engine
// working.
//
//   DP-R15  the signed export's SIGNATURE did not verify (wrong signer, or a tampered artefact)
//   DP-R16  the pasted artefact FAILED THE SHAPE CHECK at the engine (it parsed, it is not an estate export)
//   DP-R17  the NO-CUSTODY GATE refused it: the artefact carries a plaintext secret, and the engine will not
//           take one. The single most misread refusal of the three, because the operator reads it as corruption.
//
// DP-R18/R19 then SPLIT DP-R15 (G202), because a "signature did not verify" is not one state and the remedies
// are opposite. The engine verifies BOTH halves of the hybrid signature over the SAME export bytes, so a failure
// that leaves either half verifying is a proof that the EXPORT IS INTACT and the damage is in the operator's own
// KEY FILE (bit rot, a partially-restored or half-written signer.pub, a partial signer rotation):
//
//   DP-R18  the CLASSICAL half failed and the post-quantum half verified these exact export bytes: the export is
//           INTACT and the Ed25519 half of the kit is damaged. Take another copy of the recovery kit. NOT tamper,
//           and telling this customer their artefact was attacked is the exact inversion the gap exists to stop.
//   DP-R21  the mirror image (the post-quantum half failed): the export is intact and the ML-DSA half of the kit
//           is damaged, or the signer was partially rotated.
//   DP-R19  the .sig blob would not decode: re-copy the SIGNATURE. The export was never checked at all.
//   DP-R20  the key would not import: re-copy the KEY. The export was never checked at all.
//   DP-R15  now means what it says: NEITHER half verified. The wrong key, or an altered export. Tamper lives
//           here, and here alone. One branch, one code: nothing coalesces.
export const CLIENT_DIAG_RECOVERY_CODES = [
  "DP-R01",
  "DP-R02",
  "DP-R03",
  "DP-R04",
  "DP-R05",
  "DP-R06",
  "DP-R10",
  "DP-R11",
  "DP-R12",
  "DP-R13",
  "DP-R14",
  "DP-R15",
  "DP-R16",
  "DP-R17",
  "DP-R18",
  "DP-R19",
  "DP-R20",
  "DP-R21",
  // the browser-unseal-only codes (lib/recovery-refusal-codes.ts carries the full prose). DP-R15/18/19/
  // 20/21 above are now ALSO reachable straight from the browser (the sealed wrapper's signature is verified
  // locally, byte-identical to the engine's own check, before anything is decrypted); these seven are new
  // states with no plaintext-import equivalent, because only a browser holding the private identity can ever
  // observe them.
  "DP-R22",
  "DP-R23",
  "DP-R24",
  "DP-R25",
  "DP-R26",
  "DP-R27",
  "DP-R28",
  // the engine-side twins of DP-R23/DP-R28, reachable only on POST /admin/control-plane/restore-sealed.
  "DP-R29",
  "DP-R30",
  // Defect 23: the acknowledge-only latch clear's three refusals. Mirrored from
  // lib/recovery-refusal-codes.ts, where the reasoning for each lives.
  "DP-R31",
  "DP-R32",
  "DP-R33",
] as const;
export type ClientDiagRecoveryCode = (typeof CLIENT_DIAG_RECOVERY_CODES)[number];

// The record shape (review section 5). Every string field is one of the closed unions above; every numeric
// is a clamped integer. NO other string fields exist. `count` is a coalesce-repeat count (D7: never a
// sequence, index or id). firstMs/lastMs are performance.now() offsets (monotonic), so a rate is computable
// despite the untrusted client clock (D4).
// intentClass -- intent-dropped only (5, G229). WHICH half-filled restore option the request builder threw
// away. Every one of them is a silent downgrade of the operator's intent into a WIDER or DIFFERENT run than
// they asked for: a Max records that did not parse plans the WHOLE run, a cf-config or media token with no
// account beside it drops that whole section out of the restore, a D1 database with no tables plans every
// record instead of the chosen subset, and an empty redirect binding lets an approved apply write back over
// the LIVE original bindings. The typed values are Cloudflare edit tokens and account ids; only the class rides.
export const CLIENT_DIAG_INTENT_CLASSES = [
  "max-records-invalid",
  "cf-pair-partial",
  "media-pair-partial",
  "d1-subset-partial",
  "redirect-binding-empty",
] as const;
export type ClientDiagIntentClass = (typeof CLIENT_DIAG_INTENT_CLASSES)[number];

// probeSurface -- probe-outcome only (5, G238). WHICH operator-initiated test ran. The screen cannot stand in
// for it (the notify and SIEM tests share one screen, and a destination verify fires from two), and the remedy
// is different for every one of them.
export const CLIENT_DIAG_PROBE_SURFACES = ["dest-verify", "idp-test", "notify-test", "push-test", "email-test"] as const;
export type ClientDiagProbeSurface = (typeof CLIENT_DIAG_PROBE_SURFACES)[number];

// probeOutcome -- probe-outcome only (17, G238). HOW the test ended, in ONE union whose members are surface-
// prefixed so a class can never be read against the wrong surface. The members are selected from the RESPONSE
// SHAPE wherever the shape carries the answer (push-test returns a numeric httpStatus; a destination verify
// returns a deleteProbe verdict; an IdP test returns per-check pass/fail lines with the engine's own check
// names), and otherwise by a classifier that READS the engine's reason ONLY to SELECT a member and RETURNS the
// member. No vendor response body, no endpoint, no certificate and no platform message can ride: there is no
// field for one.
//
//   ok                      the test passed. A MEMBER ON PURPOSE. Verify fails every morning and works on
//                           retry is a claim about a RATIO, and a ring holding only failures cannot answer it.
//   probe-refused           the ENGINE turned the test down (a role gate, a step-up, a rate limit). The test
//                           never ran, so nothing was learnt about the vendor: a wholly different ticket from a
//                           test that ran and failed, and the two were previously one red toast.
//   probe-unreachable       the test call itself never came back. Same distinction, other cause.
export const CLIENT_DIAG_PROBE_OUTCOMES = [
  "ok",
  "probe-refused",
  "probe-unreachable",
  "dest-unreachable",
  "dest-auth",
  "dest-write-probe-failed",
  // dest-delete-denied is the WORM/RETENTION POSTURE CASE: the bucket accepts writes and REFUSES deletes, so the
  // destination works and its retention cannot be managed. The engine reports it on the ok:TRUE arm of the verify
  // union (a refused cleanup delete does not fail the probe), which is why destProbeOutcome tests deleteProbe
  // BEFORE ok. Read the other way round, this member has no producer and the state coalesces with a clean verify.
  "dest-delete-denied",
  // dest-region-mismatch: S3 answers a request signed for the wrong region with a 301 PermanentRedirect and the
  // dest layer refuses to follow it. Its own member because it is common and its remedy (set the region to the
  // bucket's) is unlike every other dest member's; in dest-other it was invisible among the unclassified.
  "dest-region-mismatch",
  "dest-other",
  "idp-discovery-failed",
  "idp-jwks-failed",
  "idp-cert-failed",
  "idp-metadata-failed",
  "idp-other",
  "notify-delivery-failed",
  "push-endpoint-4xx",
  "push-endpoint-5xx",
  "push-egress-blocked",
  "push-timeout",
  "push-other",
  "email-platform-refused",
  "email-other",
] as const;
export type ClientDiagProbeOutcome = (typeof CLIENT_DIAG_PROBE_OUTCOMES)[number];

// formField -- form-rejected only (21, G240). The FIELD CATALOGUE control id the console's own validator acted
// on. It is a product vocabulary (the catalogue's own ids), chosen by the call site, and it is emphatically NOT
// the typed value: these fields hold endpoints, bucket names, access keys, role ARNs, account ids and
// contracted rates, every one of which is customer data. The id is what makes the row feed the catalogue's
// divergence detector: a console validator that has drifted TIGHTER than the catalogue shows up as a field that
// is refused in the field and accepted on paper.
export const CLIENT_DIAG_FORM_FIELDS = [
  "binding",
  "namespaceId",
  "bucketName",
  "databaseName",
  "databaseId",
  "storeId",
  "secretName",
  "dest-endpoint",
  // REMOVED: dest-r2-bucket, dest-account-id, dest-s3-bucket, dest-region,
  // dest-access-key and dest-secret. Every one is a real, catalogued control, and NOT ONE of them can ever
  // produce this row.
  //
  // A form-rejected row means THE CONSOLE'S OWN VALIDATOR turned the operator away in the browser. There are
  // exactly three producers: the field() validate funnel, an explicit .refuse(), and a named recordFormRefused
  // call. These six controls carry `required: true` and NO validate, they are never refused, and they are never
  // named -- and the required-and-empty branch records nothing ON PURPOSE, because an operator part-way through
  // a form is the commonest event in the console and recording it would bury every real refusal underneath it.
  //
  // That is not an oversight to be fixed by bolting a validator on. It is the DESIGN: a bucket name, a region,
  // an account id and an access key/secret pair are not decidable in the browser. The ENGINE verifies them, live,
  // against the destination, and its refusal is already carried -- as an engine-call row, which is what it is.
  // A form-rejected member for them would tell a support engineer the browser refused a secret it never inspected.
  //
  // If a client-side rule is ever added to one of these controls, add its member back in the same change: the
  // gate that found this reads the field() definition, so a validate with no member fails just as loudly.
  "dest-worm-days",
  "dest-role-arn",
  "dest-sts-duration",
  "dest-price-storage",
  "dest-price-classa",
  "dest-price-classb",
  "dest-price-egress",
  // The CONSOLE-WIDE funnel (G335). Every control built by components/field.ts runs its validator through ONE
  // function, and a refusal there has never left the browser: "the form will not accept my cron / bucket name /
  // endpoint" and "the split button stays disabled" are the two commonest console tickets there is no evidence
  // for at all. These are the catalogued control ids of every field that HAS a validator to refuse with, so the
  // row can say WHICH control refused. The id is a product constant from the field catalogue; the typed VALUE is
  // never read, and on this family that matters more than most: these fields hold licence tokens, deploy tokens,
  // recovery codes, IdP client ids, SAML certificates and email addresses.
  //
  // A field id NOT in this list is DROPPED at the funnel rather than coerced (formFieldFor), so a control added
  // without a catalogue row produces no evidence rather than the wrong evidence.
  //
  // R2: the first cut of this list was SHORT, and it was short in exactly the places the ticket
  // names. Seventeen controls that have a validator to refuse with were absent, so their refusal was dropped by
  // formFieldFor and support read no row at all -- which reads as "no refusal happened", the one reading that is
  // worse than a blank. The set was rebuilt by taking every field() control that carries a `validate` (or a
  // submit-time console rule) and set-differencing it against this list. The sharpest of them:
  //
  //   dp-bucket        "the form will not accept my bucket name" was answered from add-source and the destination
  //                    form and SILENTLY unanswerable from the downpipe editor, which is where a downpipe's bucket
  //                    override is actually edited.
  //   dp-sched-cron    "the form will not accept my cron" is in the ticket verbatim, and the cron control was not
  //                    on the funnel AT ALL (its refusal was hand-rolled into a bespoke error node). It is on the
  //                    funnel now (editor-schedule-fields.ts passes validateCronExpr as its `validate`).
  //   dp-sched-tz      same: the timezone refusal was written with a direct setError() from the live preview.
  // DELIBERATELY ABSENT, and this is the G246 lesson applied to our own list: idp-var (the IdP preset's dynamic
  // required-variable controls), saml-idp-entity and saml-sp-entity. Every one of them is `required: true` with a
  // validator that only rejects the EMPTY string, so field()'s validate() hits the required-and-empty branch
  // first and returns before the validator ever runs. Their sole possible refusal is therefore the one refusal
  // the funnel deliberately does not record (an operator part-way through a form is not a fault), which means a
  // member for them could never be produced by any code path. A vocabulary member with no producer reads like
  // coverage and is not: it tells a support engineer the evidence was looked for and not found.
  //
  // REMOVED (dead vocabulary,, R3): channel-name, channel-routing-key, demo-reset-token,
  // group-role-group, idp-client-id, idp-label, licence-token, saml-label, update-component-token,
  // update-deploy-token, update-ramp-token, update-rollback-token, update-rollback-token-urgent and
  // update-settle-token -- FOURTEEN members with the pathology the paragraph above describes, shipped in the
  // same list that describes it.
  //
  // Every one has a validator, so the list LOOKED right, and every one of those validators is an emptiness test
  // and nothing more (`(v) => (v.length >= 1 ? null : "Paste the deploy token.")`). Any non-empty string passes.
  // Their sole reachable refusal is the empty one, which the funnel does not record -- so not one of them could
  // ever be emitted. Eight are also `required: true`, so their validator never even runs. The six deploy-token
  // ids are the ones that hid: with no `required` flag they expressed the emptiness rule through the VALIDATOR
  // arm, which is how the exempted state came back in through the recording branch.
  //
  // The row they promised would also have LIED. rejectOutcome `rejected` asserts that the console's validator
  // turned the operator away from THE VALUE THEY TYPED. On an empty field the code examined no value at all, so
  // a support engineer reading `update-rollback-token/rejected` on a 02:00 pack would go and investigate token
  // validation on a rollback that was never attempted, which costs support time rather than saving it.
  //
  // The rule is now STRUCTURAL, not a convention each caller can opt out of by spelling "required" in a
  // validator: components/field.ts records a refusal only when there was a value to refuse, and the dead-vocab
  // gate reads the validator and fails on an emptiness-only one. Give any of these controls a real client-side
  // rule (a shape, a length bound, a range) and its member goes back in the same change set -- the gate will
  // insist on it.
  //
  // REMOVED (dead vocabulary,, R4): pk-recovery-code, terminate-user-email, rule-downpipe and
  // idp-secret. FOUR MORE OF EXACTLY THE SAME THING, left in by the change that made the rule structural, and
  // passed as live by the gate that change added.
  //
  // The first three are the funnel's own: each validator can refuse NOTHING BUT the empty string, so the `v !==
  // ""` guard in field.ts is the one thing standing between them and a row, and none of them carries `required`
  // to reach the other exempted branch either.
  //   pk-recovery-code      (v) => (v === "" ? "Enter a recovery code." : null)         -- ANY non-empty code
  //                         passes; the engine is the authority on a recovery code and answers its own 401.
  //   terminate-user-email  (v) => (v.trim() === "" ? "Enter the member's email." : null) -- no shape check at
  //                         all, and readValue() TRIMS, so even a spaces-only value arrives as "".
  //   rule-downpipe         (v) => (scopeKindField.value() === "downpipe" && v.length === 0 ? ... : null) -- a
  //                         CROSS-FIELD emptiness test, which is still an emptiness test: the validator's only
  //                         use of v is `v.length === 0`, so it cannot tell two non-empty values apart.
  // pk-recovery-code is the sharpest of them: "I cannot sign in with my recovery code" is a 02:00 ticket, and
  // the vocabulary was promising a row for it that no code path could ever write.
  //
  // idp-secret is the refuse() arm of the same rule. Its ONLY producer was secretField.refuse() at the IdP
  // preset's submit, fired on `!isPublic && secretField.value() === ""` -- an EMPTY value, the very state the
  // funnel exempts. The emptiness rule was enforced in the funnel and left open next door, so the exempted state
  // came back in through the other arm. refuse() now records only when there is a value to refuse (field.ts), and
  // the two console rules that fire on an empty box (the confidential-client secret, and the binding a
  // binding-backed source type needs) use setError, which records nothing and claims nothing: they are the
  // required-and-empty state under another name, and the operator is looking straight at the message.
  //
  // The GATE that let all four through was reading the SPELLING of an emptiness test, not its MEANING: three
  // regexes anchored on `v.length >= 1 ? null : "..."`, so `v === ""` (with the space the console actually
  // writes) and a cross-field emptiness test both read as real validators. It now decides by meaning -- a
  // validator whose every use of `v` is an emptiness test cannot refuse the value the operator typed, whatever
  // else it inspects -- and it probes the validator over a set of non-empty strings to confirm it.
  "channel-addresses",
  "channel-url",
  "cost-cadence-custom",
  "cost-churn",
  "cost-dedup",
  "cost-drills",
  // The FOUR CONTRACTED-RATE controls on the COSTS screen (costs/pricing-section.ts, built by priceField). They
  // are not the dest-price-* four: those are the destination form's rates. A customer on a negotiated rate card
  // types into these, and "the cost screen will not take my rate" landed nowhere.
  "cost-price-storage",
  "cost-price-classa",
  "cost-price-classb",
  "cost-price-egress",
  "cost-restores",
  "cost-retention-days",
  "cost-retention-runs",
  "cost-source",
  // The Shamir split pickers (G335, custody-step-panels.ts). Two ids, not one, and that IS the discrimination:
  // "the split button stays disabled" is answered by WHICH picker the ceremony refused, because the share count
  // and the threshold are refused for different reasons and fixed by different edits. N and the threshold
  // themselves never ride: they are the customer's own custody design and a fingerprint of it.
  "custody-split-n",
  "custody-split-threshold",
  "dp-binding",
  "dp-bucket",
  "dp-dbid",
  "dp-name",
  "dp-ns",
  "dp-sched-cron",
  "dp-sched-tz",
  "expiry-date",
  "expiry-label",
  "idp-id",
  "ob-invite-email",
  "otlp-push-endpoint",
  "pk-email",
  "pk-recovery-email",
  "posture-override-reason",
  "push-endpoint",
  "push-s3-endpoint",
  "push-syslog-host",
  "push-syslog-port",
  "role-email",
  "saml-certs",
  "saml-id",
  "saml-idp-sso",
  // The rollover paste box (cert-rollover.ts). NOT saml-certs, which is the connection form's certificate
  // field: a refusal on one is a different ticket from a refusal on the other, and the rollover's is the one
  // that arrives as "the certificate will not save and the provider cuts over on Friday". Its validator
  // refuses a NON-EMPTY paste carrying no BEGIN CERTIFICATE header, so its refusal is a real producer rather
  // than the required-and-empty one the funnel deliberately drops. Landed with the engine, not before it.
  "saml-rollover-certs",
  "update-ramp-pct",
] as const;
export type ClientDiagFormField = (typeof CLIENT_DIAG_FORM_FIELDS)[number];

// rejectOutcome -- form-rejected only (2, G240). The two are NOT the same ticket and must never be one row.
//
//   rejected          the operator SAW the refusal: an error under the field, a blocked save. They know they
//                     are stuck, they are on the phone about it, and the question is whether the console is
//                     right to refuse (a validator tighter than the catalogue refuses a value the engine would
//                     have taken).
//   silently-coerced  the operator saw NOTHING. What they typed was quietly replaced with a default, the save
//                     succeeded, and the estate is now running on a value they did not choose. This is the
//                     member that answers "cost estimates ignore the contracted rate I entered", and it can
//                     never be inferred from an engine-side record, because the engine was sent the DEFAULT and
//                     stored it faithfully.
export const CLIENT_DIAG_REJECT_OUTCOMES = ["rejected", "silently-coerced"] as const;
export type ClientDiagRejectOutcome = (typeof CLIENT_DIAG_REJECT_OUTCOMES)[number];

// catalogueClass -- catalogue-degraded only (20, G243). WHY the Cloudflare-configuration offer was withheld or
// untrustworthy. It records a WITHHELD AFFORDANCE, not a fault: the operator opened the wizard and did not get
// the option, which is the ticket, and the row says which of the four confusable reasons applied.
//
//   cf-catalogue-empty        A DISCOVERY TOKEN IS STORED (tokenPresent true), the engine walked the token path,
//                             and it STILL returned no surface catalogue. That means exactly one thing: this
//                             engine predates the cf-config feature. It is not a token symptom, because on the
//                             token path GET /sources/discover returns `cfConfigSurfaces: cfConfigCatalogue()`
//                             from a STATIC COMPILED-IN list mapped from CF_CONFIG_SURFACES, so a rescoped,
//                             expired or revoked token can never empty it. Remedy: update the engine.
//                             THE tokenPresent GATE IS PART OF THE MEMBER'S MEANING (cfWithheldCatalogueClass).
//                             Account discovery is OPT-IN: with no token the engine returns early with
//                             { bound, tokenPresent:false } and no catalogue at all, and that is the DEFAULT
//                             state of every install that backs up only bound sources. Ungated, this row fired on
//                             every wizard render for those customers and told support to update a healthy,
//                             current engine. With no token, or on an engine too old to report tokenPresent, the
//                             wizard records NOTHING here: the first is a token the owner never pasted (the
//                             screen says so, and the engine files its own no-token discovery observation), the
//                             second is account-tier skew, which token-source-tier already carries.
//   cf-not-added              cf-config was never added as a source on the Sources screen.
//   cf-no-accounts            the catalogue is there and the token could read no account to scope a downpipe to.
//   cf-zones-empty            THE TOKEN READ AT LEAST ONE REAL ACCOUNT AND LISTED NO ZONES UNDER ANY OF THEM, so
//                             per-zone DNS, WAF and zone settings were not offered and cannot be backed up. That
//                             is the WHOLE of what the code establishes, and the member is deliberately named for
//                             it. It is a WITHHELD-CAPABILITY row, not a fault: it answers the ticket ("per-zone
//                             DNS/WAF backup is unavailable") by recording what the operator was not offered.
//                             IT DOES NOT ESTABLISH THE CAUSE, and it must never be read as though it did. Two
//                             states produce it and the console cannot tell them apart, because the engine hands
//                             it the same `zones: []` for both: a discovery token without zone read scope, and an
//                             account that legitimately holds no domains (an ordinary Downpipes customer whose
//                             Cloudflare account is R2, Workers and KV). An earlier note here asserted the first
//                             and prescribed "broaden the token to Read all resources", which on the second is
//                             advice to widen a token that is already correct. Resolve the cause against the
//                             account roster, never off this row alone.
//                             It fires only off accounts the token ACTUALLY READ. The wizard synthesises a
//                             placeholder account from engineAccountId when discovery returned none, and that
//                             placeholder's empty zone list is a HARD-CODED LITERAL no token ever read: a row
//                             emitted from it would assert a zone-scope fact about a token that read no account
//                             at all. That state is cf-no-accounts, and it is left to say so.
//   cf-surface-list-unreadable THE RESIDUAL of the catalogue read (GET /sources/discover), which the wizard makes
//                             on its source step and the editor makes on every cf-config open. The read failed and
//                             the reason is none of the classified ones below, so the operator is picking surfaces
//                             against a list that did not load and support knows only that. THE CONSOLE'S OWN 500
//                             AND ITS MISSING ENGINE BINDING ALSO LAND HERE, exactly as they do on the rediscover
//                             twin: no request reached any engine, so a row naming the engine, the network or the
//                             address would assert what nothing established, and the feature-probe and transport
//                             rows in the same ring name the console-side fault.
//                             It used to be the ONLY member of the read, on a bare `.catch()`: a lapsed Access
//                             session, a 401, an HTML page at the engine's address, the console's own 500, a 403,
//                             a 429 and a dropped connection all wrote this one row, and the first two of those
//                             are states that must write no row at all.
//   cf-surface-list-not-an-engine
//                             a WEB PAGE answered the catalogue read where engine JSON was expected
//                             (HTML_BODY_MARKER): a proxy, a static host or an SPA shell sits at the engine's
//                             address. Something answered, so the network is not at fault, and the remedy is the
//                             ADDRESS. The twin of cf-rediscover-not-an-engine, on the read the editor and the
//                             wizard make rather than the button.
//   cf-surface-list-denied    THE ENGINE ITSELF refused the catalogue read with a 403 whose body is one of its own
//                             refusal shapes (forbiddenClass engine-capability / engine-authz / engine-csrf). The
//                             engine is deployed and healthy at that address and this caller's role may not
//                             discover: a role changed under a long-lived tab, or a console/engine gate
//                             divergence. The remedy is the ROLE, and the address is not in doubt.
//   cf-surface-list-refused-at-edge
//                             a 403 whose body is NOT a refusal this engine emits (forbiddenClass
//                             not-engine-body: a block page, a proxy's plain text). Something refused the read
//                             and it did not speak the engine's refusal language, which is ALL the code
//                             established: the customer's own edge refused the browser in front of a healthy
//                             engine (a WAF rule, or a rate-limit rule whose action is Block), or nothing is
//                             deployed at that address and a foreign host refused. It must not share a row with
//                             cf-surface-list-denied, whose remedy is a role on an engine that answered.
//   cf-surface-list-rate-limited
//                             the catalogue read was rate-limited (429). Nothing is wrong: retry. It must never
//                             share a row with a broken token or a wrong address, which are the rows that send
//                             someone to rotate a token or re-enter an engine URL.
//   cf-surface-list-transport the catalogue read never got an answer at all (no status, no Access login page, no
//                             web page): the engine or the network dropped it. A LAPSED CLOUDFLARE ACCESS SESSION
//                             is deliberately NOT here and records nothing: this console is Access-fenced and
//                             Access answers a lapsed session with its LOGIN PAGE, so the ordinary overnight tab
//                             used to write a fault against a healthy engine and a healthy token, on the very
//                             screen whose remedy is "go and look at your discovery token".
//   cf-never-discovered       a cf-config downpipe whose discovery has NEVER run, so it is capturing EVERY
//                             surface rather than the ones in use. The operator picked auto and believes it is
//                             narrowing; it is not.
//   cf-discovery-all-unavailable
//                             THE HEADLINE STATE OF THIS GAP, and it used to record nothing at all. Rediscover
//                             RETURNED OK and the probe could read NOT ONE SURFACE: present 0, empty 0, and every
//                             surface unavailable. probeCfConfig does not throw on a scope 403 -- it files the
//                             surface as unavailable -- so an expired or rescoped discovery token produces a
//                             SUCCESSFUL rediscover that discovered nothing, the console toasts "Discovered 0
//                             surfaces in use", and "cf-config backups capture nothing new" has no evidence
//                             anywhere. A healthy token on an empty account fills `empty`, not `unavailable`, so
//                             this cannot fire on a legitimately unconfigured account.
//   cf-rediscover-no-token    the rediscover was refused because no discovery token is set: it was CLEARED, or
//                             never pasted. Remedy: paste a token under Sources.
//   cf-rediscover-out-of-scope the downpipe's account is no longer in the owner's selected discovery scope, so the
//                             engine refuses to probe it. Remedy: the OWNER re-selects the account. Nobody but the
//                             owner can fix it, which is why it must not share a row with the token being absent.
//   cf-rediscover-denied      THE ENGINE ITSELF refused the rediscover with a 403 whose body is one of its own
//                             refusal shapes (forbiddenClass engine-capability / engine-authz / engine-csrf)
//                             though the console offered the button: a role that changed under a long-lived tab,
//                             or a console/engine gate divergence. The engine answered, so its address and its
//                             deployment are not in doubt and the remedy is the ROLE.
//   cf-rediscover-refused-at-edge
//                             a 403 on the rediscover whose body is NOT a refusal this engine emits
//                             (forbiddenClass not-engine-body). The same honest residual as
//                             cf-surface-list-refused-at-edge and for the same reason: either the customer's edge
//                             refused the browser in front of a healthy engine, or nothing is deployed at that
//                             address. It used to coalesce into cf-rediscover-denied, which sends support to fix
//                             a role on an engine that may not be there.
//   cf-rediscover-rate-limited the engine's rate limiter refused it (429). Nothing is wrong: retry. It must never
//                             share a row with a broken token, which is the row that sends someone to rotate one.
//   cf-rediscover-not-an-engine
//                             something ANSWERED the rediscover, and it was not the engine: a web page came back
//                             where engine JSON was expected (HTML_BODY_MARKER), so a proxy, a static host or an
//                             SPA shell is sitting at the engine's address. The remedy is the ADDRESS, not the
//                             token and not the network. It used to file as cf-rediscover-transport, which says
//                             the call got NO answer: it got one, from the wrong system.
//   cf-rediscover-transport   the rediscover CALL never got an answer (no status at all, and it was neither an
//                             Access login page nor a web page): the engine or the network dropped it. The stale
//                             surface set stands, and no token is at fault. A LAPSED CLOUDFLARE ACCESS SESSION is
//                             deliberately NOT here and records no row of any kind: this console is Access-fenced
//                             and Access answers a lapsed session with its LOGIN PAGE, not a 401, so the ordinary
//                             overnight tab used to write "the network dropped it" against a perfectly healthy
//                             engine. A fault row for a legitimate state cries wolf.
//   cf-rediscover-failed      the residual refusal: counted, never dropped, never text. The stale surface set
//                             stands and the reason is none of the classified ones above.
export const CLIENT_DIAG_CATALOGUE_CLASSES = [
  "cf-catalogue-empty",
  "cf-not-added",
  "cf-no-accounts",
  "cf-zones-empty",
  "cf-surface-list-unreadable",
  "cf-surface-list-not-an-engine",
  "cf-surface-list-denied",
  "cf-surface-list-refused-at-edge",
  "cf-surface-list-rate-limited",
  "cf-surface-list-transport",
  "cf-never-discovered",
  "cf-discovery-all-unavailable",
  "cf-rediscover-no-token",
  "cf-rediscover-out-of-scope",
  "cf-rediscover-denied",
  "cf-rediscover-refused-at-edge",
  "cf-rediscover-rate-limited",
  "cf-rediscover-not-an-engine",
  "cf-rediscover-transport",
  "cf-rediscover-failed",
] as const;
export type ClientDiagCatalogueClass = (typeof CLIENT_DIAG_CATALOGUE_CLASSES)[number];

// featureClass -- feature-probe only (7, G250). WHICH route family the console could not read and then made a
// judgement about. The screen cannot stand in for it: the security screen makes seven of these reads, so a
// server-5xx row on that screen names none of them, and the whole complaint is that ONE table never loads.
// `custom-roles` WAS a member here and has been REMOVED: no call site in the console ever recorded it, so it was
// dead vocabulary. A pack section that can never be populated is worse than an honest absence, because it tells a
// support engineer the evidence was looked for and not found.
export const CLIENT_DIAG_FEATURE_CLASSES = [
  "roles-table",
  "group-roles",
  "config-approvals",
  "restore-approvals",
  "audit-events",
  "whoami",
  // engine-url is not a ROUTE: it is the address the console would have called one on. It earns a member because
  // a stored engine address that will not parse means NO client was ever constructed and NO call was ever made,
  // so every other row in this ring is silent BY CONSTRUCTION rather than because nothing went wrong. Without it,
  // the most broken console possible produces the emptiest pack.
  "engine-url",
] as const;
export type ClientDiagFeatureClass = (typeof CLIENT_DIAG_FEATURE_CLASSES)[number];

// featureOutcome -- feature-probe only (13, G250). THE VERDICT THE CONSOLE REACHED, which is the field the whole
// kind exists for. Today all of these collapse into one tile that says the feature is pending the engine.
//
//   route-absent            a 404: the engine genuinely does not serve this route. The pending-the-engine tile
//                           is CORRECT here, and only here.
//   not-implemented         a 501: the route exists and declines to do the work.
//   server-error            a 5xx THE ENGINE ITSELF ANSWERED: the engine is BROKEN, it saw the call, its refusal is
//                           in its own logs, and the console told the customer the feature was not built yet. This
//                           is the conflation the gap is about, and it is the common case. IT EXCLUDES THE
//                           CONSOLE'S OWN 500 (below), which used to land here on the bare status and inverted the
//                           member's meaning: an engine that is absent or down, reported as up and refusing.
//   console-origin-fault    a 500 THIS CONSOLE'S OWN WORKER MANUFACTURED, admitted by a frozen header it sets on
//                           its own responses (isConsoleOriginFaultResponse). The console proxies the engine on its
//                           own hostname, and this is what the browser sees when the proxied dispatch throws or the
//                           BOUND ENGINE service binding's fetch REJECTS: the engine worker deleted, throwing on
//                           boot, or over its resource limits. NO REQUEST REACHED ANY ENGINE, so there are no
//                           refusals to read and no engine-side trace of it can exist, which is the exact opposite
//                           of what `server-error` tells support to do. It is not `engine-binding-absent` (there
//                           the binding is missing and the console is what gets redeployed; here the binding is
//                           present and the engine's deployment or the console's dispatch is at fault), and it is
//                           not `network` (something answered: this console did). Unlike the bindingless 503, THE
//                           PACK CAN CARRY THIS ROW LIVE: the pack POST is an engine surface, but a console-origin
//                           fault is per-request and intermittent, so a Generate can succeed while a screen's read
//                           was answered by the console's own 500.
//                           IT HAS A SECOND PRODUCER, and the first fix missed it: the console's own worker is not
//                           the only manufacturer of a 5xx at the console origin. When the worker never runs at
//                           all (over its CPU or memory limits, script gone, an edge fault) Cloudflare answers for
//                           it with its OWN HTML error page, which carries no header of ours. In the PROXIED
//                           topology -- the default, and the one the console declares for itself at
//                           /engine-topology.json -- the engine is a SERVICE BINDING, so an engine answer can
//                           never be HTML: a 5xx with an HTML body did not come from the engine. It is recorded
//                           here, not as `server-error`, for the reason above: nothing established that any engine
//                           saw the call. In the SPLIT topology the console cannot say that (a 5xx HTML page there
//                           is most often Cloudflare's 1101 in front of a real, broken engine), so it stays
//                           `server-error` and this member is not written.
//   forbidden               a 403 THE ENGINE ITSELF REFUSED, established by the SHAPE of the refusal body
//                           (forbiddenClass: engine-capability, engine-authz or engine-csrf, each an equality
//                           test against a token this console defines). The engine is deployed at that address,
//                           it saw the call and it declined it, so the table is empty because of a role or an
//                           origin check, not a defect, and the address is not in doubt. A 403 whose body is NOT
//                           one of the engine's own refusal shapes is `refused-not-by-engine` below, and the
//                           split matters: this member used to carry both, under a note that told support the
//                           remedy was never the engine's address, which is false in exactly the case where the
//                           address IS the fault (a static host or a bucket at the engine's address answering
//                           403 with a web page).
//   refused-not-by-engine   a 403 whose body is NOT a refusal this engine emits (forbiddenClass not-engine-body:
//                           an HTML block page, a proxy's plain text, a JSON error in nobody's vocabulary). What
//                           the code established is exactly that and no more: SOMETHING refused the call and it
//                           did not speak the engine's refusal language. Two states reach it and the row does not
//                           pretend to separate them, because it cannot: the customer's own edge refused the
//                           browser in front of a healthy engine (a WAF rule, or a rate-limit rule whose action
//                           is Block, which answers 403 and not 429), or there is no engine at that address at
//                           all and a foreign host refused. The remedy is therefore an edge rule OR the engine
//                           address, and the pack must not choose for support.
//   rate-limited            a 429.
//   network                 the fetch threw with NO status, was not an Access redirect and was not an HTML body,
//                           and the health probe did NOT answer: the engine is unreachable. The two exclusions
//                           are what make that claim true; without them this member absorbed both of them.
//   not-an-engine           HTML came back where engine JSON was expected, with no Access marker on it: a proxy,
//                           a static host or an SPA shell is answering at the engine's address. The engine is not
//                           unreachable and the remedy is the ADDRESS (or the deployment), not the engine. This
//                           has always been a first-class transport throw (HTML_BODY_MARKER) and it used to be
//                           filed as `network`, which sent support to the wrong system. It reaches this ring on a
//                           NON-2xx as well as a 200 (client-transport failResponse): the commonest wrong-address
//                           shape of all is a static host 404ing an HTML page, and while that was read as a bare
//                           404 it was byte-identical to `route-absent` -- a REAL engine declining a route it
//                           does not serve. Those two have opposite remedies, so they must not share a row.
//                           IT CANNOT FIRE ON A STATUS THE PERIMETER OWNS (401/403/429/5xx, client-transport
//                           failResponse). An HTML body proves a web page answered, never that no engine is
//                           deployed, and the customer's own WAF and rate-limit block pages are HTML on 403 as
//                           often as on 429. Blaming the address for those would be this member's own failure
//                           mode inverted: a healthy engine at a correct address, reported as absent.
//   engine-binding-absent   no request was made to any engine, because THIS console's own Worker has no ENGINE
//                           service binding and answered the call itself (G152). It is a console deploy fault.
//                           It is not `network`, whose member note claims the engine is unreachable: nothing here
//                           establishes anything at all about the engine, and support looking in the engine's
//                           logs for a request that was never sent finds nothing and concludes the pack is wrong.
//   origin-rejected         the fetch threw and the health probe DID answer in the same breath. That pair is the
//                           CORS fingerprint, and it means CONSOLE_ORIGIN is not set on the engine. The console
//                           computes exactly this diagnosis today, shows it, and discards it.
//   engine-url-unparseable  the stored engine address would not parse, so NO client was ever constructed and no
//                           call was ever made. Every other diagnostic in this ring is silent by construction
//                           when this row is present, which is precisely what makes an empty ring readable.
//   other                   a non-2xx in none of the classes above.
export const CLIENT_DIAG_FEATURE_OUTCOMES = [
  "route-absent",
  "not-implemented",
  "server-error",
  "forbidden",
  "refused-not-by-engine",
  "rate-limited",
  "network",
  "not-an-engine",
  "engine-binding-absent",
  "console-origin-fault",
  "origin-rejected",
  "engine-url-unparseable",
  "other",
] as const;
export type ClientDiagFeatureOutcome = (typeof CLIENT_DIAG_FEATURE_OUTCOMES)[number];

// govGate -- gov-gate only (2, G252). WHICH client-side governance gate fired. Both are invisible to the engine
// by construction, and they fail in OPPOSITE directions, which is why they are two members and not one:
//
//   role-gate-refusal-shown             the console GREYED A CONTROL OUT. No request was made, so there is no
//                                       403 and no audit event: an Owner reporting that Delete is disabled has
//                                       nothing anywhere to point at. The row plus adminOp says which control.
//   change-prompt-skipped-policy-read-failed
//                                       the console did NOT ASK for a change number because the policy read
//                                       faulted, and proceeded without one. The engine then refuses the action
//                                       with a 400 and counts it (configIntegrity.changeControlRefusals), so the
//                                       pack today shows a refusal with no explanation. This row is the missing
//                                       half, and the two JOIN: a change-control refusal with one of these
//                                       beside it is a console that never prompted, not an operator who ignored
//                                       the prompt.
export const CLIENT_DIAG_GOV_GATES = ["role-gate-refusal-shown", "change-prompt-skipped-policy-read-failed"] as const;
export type ClientDiagGovGate = (typeof CLIENT_DIAG_GOV_GATES)[number];

// skewClass -- console-skew only (8, G254). THE RUNNING BUNDLE AGAINST WHAT THE ORIGIN SERVES RIGHT NOW.
//
// THIS AXIS REPLACED A FALSE ONE, AND WHY IS WORTH STATING, because it is the trap this whole round keeps
// falling into. The first build compared the console's baked version against the ENGINE's `currentVersion`.
// Those are two INDEPENDENTLY INCREMENTED numbers from two separate repos -- the engine says so itself
// ("the engine knows its own running version, but it CANNOT know the console's") -- so on a perfectly healthy,
// correctly-built, matched pair (console 0.1.10, engine 0.1.9) the comparison returned "console-ahead", which
// the vocabulary defined as "every route the console calls 404s". EVERY PACK FROM EVERY HEALTHY CUSTOMER would
// have carried a fabricated fault, and a genuinely STALE console (behind its own release) would have been
// reported as AHEAD -- sending support to hunt the engine when the remedy was a reload. A row that asserts a
// fact the code never established costs support time rather than saving it.
//
// The comparison below is one the BROWSER ALONE CAN MAKE and the engine cannot: what version is THIS TAB
// RUNNING (the baked __CONSOLE_VERSION__ define) against what version does THE SAME ORIGIN SERVE THIS INSTANT
// (/__build.json, cache: no-store). Both numbers come from the same repo and the same release, so a difference
// is a real fact about the customer's browser, not an artefact of two version lines. WHICH console build is
// running is answered separately and directly by `consoleBuild` on the payload envelope (a product constant
// beside the engine's version in the pack), so this member set does not have to smuggle a number.
//
//   served-matches-running   the tab is running exactly what the origin serves. A member on purpose: recorded,
//                            so that its ABSENCE from a pack is itself the finding.
//   served-newer-than-running THE STALE TAB, and the gap's headline ticket ("the console update says it did not
//                            take effect", the dead Approve button, the feature that is silently off). The origin
//                            has the new bundle and this browser is still executing the old one: reload / purge.
//   served-older-than-running the origin is serving an OLDER bundle than the one this tab loaded: an asset deploy
//                            was rolled back, or an edge is still holding a previous release. Opposite remedy.
//   served-version-differs   both sides are stamped and unequal, and the pair will not compare as dotted
//                            integers (a hash-stamped or pre-release build). The direction is NOT knowable, and
//                            claiming one would be the very invention this member exists to refuse.
//   origin-unreachable       /__build.json did not answer. The console cannot confirm its own served build at all.
//   origin-not-json          something answered /__build.json that was not JSON. An Access login page interposed
//                            on the CONSOLE'S OWN origin looks exactly like this, and it is not a stale asset.
//   origin-unstamped         the descriptor answered and carries no version, so the origin cannot say what it is
//                            serving.
//   running-unstamped        THIS bundle carries no version stamp, which blinds every check above it: the console
//                            can read "up to date" while it is releases behind.
export const CLIENT_DIAG_SKEW_CLASSES = [
  "served-matches-running",
  "served-newer-than-running",
  "served-older-than-running",
  "served-version-differs",
  "origin-unreachable",
  "origin-not-json",
  "origin-unstamped",
  "running-unstamped",
] as const;
export type ClientDiagSkewClass = (typeof CLIENT_DIAG_SKEW_CLASSES)[number];

// materialClass -- material-rejected only (5, G256). WHY the console refused a piece of key or ceremony
// material. Chosen at the reject branch, which knows the reason exactly; never inferred from a message.
//
//   bad-length       the encoded length is 1 mod 4, which no valid base64url-no-pad encoding ever produces: a
//                    truncated or over-long paste (a share cut short by a line wrap, or two shares run together)
//   non-alphabet     a character outside A-Z a-z 0-9 - _ : most often '+' or '/' from a STANDARD-base64 tool, or
//                    a stray space from a copy that took the surrounding whitespace with it
//   padding-present  a '=' : the material was produced by a standard-base64 encoder, not this product's
//                    base64url-no-pad. The single most fixable rejection and the one the operator can never
//                    diagnose from "that does not look right"
//   non-ascii        a byte above U+007F: a smart quote, an en dash or a non-breaking space, which is what an
//                    email client or a word processor does to a pasted share. The operator sees an identical
//                    string to the one they were sent and cannot see why it is refused
//   ceremony-shape   a stored ceremony result read back from the store did not match the expected shape and was
//                    thrown away, so the console asks the operator to run the entire key ceremony AGAIN. This is
//                    the "the console forgot my key ceremony" ticket, and it left no trace of any kind
export const CLIENT_DIAG_MATERIAL_CLASSES = ["bad-length", "non-alphabet", "padding-present", "non-ascii", "ceremony-shape"] as const;
export type ClientDiagMaterialClass = (typeof CLIENT_DIAG_MATERIAL_CLASSES)[number];

// contractClass -- contract-skew only (6, G261/G289). HOW the engine's payload broke the contract the console
// was compiled against. A closed product classifier: it is decided by the console's own guard (an Array.isArray
// that failed, a set lookup that missed, an `?? []` that fired), never read out of any engine text.
export const CLIENT_DIAG_CONTRACT_CLASSES = [
  "unknown-enum-member", // a value arrived and it is not a member of the closed set this console build knows
  "missing-field", // a field the console requires was absent, and the console defaulted it to a plausible value
  "wrong-shape", // a field arrived with the wrong TYPE (an array field that was not an array) and was coerced
  "empty-payload", // the field arrived, well-formed, and carried nothing where the screen needs something
  "legacy-path-taken", // the console detected an older engine and took its compatibility branch
  "watch-timeout-drift", // a client-side watch ceiling expired while the engine still had the operation in flight
] as const;
export type ClientDiagContractClass = (typeof CLIENT_DIAG_CONTRACT_CLASSES)[number];

// fieldFamily -- contract-skew only (16, G261/G289). WHICH family of data broke. A closed PRODUCT vocabulary of
// field families, and deliberately not the field NAME and never the field VALUE: an unrecognised id can be an
// operator-named IdP preset or a customer's own label, and a field name is a wire detail that would drift.
export const CLIENT_DIAG_FIELD_FAMILIES = [
  "idp-preset", // the IdP provider key behind a tile (unknown key renders the neutral globe)
  "idp-connections", // the connections array on the IdP screen (absent renders every tile as an empty add-a-provider tile)
  // `vendor-mark` WAS A MEMBER HERE AND IS DELETED (G289). Its only producer (integrations/marks.ts) was guarded
  // on a CONSOLE-SIDE CONSTANT: every caller of integrationMark passes a mark key off CATALOGUE, a constant in
  // this repo, and all 40 catalogue keys resolve, so no engine of any version could ever satisfy the guard. It
  // was coverage-shaped nothing: the family promised support a contract-drift signal about a value THE ENGINE
  // NEVER SENDS, and its absence from a pack read as "the integrations vocabulary is in sync" when nothing could
  // ever have said otherwise. Every family below is fed by a value that arrived on the wire.
  "notify-event", // a notification event id the label table does not know
  "source-type", // a source-type id the cost table's label map does not know
  "surface-screen", // a landing-screen id the roles builder does not know
  "status-fields", // the security status payload (a dropped field silently removes a control)
  "policy-fields", // the approval-policy payload (a dropped field silently removes an option)
  "posture-checks", // the posture report's checks array, well-formed and empty
  "role-grants", // the config snapshot's role-grant list, counted as 0 when it was not an array
  "snapshot-counts", // any other config-snapshot count field that was not an array and was counted as 0
  "change-kind", // a config-change kind the approve-capability mirror does not know
  "change-description", // a config change with no description for the approver to read
  "action-summary", // an owner action with no summary for the operator to read
  "flight-watch", // the canary flight watch: the client ceiling expired with the run still in flight
  "added-sources", // the added-sources roster, absent on an older engine (the compatibility branch)
  // downpipe-config: ONE ROW inside a perfectly good downpipe list whose config the console
  // cannot read (no config object, no source, or a source with no type word). It is a family of its own and
  // NOT `downpipe-list`, because the two are different faults with different remedies and the pack must not
  // coalesce them: `downpipe-list` is the whole read settling ok with no array, an engine-console contract
  // break on the call, healed by a retry or a version match. This is a single malformed roster record inside
  // a healthy response, which the engine itself names (roster-hygiene: "MALFORMED: dp:X holds a value with no
  // readable string config.id at all") and heals with the roster clean-up, and which no retry will ever fix.
  // Until this member existed the row was not merely unrecorded: it THREW, escaped an async load with no
  // catch, and left the Overview frozen on its first-load skeleton, so the pack's evidence for it was one
  // `unhandled` row with faultSource unhandled-rejection and nothing at all about which downpipe or why.
  "downpipe-config",
  // The CONSOLE/ENGINE VOCABULARY SKEW families (G302). Each is a place the console SILENTLY NORMALISES a value
  // an engine of a different version handed it, and each normalisation is a DIFFERENT symptom the customer
  // reports: a capability the console does not know is STRIPPED from a custom role's resolved set, so a
  // custom-role holder loses buttons (and a tampered role record trying to smuggle a capability looks exactly the
  // same, which is why the fact is worth recording at all); an unknown landing id falls back to Overview, so an
  // executive lands on the wrong screen; an unknown owner-action kind renders its RAW id in the inbox; and an
  // engine that advertises no token-source capability at all makes those source types vanish from Add a source.
  // `surface-screen` already covers the surface-map half (an unknown screen id in a custom role's surface, which
  // renders read-only rather than hidden).
  //
  // The unrecognised STRING never rides, and on this family that is not a formality: a corrupt or tampered custom
  // role could carry anything at all in its capability list, and it is the one input here an attacker chooses.
  "role-capability", // a capability id the console's closed set does not know, stripped from a custom role
  "landing-screen", // a landing-screen id the router does not know, defaulted to Overview
  "owner-action-kind", // an owner-action kind the inbox has no label for, rendered as its raw id
  // The TOKEN-SOURCE CAPABILITY families, one per capability. They replace the single
  // `token-source-flags` member, which fired only when the engine advertised NOT ONE capability and was
  // therefore blind to the state that actually happens.
  //
  // The four capability flags landed on four different dates, so every engine build in between advertises a
  // strict SUBSET of them, and a subset is not zero. An engine offering cf-config but not Workers produced no
  // row at all and read in the pack exactly like a healthy, current engine -- and a subset build is precisely
  // what an engine ROLLBACK lands on, so the one state the gap is named for ("our Workers source disappeared
  // after the update") was the one state that recorded nothing. Meanwhile the only state that DID record was a
  // two-day slice of engine history. Per-capability families make the SET of rows the evidence, and because
  // fieldFamily is part of the ring's tuple key they do not coalesce.
  //
  // Each is a different symptom with a different blast radius: the customer whose Workers source vanished and
  // the customer whose Stream source vanished lose different backups and file different tickets.
  "token-source-tier", // the response carried NO tokenPresent field: an engine older than the account tier itself
  "token-source-cf-config", // a discovery token is present and the engine advertised no cf-config surface catalogue
  "token-source-workers", // ... and no Workers capability, so the Workers source vanishes from Add a source
  "token-source-stream", // ... and no Stream capability
  "token-source-images", // ... and no Images capability
  // The OVERVIEW CONTRACT-BREAK families (G330). A partial engine payload that settles ok:true is masked by a
  // defensive default at every one of these sites, and the mask is indistinguishable from an ordinary absence:
  // a paying customer's licence tile reads "Community / Fail-open" off a payload that never carried a tier, the
  // cost card never projects because the run rows carried no byte fields, and the coverage grid reads all-unknown
  // off a downpipe list that was not an array. Every one of those is an ENGINE-CONSOLE CONTRACT BREAK, which is a
  // defect signal, and today it looks exactly like a quiet estate.
  "licence-payload", // the licence status settled ok with no tier/valid on it, defaulted to community/fail-open
  "downpipe-list", // the downpipe list settled ok and was absent or not an array, read as an honest unknown
  "run-cost-fields", // run rows carried no finite archiveBytesWritten/segmentsWritten, so no cost is projected
  // The INVITE-CAPABILITY family (G340). A committed role grant that came back with no invite token AND no
  // inviteState is an engine that predates the registration-invite mint: the new member is authorised, has no
  // way to enrol a passkey, and the console silently fell back to the "they are emailed if invites are
  // configured" toast. An engine that DOES carry inviteState says "already-enrolled" for an existing member,
  // which is the legitimate no-link case and records nothing. Without this family the two are one silence.
  "invite-state",
  // The AUDIT FORWARD-COMPAT families (G344). The audit table renders "unrecognised target (newer engine?)",
  // "unknown method" and raw internal field names when the engine has moved ahead of the console, and today
  // those fallbacks exist only on the operator's screen. Three families, not one: an unknown target kind, an
  // unknown auth method and an unlabelled target field are three different pieces of engine vocabulary the
  // console has not caught up with, and the fix (which console version to deploy) is proved by joining any of
  // them to the pack's consoleBuild and engine.version. The unrecognised STRING never rides.
  "audit-target",
  "audit-method",
  "audit-field-name",
] as const;
export type ClientDiagFieldFamily = (typeof CLIENT_DIAG_FIELD_FAMILIES)[number];

// ---- G336: the BLOCKED BROWSER STORE ----------------------------------------------------------------------
//
// storageArea -- storage-blocked only (2). WHICH store the browser refused. They are not interchangeable: a
// blocked localStorage loses the operator's PREFERENCES and the engine URL (every refresh re-points the
// console); a blocked sessionStorage loses their in-progress WORK (the wizard draft). One ticket says "it keeps
// forgetting my engine", the other says "it keeps losing my half-filled form", and the browser policies that
// cause them are set independently.
export const CLIENT_DIAG_STORAGE_AREAS = ["local", "session"] as const;
export type ClientDiagStorageArea = (typeof CLIENT_DIAG_STORAGE_AREAS)[number];

// storageOp -- storage-blocked only (3). WHICH operation the store refused. A store that READS but will not
// WRITE (a quota wall, a write-blocking policy) behaves completely differently from one that refuses even to be
// touched, and only the write half loses the operator's work.
export const CLIENT_DIAG_STORAGE_OPS = ["read", "write", "remove"] as const;
export type ClientDiagStorageOp = (typeof CLIENT_DIAG_STORAGE_OPS)[number];

// storageClass -- storage-blocked only (4). WHY the store refused, and the four are four different remedies:
//
//   denied          the host THREW on access: a third-party-cookie/storage policy, a locked-down enterprise
//                   profile, a private window with storage partitioned off. The remedy is a browser policy
//                   change, and it is the state the whole gap is about.
//   quota-exceeded  the store is writable and FULL. The remedy is to clear site data, and nothing about the
//                   customer's browser policy is wrong. Folding this into `denied` would send support chasing
//                   a group policy that does not exist.
//   unavailable     the API is not present in this host at all (an old embedded browser, a hardened runtime).
//   other           a throw the classifier could not place. It exists so the classifier is TOTAL and never has
//                   to guess: a fault it cannot name is named as unnamed, not as the nearest member.
//
// The classifier READS the exception only to SELECT one of these members, and returns the member. The message,
// the name and the stack are discarded at that boundary and enter no field.
export const CLIENT_DIAG_STORAGE_CLASSES = ["denied", "quota-exceeded", "unavailable", "other"] as const;
export type ClientDiagStorageClass = (typeof CLIENT_DIAG_STORAGE_CLASSES)[number];

// storageSurface -- storage-blocked only (7). WHAT THE CUSTOMER LOST, which is the half of the ticket the area
// and the class cannot answer. The gap's own scenario names three symptoms in one breath (lost wizards, an
// engine URL that will not stick, an auto-refresh that re-enables itself against a motion pause) and they are
// three surfaces, so they are three rows. The draft ID is never recorded: a draft id can carry a run id.
export const CLIENT_DIAG_STORAGE_SURFACES = [
  "draft", // an in-progress wizard/selection draft (sessionStorage): the operator's WORK
  "engine-url", // the connected engine URL (localStorage): the console re-asks for it on every refresh
  "theme", // the theme preference
  "motion-pref", // the rain/motion preference: an accessibility setting that will not stick is not cosmetic
  "refresh-pref", // the auto-refresh pause: it re-enables itself against a motion-sensitivity pause
  "view-mode", // the list/grid view mode
  "setup-state", // the onboarding wizard's progress: the operator is walked back to step one
] as const;
export type ClientDiagStorageSurface = (typeof CLIENT_DIAG_STORAGE_SURFACES)[number];

// ---- G345: the TOPOLOGY MAP's RENDERER --------------------------------------------------------------------
//
// rendererMode -- renderer-degraded only (2). WHICH renderer was live. The console picks canvas2d when the
// browser gives it a 2d context and falls back to a static SVG topology when it does not; the fallback is the
// "the map is just a static diagram" ticket.
export const CLIENT_DIAG_RENDERER_MODES = ["canvas2d", "svg-fallback"] as const;
export type ClientDiagRendererMode = (typeof CLIENT_DIAG_RENDERER_MODES)[number];

// degradeCause -- renderer-degraded only (5). WHY the live view was not what it should be. Every member is a
// different answer down the phone, and `none` is the member that makes the others mean anything:
//
//   canvas-blocked   the browser refused a 2d context (graphics acceleration off, an extension blocking
//                    canvas). The map is the SVG fallback. The remedy is a browser setting.
//   raf-frozen       requestAnimationFrame never ticked within the freeze guard: an extension (or a throttled
//                    background tab policy) has frozen the animation loop. The map is canvas2d and DEAD, which
//                    reads to the customer exactly like a hung console.
//   css-anim-frozen  the page's CSS animations do not advance: the same class of extension, one layer up.
//   reduced-motion   a SINGLE STATIC FRAME because the operator asked for reduced motion (or the OS did). A
//                    LEGITIMATE state, recorded so support can say "this is your accessibility setting, not a
//                    fault", and never counted as a browser fault.
//   unobserved       THE MAP MOUNTED IN A DOCUMENT THAT WAS NOT VISIBLE, so the animation-loop reading means
//                    nothing and was NOT taken. A hidden document SUSPENDS requestAnimationFrame
//                    while setTimeout keeps running, so the freeze guard fires and a perfectly healthy browser
//                    reads as raf-frozen. The map's first load is not gated on visibility (only the poll cadence
//                    is), so an ordinary restored tab, a deep link opened in the background, a cmd-tab mid-load or
//                    a minimised window all mounted the map unobserved -- and every one of them filed the gap's
//                    OWN headline fault, coalescing with the real extension-frozen loop into one row. A support
//                    engineer then gave browser advice to a customer whose browser was fine. This member is that
//                    state, told apart, and it is the reason raf-frozen can now be believed.
//   none             the live view was running. Recorded so the pack can say the renderer WAS healthy: without
//                    it, a frozen map and a map the customer never opened carry identical evidence.
export const CLIENT_DIAG_DEGRADE_CAUSES = ["canvas-blocked", "raf-frozen", "css-anim-frozen", "reduced-motion", "unobserved", "none"] as const;
export type ClientDiagDegradeCause = (typeof CLIENT_DIAG_DEGRADE_CAUSES)[number];

// drillAbort -- fleet-drill only (3, G287). HOW the fleet-drill session ended. `none` is a member on purpose: a
// session that ran to completion must be TELLABLE from one that was cut short, and a ring that recorded only the
// bad endings would leave a clean partial drill and an aborted one carrying the identical evidence.
export const CLIENT_DIAG_DRILL_ABORTS = [
  "none", // the loop ran over every target it had
  "signed-out", // a 401 mid-loop routed to signed-out: the remaining targets were NEVER attempted
  "fleet-read-failed", // the history read that builds the target list failed, so not one drill was attempted
] as const;
export type ClientDiagDrillAbort = (typeof CLIENT_DIAG_DRILL_ABORTS)[number];

// drillFact -- fleet-drill only (5, G287). WHICH of the session's counts this row carries; `count` carries the
// number. Rows of a repeated drill coalesce on the tuple, so the counts SUM across the session, and an aborted
// session's counts never sum into a clean one's (drillAbort is in the tuple).
export const CLIENT_DIAG_DRILL_FACTS = [
  "targeted", // how many downpipes the loop set out to drill
  "passed", // how many drills the engine answered ok
  "failed", // how many drills the engine answered not-ok, or threw non-recoverably
  "deferred", // how many drills the engine honestly refused for break-glass-only posture (not a failure)
  "skipped-no-run-id", // how many downpipes were dropped from the target list for having no latest runId
  "rate-limit-exhausted", // how many drills failed only after exhausting the capped 429 retries
] as const;
export type ClientDiagDrillFact = (typeof CLIENT_DIAG_DRILL_FACTS)[number];

export interface ClientDiagnosticRecord {
  kind: ClientDiagKind;
  screen: ClientDiagScreen;
  httpClass?: ClientDiagHttpClass; // engine-call only
  faultClass?: ClientDiagFaultClass; // engine-call / unhandled / boot-fault
  driftClass?: ClientDiagDriftClass; // contract-drift only
  reasonClass?: ClientDiagReasonClass; // bulk-outcome only
  applyClass?: ClientDiagApplyClass; // apply-outcome only
  capability?: ClientDiagCapability; // capability-fault only
  surface?: ClientDiagSurface; // capability-fault only
  capabilityOutcome?: ClientDiagCapabilityOutcome; // capability-fault only
  bootClass?: ClientDiagBootClass; // boot-fault only (G197)
  buildCheckClass?: ClientDiagBuildCheckClass; // console-build-check only (G153)
  rollbackClass?: ClientDiagRollbackClass; // console-rollback only (G153)
  gateBlockClass?: ClientDiagGateBlockClass; // restore-gate-blocked only (G198)
  fieldClass?: ClientDiagFieldClass; // wire-anomaly only (G216)
  anomaly?: ClientDiagAnomaly; // wire-anomaly only (G216)
  errorClass?: ClientDiagErrorClass; // unhandled / boot-fault (G217)
  faultSource?: ClientDiagFaultSource; // unhandled only (G217)
  transportClass?: ClientDiagTransportClass; // transport-fault only (G122/G145/G147)
  callClass?: ClientDiagCallClass; // read-degraded only (G122/G123)
  obStep?: ClientDiagOnboardingStep; // onboarding-step only (G125)
  obOutcome?: ClientDiagOnboardingOutcome; // onboarding-step only (G125)
  obSecret?: ClientDiagOnboardingSecret; // onboarding-step / poll-exhausted only (G125)
  channelReasonClass?: ClientDiagChannelReasonClass; // update-channel-unverified only (G171)
  discoveryOutcome?: ClientDiagDiscoveryOutcome; // discovery-connect only (G129)
  claimResult?: ClientDiagClaimResult; // claim-exchange only (G112)
  adminOp?: ClientDiagAdminOp; // admin-write only (G171/G175/G177/G180)
  writeOutcome?: ClientDiagWriteOutcome; // admin-write only (G171/G175/G177/G180)
  recoveryOp?: ClientDiagRecoveryOp; // recovery-refusal only (G196/G214)
  recoveryCode?: ClientDiagRecoveryCode; // recovery-refusal only (G196/G214)
  intentClass?: ClientDiagIntentClass; // intent-dropped only (G229)
  probeSurface?: ClientDiagProbeSurface; // probe-outcome only (G238)
  probeOutcome?: ClientDiagProbeOutcome; // probe-outcome only (G238)
  formField?: ClientDiagFormField; // form-rejected only (G240)
  rejectOutcome?: ClientDiagRejectOutcome; // form-rejected only (G240)
  catalogueClass?: ClientDiagCatalogueClass; // catalogue-degraded only (G243)
  featureClass?: ClientDiagFeatureClass; // feature-probe only (G250)
  featureOutcome?: ClientDiagFeatureOutcome; // feature-probe only (G250)
  govGate?: ClientDiagGovGate; // gov-gate only (G252)
  skewClass?: ClientDiagSkewClass; // console-skew only (G254)
  bulkAction?: ClientDiagBulkAction; // bulk-outcome only (G284)
  materialClass?: ClientDiagMaterialClass; // material-rejected only (G256)
  contractClass?: ClientDiagContractClass; // contract-skew only (G261/G289)
  fieldFamily?: ClientDiagFieldFamily; // contract-skew only (G261/G289)
  drillAbort?: ClientDiagDrillAbort; // fleet-drill only (G287)
  drillFact?: ClientDiagDrillFact; // fleet-drill only (G287)
  ownerActionCode?: ClientDiagOwnerActionCode; // owner-action-refusal only (G300)
  cspDirective?: ClientDiagCspDirective; // csp-violation only (G304)
  cspBlocked?: ClientDiagCspBlocked; // csp-violation only (G304)
  cspInlineOrigin?: ClientDiagCspInlineOrigin; // csp-violation only, and only when cspBlocked is "inline" (G304)
  deleteFate?: ClientDiagDeleteFate; // role-delete-impact only (G301)
  dropSurface?: ClientDiagDropSurface; // input-dropped only (G308)
  dropFact?: ClientDiagDropFact; // input-dropped only (G308)
  handoffClass?: ClientDiagHandoffClass; // handoff-dropped only (G310)
  ceremonyStep?: ClientDiagCeremonyStep; // ceremony-step only (G328)
  ceremonyOutcome?: ClientDiagCeremonyOutcome; // ceremony-step only (G328)
  ceremonyFault?: ClientDiagCeremonyFault; // ceremony-step only (G328)
  storageArea?: ClientDiagStorageArea; // storage-blocked only (G336)
  storageOp?: ClientDiagStorageOp; // storage-blocked only (G336)
  storageClass?: ClientDiagStorageClass; // storage-blocked only (G336)
  storageSurface?: ClientDiagStorageSurface; // storage-blocked only (G336)
  rendererMode?: ClientDiagRendererMode; // renderer-degraded only (G345)
  degradeCause?: ClientDiagDegradeCause; // renderer-degraded only (G345)
  focusOutcome?: ClientDiagFocusOutcome; // focus-landing only (G346)
  count: number; // coalesce-repeat only; clamped non-negative int, cap COUNT_MAX
  firstMs: number; // performance.now offset (monotonic), clamped int
  lastMs: number; // performance.now offset (monotonic), clamped int
}

// The POST body the console sends to the engine at pack generation (request-scoped, I1). It carries the
// ring and the value-free attempt denominator, and NOTHING else. The engine stamps source/receivedAt
// itself (I4 CLIENT-ASSERTED PROVENANCE), so the console never asserts a time or a provenance.
export interface ClientDiagnosticsPayload {
  records: ClientDiagnosticRecord[];
  engineAttempts?: number;
  // consoleBuild (G344): WHICH CONSOLE BUILD the customer is actually running. The pack has always carried
  // engine.version and NOTHING that identifies the browser's console, so "your audit table shows 'unrecognised
  // target (newer engine?)'" could never be answered with "deploy console X": the console's own version was not
  // in the pack at any point.
  //
  // THIS IS NOT A CLAMPED STRING, and the distinction is the whole no-custody argument. It is the value of the
  // build-time `__CONSOLE_VERSION__` define (package.json `version`), a PRODUCT CONSTANT that is chosen by the
  // release, not by the customer, and it is admitted by a SHAPE GATE (CONSOLE_BUILD_RE) that a version can
  // satisfy and a URL, an error message, an account id or a bucket name cannot. A value that fails the gate is
  // DROPPED whole, never truncated into the field: a clamp bounds the length of a leak, not its content.
  consoleBuild?: string;
}

// CONSOLE_BUILD_RE is the shape gate on consoleBuild: a bare semantic version with an optional short
// pre-release tag, anchored at both ends. It admits "0.1.9" and "1.2.0-rc1"; it cannot admit a message, a
// path, an endpoint, an email or an id, because none of them is this shape. The engine applies the SAME gate
// again on receipt (the console is not the authority on what may enter a signed bundle).
export const CONSOLE_BUILD_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[a-z0-9.]{1,16})?$/;

// Set-membership allowlists, one per closed union (mirroring the engine's own six). ReadonlySet<string> so
// an arbitrary string can be tested with .has() before it is admitted as a union member. The ring validates
// its OWN writes against these (belt and braces with the type system) so no non-member string can ever enter
// a record, and the engine re-validates every one of them again on receipt.
export const CLIENT_DIAG_KIND_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_KINDS);
export const CLIENT_DIAG_SCREEN_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_SCREENS);
export const CLIENT_DIAG_HTTP_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_HTTP_CLASSES);
export const CLIENT_DIAG_FAULT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FAULT_CLASSES);
export const CLIENT_DIAG_DRIFT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DRIFT_CLASSES);
export const CLIENT_DIAG_REASON_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_REASON_CLASSES);
export const CLIENT_DIAG_APPLY_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_APPLY_CLASSES);
export const CLIENT_DIAG_CAPABILITY_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CAPABILITIES);
export const CLIENT_DIAG_SURFACE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_SURFACES);
export const CLIENT_DIAG_CAPABILITY_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CAPABILITY_OUTCOMES);
export const CLIENT_DIAG_BOOT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_BOOT_CLASSES);
export const CLIENT_DIAG_BUILD_CHECK_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_BUILD_CHECK_CLASSES);
export const CLIENT_DIAG_ROLLBACK_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ROLLBACK_CLASSES);
export const CLIENT_DIAG_GATE_BLOCK_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_GATE_BLOCK_CLASSES);
export const CLIENT_DIAG_FIELD_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FIELD_CLASSES);
export const CLIENT_DIAG_ANOMALY_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ANOMALIES);
export const CLIENT_DIAG_ERROR_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ERROR_CLASSES);
export const CLIENT_DIAG_FAULT_SOURCE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FAULT_SOURCES);
export const CLIENT_DIAG_TRANSPORT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_TRANSPORT_CLASSES);
export const CLIENT_DIAG_CALL_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CALL_CLASSES);
export const CLIENT_DIAG_ONBOARDING_STEP_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ONBOARDING_STEPS);
export const CLIENT_DIAG_ONBOARDING_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ONBOARDING_OUTCOMES);
export const CLIENT_DIAG_ONBOARDING_SECRET_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ONBOARDING_SECRETS);
export const CLIENT_DIAG_CHANNEL_REASON_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CHANNEL_REASON_CLASSES);
export const CLIENT_DIAG_DISCOVERY_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DISCOVERY_OUTCOMES);
export const CLIENT_DIAG_CLAIM_RESULT_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CLAIM_RESULTS);
export const CLIENT_DIAG_ADMIN_OP_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_ADMIN_OPS);
export const CLIENT_DIAG_WRITE_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_WRITE_OUTCOMES);
export const CLIENT_DIAG_RECOVERY_OP_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_RECOVERY_OPS);
export const CLIENT_DIAG_RECOVERY_CODE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_RECOVERY_CODES);
export const CLIENT_DIAG_INTENT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_INTENT_CLASSES);
export const CLIENT_DIAG_PROBE_SURFACE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_PROBE_SURFACES);
export const CLIENT_DIAG_PROBE_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_PROBE_OUTCOMES);
export const CLIENT_DIAG_FORM_FIELD_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FORM_FIELDS);
export const CLIENT_DIAG_REJECT_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_REJECT_OUTCOMES);
export const CLIENT_DIAG_CATALOGUE_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CATALOGUE_CLASSES);
export const CLIENT_DIAG_FEATURE_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FEATURE_CLASSES);
export const CLIENT_DIAG_FEATURE_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FEATURE_OUTCOMES);
export const CLIENT_DIAG_GOV_GATE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_GOV_GATES);
export const CLIENT_DIAG_SKEW_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_SKEW_CLASSES);
export const CLIENT_DIAG_BULK_ACTION_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_BULK_ACTIONS);
export const CLIENT_DIAG_MATERIAL_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_MATERIAL_CLASSES);
export const CLIENT_DIAG_CONTRACT_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CONTRACT_CLASSES);
export const CLIENT_DIAG_FIELD_FAMILY_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FIELD_FAMILIES);
export const CLIENT_DIAG_DRILL_ABORT_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DRILL_ABORTS);
export const CLIENT_DIAG_DRILL_FACT_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DRILL_FACTS);
export const CLIENT_DIAG_OWNER_ACTION_CODE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_OWNER_ACTION_CODES);
export const CLIENT_DIAG_CSP_DIRECTIVE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CSP_DIRECTIVES);
export const CLIENT_DIAG_CSP_BLOCKED_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CSP_BLOCKED);
export const CLIENT_DIAG_CSP_INLINE_ORIGIN_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CSP_INLINE_ORIGINS);
export const CLIENT_DIAG_DELETE_FATE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DELETE_FATES);
export const CLIENT_DIAG_DROP_SURFACE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DROP_SURFACES);
export const CLIENT_DIAG_DROP_FACT_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DROP_FACTS);
export const CLIENT_DIAG_HANDOFF_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_HANDOFF_CLASSES);
export const CLIENT_DIAG_CEREMONY_STEP_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CEREMONY_STEPS);
export const CLIENT_DIAG_CEREMONY_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CEREMONY_OUTCOMES);
export const CLIENT_DIAG_CEREMONY_FAULT_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_CEREMONY_FAULTS);
export const CLIENT_DIAG_STORAGE_AREA_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_STORAGE_AREAS);
export const CLIENT_DIAG_STORAGE_OP_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_STORAGE_OPS);
export const CLIENT_DIAG_STORAGE_CLASS_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_STORAGE_CLASSES);
export const CLIENT_DIAG_STORAGE_SURFACE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_STORAGE_SURFACES);
export const CLIENT_DIAG_RENDERER_MODE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_RENDERER_MODES);
export const CLIENT_DIAG_DEGRADE_CAUSE_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_DEGRADE_CAUSES);
export const CLIENT_DIAG_FOCUS_OUTCOME_SET: ReadonlySet<string> = new Set(CLIENT_DIAG_FOCUS_OUTCOMES);

// Caps (D3), mirrored from the engine. PER_KIND_ROW_CAP newest-wins per kind; GLOBAL_ROW_CAP across all
// kinds; COUNT_MAX bounds each coalesce count; MS_MAX bounds a performance.now offset (about 24.8 days, so
// ordering survives a long session); MAX_BODY_BYTES bounds the POST body (the engine rejects a larger body
// with a 400 BEFORE it parses, so the console must not exceed it). The worst-case section at these caps is
// about 128 rows by about 100 bytes, roughly 13 KB, in line with the existing pack sections.
export const CLIENT_DIAG_PER_KIND_ROW_CAP = 32;
export const CLIENT_DIAG_GLOBAL_ROW_CAP = 128;
export const CLIENT_DIAG_COUNT_MAX = 1_000_000;
export const CLIENT_DIAG_MS_MAX = 2_147_483_647;
export const CLIENT_DIAG_MAX_BODY_BYTES = 32_768;
