// Paint-before-leave gate (npm run lint:paint-before-leave, chained into npm run lint).
//
// THE DEFECT CLASS. A handler puts the UI into a BUSY state (a disabled button reading "Saving…", a
// region seeded with a synchronous "Checking…" placeholder, a spinner line, aria-busy="true") and then
// leaves on some path WITHOUT taking the UI back out of it. The operator is left on a placeholder that
// will never be replaced: no error, no control, nothing to report. That is worse than an error card,
// because an error card at least names a state and offers a way on.
//
// The instance this gate is built from is /restore's "Confirm and apply" step, which can freeze on
// "Checking whether this plan has an approval from a distinct approver". renderConfirm seeds that host
// synchronously and startApprovalGate replaces it asynchronously; every path through the lookup paints
// except one, an unauthorised catch that calls goSignedOut() and returns.
//
// WHY goSignedOut() IS NOT A PAINT. It looks like one: it reaches app.ts's routeToSignIn, which navigates,
// and lib/router.ts's navigate() always re-resolves, so the screen is rebuilt. Two things break that
// reasoning, and both are in this repo rather than in theory.
//
//   1. The nav bridge is a NO-OP until app.ts installs it (src/lib/nav.ts). Before installNav runs, every
//      accessor resolves to the empty default: goSignedOut() returns cleanly and nothing happens. The
//      console records a boot-fault class for exactly that state, "nav-bridge-uninstalled", because a
//      no-op default is the quietest fault here. On that path a 401 branch that only calls goSignedOut()
//      freezes with certainty.
//   2. Calling goSignedOut() on the way out is not sufficient by itself: a branch that does exactly that
//      and nothing else can still leave the busy state exactly where it was.
//
// A toast is not a paint either. It is transient, it sits away from the control, and it leaves a button
// reading "Saving…" that will read "Saving…" until the tab is reloaded.
//
// So the rule is PAINT FIRST, THEN LEAVE. Departing is allowed and is usually right, but it comes after
// the local state has been resolved, not instead of it.
//
// WHAT THIS GATE CHECKS. For every busy-set in src/**.ts it identifies the TOKEN put into the busy state
// (the button, the host) and the function that owns it, then walks the control flow FROM that busy-set to
// every way the function can complete. Each `return`, and falling off the end, must have RELEASED the
// token on that path: re-enable it, restore its label, replace the host's children, clear aria-busy, call
// the region's repaint, dismiss the overlay, or paint something else the operator can see. A `finally`
// that releases covers every path at once and is the idiomatic fix.
//
// HAND-OFFS ARE FOLLOWED, NOT WAVED THROUGH. The restore instance seeds its host in one function and
// resolves it in another, so a purely local rule would have missed the very bug it was built from. When
// the token is passed on (as an argument, inside an object argument, or returned), the gate follows it
// one hop into the callee and grades every ASYNC continuation there that touches the token. A hand-off to
// a callee it cannot resolve is counted and printed as UNRESOLVED, because "I could not check" is not
// "I checked and it was fine".
//
// AND SO ARE INLINE CONTINUATIONS. The second way this codebase hands a token on is not a named callee at
// all: `void engine.thing().then(ok).catch(err => { ... })`, where the release lives inside one branch of
// an arrow function. Reading the whole statement subtree for a release credits that one branch to EVERY
// path, which is the same mistake as crediting a callee without checking its paths. So the effect scan
// stops at a nested function boundary and every promise continuation is graded as its own set of exits.
//
// WHAT IT DELIBERATELY DOES NOT GRADE. A `throw` is a completion, not a freeze: the busy state travels to
// a caller that has to deal with it. A path guarded by a liveness check has no region left to paint. A
// path that returns before anything has been awaited has not left a wait behind it, so a re-entrancy guard
// is not a freeze. A bare `disabled = true` with nothing in flight is a validity gate, not a wait. And the
// busy-state renderers themselves (setBusy, renderLoading) are the paint, not a leak of it.
//
// FLOORS. This gate fails when it cannot run and when there is nothing to check, not only when it finds
// something. A parse that yields no busy-sets is a matcher that has stopped matching, not a codebase that
// has stopped having busy states. Every vocabulary carries its OWN floor as well as the total, because a
// total in the hundreds hides one rule going to zero.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const require = createRequire(import.meta.url);

let ts;
try {
  ts = require("typescript");
} catch (err) {
  console.error(`[paint-before-leave] FAIL: cannot load the TypeScript compiler (${/** @type {Error} */ (err).message}).`);
  console.error("This gate reads control flow off the real AST; without the compiler it cannot run, and a gate");
  console.error("that cannot run must not report a pass. Run npm ci.");
  process.exit(2);
}

// ---- the busy vocabulary -----------------------------------------------------------------------------
// A pending label is this console's house spelling of "in progress", and it has TWO shapes. Both are
// needed: matching only the first found 13 of the 59 pending labels in src, and four live freezes sat in
// the other 46.
//
//   TRAILING   a present participle followed by an ellipsis, proper or typed as three dots ("Saving…",
//              "Adding..."). The participle is what separates a WAIT from an ELISION: `Plan 01ABC…` and a
//              bare `…` in a fleet cell both end in an ellipsis and neither is waiting for anything.
//   LEADING    a CAPITALISED participle opening the label ("Checking.", "Installing", "Creating 3 of 9",
//              "Confirming the engine reports the new key."). Most of this console's busy labels are whole
//              sentences with no ellipsis at all, and the four key-ceremony freezes were all of them.
//
// Capitalisation carries the precision, and it is not a style preference: a status the operator reads
// STARTS a sentence. The one participle-led label in src that is not a wait is `showing ${visible} of
// ${n}` (sources/shared.ts, a count line), and the capital is exactly what excludes it.
const TRAILING_PENDING = /\b\w+ing\b[^.…]*(…|\.\.\.)\s*$/i;
const LEADING_PENDING = /^\s*[A-Z]\w*ing\b/;
const isPendingText = (t) => LEADING_PENDING.test(t) || TRAILING_PENDING.test(t);

// The console's own names for "the wait is showing HERE". Each builds a spinner or skeleton node, and a
// region holding one is a region waiting on something. restore-flow/proof.ts's frozen result panel is
// only visible through this entry: its placeholder is a proofRunning() call whose prose ends in a full
// stop, so neither participle rule alone would see it.
const SPINNER_BUILDER = /^(spinnerLine|proofRunning|loadingSkeleton|skeletonRows|skeletonTiles|spinner|skeleton)$/;

// Host-seeding verbs: putting a node INTO a region.
const APPEND_VERBS = new Set(["appendChild", "append", "replaceChildren", "prepend"]);

// The busy-toggle helpers screens pass down to their bodies. Matched on ANY boolean argument, because the
// element is the first argument in some of them (setBtnBusy(btn, true, "Reconstructing")).
const BUSY_TOGGLE = /^(setBusy|setPending|setLoading|setSubmitting|setBtnBusy)$/;

// A function whose whole job is to RENDER the busy state. Its busy-set is the paint, not a leak of one;
// the release lives in its sibling (renderShell, setBusy(false)) and grading it reports the toggle
// definition rather than any handler that forgets to call it.
const BUSY_RENDERER = /^(setBusy|setPending|setLoading|setSubmitting|setBtnBusy|renderLoading|showLoading|renderSkeleton|renderBusy|renderPending)$/;

// A REPAINT call rebuilds the region the busy control lives in, so the busy control goes with it. These
// are the console's own names for that: the injected `refresh()` / `reload()` a section is handed, and the
// render/paint/show family a screen calls on itself. Named rather than inferred, because most of them are
// INJECTED callbacks (a parameter, not a function this gate can read), and refusing to recognise them
// would report every successful save in settings/push.ts as a freeze.
const REPAINT_CALL = /^(refresh|reload|rerender|reRender|redraw|remount|repaint|paint|render|render[A-Z]\w*|paint[A-Z]\w*|show[A-Z]\w*|reflect|reflect[A-Z]\w*|mount|load|reset)$/;

// Closing the overlay takes the busy control off the screen with it, which resolves the wait as surely as
// re-enabling the button would.
const DISMISS_CALL = /^(close|dismiss|closeModal|closeDrawer|destroy|teardown|unmount)$/;

// The flow's own continuation, handed in by whoever owns the step: a form that saved calls back and its
// owner decides what is on screen next.
const CONTINUATION_CALL = /^(on[A-Z]\w*|reenter|advance|next|goTo\w*|finish|complete)$/;

// A path guarded by a LIVENESS check is not a freeze: the region has already left the document, so there
// is nothing to paint and nobody to see it. The console spells this `isAlive()`, `isConnected` and the
// abort signal. runs/view.ts's load() has two such returns and both are deliberate ("navigated away
// mid-load: drop the result, do not render into a detached node").
const LIVENESS_GUARD = /\b(isAlive|isConnected|aborted|destroyed|disposed|cancelled|canceled|stale)\b/;

// A label assigned from a VARIABLE is ambiguous: `btn.textContent = original` restores and
// `btn.textContent = opts.busyLabel` does the opposite. The name is the only evidence available, and it
// is enough: without this rule, keys/shared.ts would read its own busy label as the restore and the 401
// freeze one line later would go unreported.
const BUSY_NAMED = /busy|pending|loading|progress|working/i;

// The promise-continuation verbs. A closure handed to one of these runs AFTER the awaited work has
// answered, so it is a settled continuation and every exit from it is an exit from the wait.
const CONTINUATION_VERB = /^(then|catch|finally)$/;

// ---- allowlist ---------------------------------------------------------------------------------------
// Each entry is `file:token` at a busy-set the gate can see but must not grade, with the reason. Kept
// near-empty: a site that is merely awkward gets fixed instead. A stale entry fails the run.
const ALLOWED = {
  // The onboarding engine-probe lines are the retry loop's own narration ("...; retrying..."), rewritten
  // on the next attempt by the same loop that wrote them. The wait is real and the loop owns it.
  "src/screens/onboarding/steps.ts:renderStatus:lineText": "retry narration rewritten by the loop that owns the retry",
  "src/screens/onboarding/steps.ts:tick:lineText": "retry narration rewritten by the loop that owns the retry",
  // The Download control is disabled because there is no reconstructed key to download, not because
  // anything is in flight. Every failure path in doReconstruct paints resultHost with the reason and
  // re-enables the control that WAS pressed; leaving Download off is the correct end state, and
  // invalidateResult() in the same file disables it for the same reason with nothing awaited at all.
  "src/screens/restore-flow/reassembly.ts:doReconstruct:downloadBtn": "invalidation of a stale result, not a wait",
  // Each entry below has been read at its own path; the reason names the release, or names why there is
  // nothing owed.
  //
  // The install SUCCEEDED and markInstalled() converges all three controls: installBtn to "Keys installed",
  // installInfo to the keys-installed sentence, tokenInput cleared and disabled (makeMarkInstalled, same
  // file). It is an INJECTED callback rather than a call this gate can read, which is the same shape the
  // REPAINT_CALL list exists for; it is allowlisted rather than named there because the bare mark* family in
  // src also contains markPassed, markSetupCelebrated, markAuthKnownHere and markStaleFailure, none of which
  // repaint anything, so widening the vocabulary to catch this one would credit four releases that are not.
  "src/screens/onboarding/steps.ts:installKeysHandler:ctl.installBtn": "released by the injected markInstalled() finaliser",
  "src/screens/onboarding/steps.ts:installKeysHandler:ctl.installInfo": "released by the injected markInstalled() finaliser",
  // The bounded confirmation poll's own narration, rewritten by the interval that owns it, on the same
  // reading as the onboarding retry line above. Every tick either advances the count, or hits WAIT_POLL_MAX
  // and writes the terminal "Still confirming. Refresh this screen to re-check the bindings." line, so the
  // sentence the gate objects to cannot be the last thing this element says.
  "src/screens/sources/account.ts:(anonymous):status": "poll narration bounded by WAIT_POLL_MAX, which writes the terminal line",
};

// ---- file walk ---------------------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// ---- small AST helpers -------------------------------------------------------------------------------
const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);

const isLoop = (n) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);

const STATEMENT_KINDS = new Set([
  ts.SyntaxKind.Block, ts.SyntaxKind.EmptyStatement, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ContinueStatement, ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.DebuggerStatement,
]);
const isStmt = (n) => STATEMENT_KINDS.has(n.kind);

/** Unwrap the syntax that does not change WHICH object is named: parentheses, `as T`, `!`, `satisfies`. */
function unwrap(e) {
  let n = e;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || (ts.isSatisfiesExpression?.(n) ?? false)) n = n.expression;
    else return n;
  }
}

/**
 * The receiver an element expression names, as source text: `btn` from `btn.disabled`, `this.content`
 * from `this.content.setAttribute`. Unwrapped first, so `(btn as HTMLButtonElement).disabled = true` and
 * `btn.disabled = false` name the same token and the release is seen.
 */
function receiverText(expr, sf) {
  return unwrap(expr).getText(sf).replace(/\s+/g, "");
}

const callName = (n) => (ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : "");

/** True when a subtree holds a pending label, or builds one of the console's spinner/skeleton nodes. */
function holdsPendingString(node) {
  let found = false;
  const scan = (m) => {
    if (found) return;
    if ((ts.isStringLiteral(m) || ts.isNoSubstitutionTemplateLiteral(m)) && isPendingText(m.text)) found = true;
    // A template's pending marker sits in its HEAD (`Creating ${n} of ${m}`) or its TAIL (`Saving ${n}…`),
    // and each is a token rather than a string literal, so each needs naming separately.
    else if (m.kind === ts.SyntaxKind.TemplateHead && LEADING_PENDING.test(m.text)) found = true;
    else if (m.kind === ts.SyntaxKind.TemplateTail && TRAILING_PENDING.test(m.text)) found = true;
    else if (ts.isCallExpression(m) && SPINNER_BUILDER.test(callName(m))) found = true;
    if (!found) ts.forEachChild(m, scan);
  };
  scan(node);
  return found;
}

/** The element a busy-toggle call is toggling, and which way. */
function toggleShape(node, sf) {
  const name = callName(node);
  if (!BUSY_TOGGLE.test(name)) return null;
  const on = node.arguments.some((a) => a.kind === ts.SyntaxKind.TrueKeyword);
  const off = node.arguments.some((a) => a.kind === ts.SyntaxKind.FalseKeyword);
  const el = node.arguments.find((a) => ts.isIdentifier(a) || ts.isPropertyAccessExpression(a));
  const token = el ? receiverText(el, sf) : ts.isPropertyAccessExpression(node.expression) ? receiverText(node.expression, sf) : name;
  return { token, on, off };
}

/**
 * An OPTIONS-OBJECT busy flag: `reflectApprovalPolicy(view, view.current, { busy: true })`. The busy state
 * is real (that call sets sw.disabled), it is spelled nowhere else in the file, and the three
 * security-centre switches that freeze on a 401 are all of them. The token is the FIRST argument, the view
 * the paint function is being asked to redraw; the release is the same function called without the flag.
 */
function optionsBusyFlag(node, sf) {
  if (!ts.isCallExpression(node)) return null;
  let flag = null;
  for (const a of node.arguments) {
    if (!ts.isObjectLiteralExpression(a)) continue;
    for (const p of a.properties) {
      if (!ts.isPropertyAssignment(p) || !p.name || p.name.getText(sf) !== "busy") continue;
      if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) flag = true;
      else if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) flag = false;
    }
  }
  if (flag === null) return null;
  const first = node.arguments[0];
  const token = first && (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first)) ? receiverText(first, sf) : callName(node);
  return { token, on: flag, callee: callName(node) };
}

/**
 * Classify a node as a busy-SET, returning { token, kind } or null.
 *
 * token is the source text of the thing put into the busy state, which is what a release has to name
 * again. For a bare `setBusy(true)` there is no receiver, so the helper's own name is the token and a
 * release is the matching `setBusy(false)`.
 */
function busySet(node, sf) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
    const prop = node.left.name.text;
    const token = receiverText(node.left.expression, sf);
    if (prop === "disabled" && node.right.kind === ts.SyntaxKind.TrueKeyword) return { token, kind: "disabled" };
    if (prop === "textContent" || prop === "innerText") {
      if (holdsPendingString(node.right)) return { token, kind: "label" };
      if (!ts.isStringLiteralLike(node.right) && BUSY_NAMED.test(node.right.getText(sf))) return { token, kind: "label" };
    }
    // `btn.dataset.busy = "true"` is this console's own attribute spelling of the wait, used by the audit
    // export, the notify test-send and the restore attestation. The token is the ELEMENT, not its dataset,
    // so the matching `= "false"` and any `disabled = false` on the same element both read as the release.
    if (prop === "busy" && ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === "dataset") {
      const el = receiverText(node.left.expression.expression, sf);
      if (ts.isStringLiteralLike(node.right) && node.right.text === "true") return { token: el, kind: "data-busy" };
    }
  }
  if (ts.isCallExpression(node)) {
    const pae = ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
    const name = callName(node);
    if (pae && name === "setAttribute") {
      const [a, b] = node.arguments;
      const isTrue = b && (b.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(b) && b.text === "true"));
      if (a && ts.isStringLiteral(a) && a.text === "aria-busy" && isTrue) return { token: receiverText(pae.expression, sf), kind: "aria-busy" };
    }
    const tog = toggleShape(node, sf);
    if (tog?.on) return { token: tog.token, kind: "toggle" };
    const opt = optionsBusyFlag(node, sf);
    if (opt?.on) return { token: opt.token, kind: "opts-busy" };
    if (pae && APPEND_VERBS.has(name) && node.arguments.some((a) => holdsPendingString(a))) {
      return { token: receiverText(pae.expression, sf), kind: "placeholder" };
    }
  }
  return null;
}

/** True when this node RELEASES the named token: takes the UI back out of the busy state it was put in. */
function releasesToken(node, token, sf) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
    const prop = node.left.name.text;
    // The dataset release names the element one level further in than an ordinary property write.
    if (prop === "busy" && ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === "dataset") {
      return receiverText(node.left.expression.expression, sf) === token && ts.isStringLiteralLike(node.right) && node.right.text !== "true";
    }
    if (receiverText(node.left.expression, sf) !== token) return false;
    if (prop === "disabled") return node.right.kind !== ts.SyntaxKind.TrueKeyword;
    if (prop === "textContent" || prop === "innerText") return !holdsPendingString(node.right) && !BUSY_NAMED.test(node.right.getText(sf));
    if (prop === "innerHTML") return true;
    return false;
  }
  if (ts.isCallExpression(node)) {
    const pae = ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
    const name = callName(node);
    // The options-object paint called WITHOUT the busy flag repaints that same view out of the busy state.
    const opt = optionsBusyFlag(node, sf);
    if (opt && opt.token === token) return opt.on === false;
    if (!opt && node.arguments.length > 0 && REPAINT_CALL.test(name)) {
      const first = node.arguments[0];
      const firstTok = first && (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first)) ? receiverText(first, sf) : null;
      if (firstTok === token) return true;
    }
    // A repaint, a dismissal or the flow's own continuation resolves the wait for whatever was waiting, so
    // none of the three is matched against the token. goSignedOut / navigate / toast are deliberately
    // absent from all three lists: see the header.
    if (REPAINT_CALL.test(name) || DISMISS_CALL.test(name) || (!pae && CONTINUATION_CALL.test(name))) return true;
    const tog = toggleShape(node, sf);
    if (tog) return tog.off && tog.token === token;
    if (!pae) return false;
    if (receiverText(pae.expression, sf) !== token) return false;
    // Repainting or removing the host, or clearing the busy attribute, all end the wait.
    if (name === "replaceChildren") return node.arguments.length > 0;
    if (name === "replaceWith" || name === "remove" || name === "removeAttribute") return true;
    if (name === "setAttribute") {
      const [a, b] = node.arguments;
      const isTrue = b && (b.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(b) && b.text === "true"));
      if (a && ts.isStringLiteral(a) && a.text === "aria-busy") return !isTrue;
    }
  }
  return false;
}

/**
 * A PAINT is any write that changes what the operator can see. Deliberately broad, because the rule is
 * that SOMETHING replaced the wait, not that a particular element did.
 *
 * A CLEAR is not a paint. The console routinely empties an error host on the way IN
 * (`errorHost.replaceChildren()` immediately after disabling the button, `formError.hidden = true` at the
 * top of a submit), and counting that as the resolution would let every 401 return in settings/push.ts
 * pass while the button stayed on "Saving…".
 */
const PAINT_ADDERS = new Set(["replaceChildren", "append", "appendChild", "prepend", "replaceWith", "insertBefore"]);
function paintsAnything(n) {
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
    const prop = n.left.name.text;
    if (prop === "hidden") return n.right.kind === ts.SyntaxKind.FalseKeyword;
    if (prop === "textContent" || prop === "innerText" || prop === "innerHTML") return !(ts.isStringLiteralLike(n.right) && n.right.text === "");
    return false;
  }
  if (ts.isCallExpression(n)) {
    const name = callName(n);
    if (REPAINT_CALL.test(name) || DISMISS_CALL.test(name) || CONTINUATION_CALL.test(name)) return true;
    if (!ts.isPropertyAccessExpression(n.expression)) return false;
    if (name === "remove") return true;
    if (PAINT_ADDERS.has(name)) return n.arguments.length > 0;
  }
  return false;
}

function mentionsToken(node, token) {
  let hit = false;
  const scan = (n) => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === token) hit = true;
    else ts.forEachChild(n, scan);
  };
  scan(node);
  return hit;
}

/**
 * True when this node HANDS the token on: its fate is decided somewhere this function cannot see.
 *
 * A mention inside a nested CALLBACK argument is not a hand-off. `blockError(err, () => btn.click())`
 * names the button in a retry closure that runs only if the operator presses it; the button's state right
 * now is still this function's problem. Counting those made nine retry callbacks read as lost tokens.
 *
 * Reading a PROPERTY off the token is not a hand-off either. `Number(cadenceInput.value)` passes a string,
 * not the control, and counting it lost a token the gate could otherwise have followed.
 */
function handsOffToken(node, token) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return null;
  // Putting the node into a parent is not a hand-off. `section.appendChild(approvalHost)` transfers
  // nothing: renderConfirm still owns whether that host ever stops saying "Checking…". Treating it as one
  // would mask the real hand-off two lines later (startApprovalGate), letting the gate walk straight past
  // the instance it is built from.
  if (ts.isCallExpression(node) && PAINT_ADDERS.has(callName(node))) return null;
  const args = node.arguments ?? [];
  let hit = false;
  const scan = (m) => {
    if (hit || isFnLike(m)) return;
    // `token.value` reads a property; the element itself is not being passed anywhere.
    if (ts.isPropertyAccessExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === token) return;
    if (ts.isIdentifier(m) && m.text === token) hit = true;
    else if (ts.isShorthandPropertyAssignment(m) && m.name.text === token) hit = true;
    if (!hit) ts.forEachChild(m, scan);
  };
  for (const a of args) scan(a);
  if (!hit) return null;
  return { callee: ts.isIdentifier(node.expression) ? node.expression.text : null };
}

/**
 * Every promise continuation inside a subtree that mentions the token, as its own gradable closure.
 *
 * THE SCOPE NODE IS ITSELF A CANDIDATE. Walking only the CHILDREN (forEachChild) would miss the case
 * where the subtree handed in IS the continuation call, which is what `return engine.getDestination().then(st
 * => { region.replaceChildren(...) })` and licence.ts's `return Promise.all([...]).then(...).catch(err
 * => { ... })` both are: the release lives in the outermost `.then`/`.catch` of the returned expression,
 * and stepping straight over it would report two regions that repaint on every path as freezes. It cuts
 * both ways rather than being a leniency, because a continuation collected here is also GRADED here, as
 * its own set of exits.
 */
function continuationsIn(scope, token, resolveLocal) {
  if (!scope) return [];
  const out = [];
  const scan = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && CONTINUATION_VERB.test(n.expression.name.text)) {
      for (const a of n.arguments) {
        let f = unwrap(a);
        // A continuation handed on BY NAME (`.catch(failInline)`) is the same continuation as one written
        // inline; only the spelling differs. Resolving it grades the named function's own exits, which is
        // what the header promises for hand-offs. Left unresolved, editor-wizard's create step would report
        // a freeze whose release is in the failInline three lines above the call.
        if (ts.isIdentifier(f) && resolveLocal) f = resolveLocal(f.text) ?? f;
        if (isFnLike(f) && f.body && ts.isBlock(f.body) && mentionsToken(f, token)) out.push(f);
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(scope);
  return out;
}

// ---- cross-file plumbing -----------------------------------------------------------------------------
// The console imports with an explicit ".ts" extension, so resolution is nearly literal; the other forms
// are tried anyway so a change of convention degrades to "unresolved" rather than to a silent pass.
function resolveSibling(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")]) {
    try { if (readFileSync(cand, "utf8")) return cand; } catch { /* next */ }
  }
  return null;
}

const parsed = new Map();
function parseFile(file) {
  if (parsed.has(file)) return parsed.get(file);
  let sf = null;
  try { sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS); } catch { sf = null; }
  parsed.set(file, sf);
  return sf;
}

const analysers = new Map();
function analyserFor(file) {
  if (analysers.has(file)) return analysers.get(file);
  analysers.set(file, null); // cycle break: a mutually-importing pair must not recurse forever
  const sf = parseFile(file);
  const a = sf ? buildAnalyser(file, sf) : null;
  analysers.set(file, a);
  return a;
}

// ---- per-file analysis -------------------------------------------------------------------------------
function buildAnalyser(file, sf) {
  const rel = relative(ROOT, file).split("\\").join("/");
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Where each imported name comes from, so a hand-off that leaves this file can still be followed. A
  // gate that gave up at the file boundary would have nine "I could not check" rows, and those are not
  // passes.
  const importedFrom = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const target = resolveSibling(file, spec);
    if (!target) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) importedFrom.set(el.name.text, target);
    if (st.importClause?.name) importedFrom.set(st.importClause.name.text, target);
  }

  // An index of functions declared in this file by name, so a call to a local helper can be followed.
  const localFns = new Map();
  const indexLocals = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) localFns.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFnLike(n.initializer)) localFns.set(n.name.text, n.initializer);
    ts.forEachChild(n, indexLocals);
  };
  indexLocals(sf);

  const calleeLocal = (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? (localFns.get(n.expression.text) ?? null) : null);

  /** Does calling this locally-known function release the token? Followed to a bounded depth. */
  const fnReleases = new Map();
  function functionReleases(fn, token, depth) {
    if (depth <= 0 || !fn?.body) return false;
    const key = `${token}@${fn.pos}`;
    if (fnReleases.has(key)) return fnReleases.get(key);
    fnReleases.set(key, false); // cycle break
    let found = false;
    const scan = (n) => {
      if (found) return;
      if (releasesToken(n, token, sf)) { found = true; return; }
      const local = calleeLocal(n);
      if (local && functionReleases(local, token, depth - 1)) { found = true; return; }
      ts.forEachChild(n, scan);
    };
    scan(fn.body);
    fnReleases.set(key, found);
    return found;
  }

  /**
   * Everything one statement does, ignoring control flow.
   *
   *   released   the token itself came out of the busy state, or a repaint/dismissal/continuation ran
   *   paint      SOME element was written to, which resolves the wait whatever element it was. Credited
   *              only once the path has SETTLED, because the console paints plenty on the way IN: a
   *              placeholder, a "Working." reassurance line, an error host revealed. Counting those would
   *              let keys/shared.ts read its own busy label as the resolution and would hide the 401
   *              freeze below it.
   *   awaits     this statement is where the waiting happens
   *   handedOff  the token was passed on, so its fate is decided somewhere else
   *   conts      the promise continuations the token's fate is decided inside
   *
   * THE SCAN STOPS AT A NESTED FUNCTION BOUNDARY. A release written inside one branch of a `.catch` arrow
   * is that arrow's business, on that arrow's path; reading it from out here credited it to every path out
   * of the enclosing handler, and three live freezes hid behind that.
   */
  function effect(node, token) {
    let released = false;
    let paint = false;
    let awaits = false;
    let handedOff = null;
    const conts = continuationsIn(node, token, (nm) => localFns.get(nm) ?? null);
    const scan = (n) => {
      // The hand-off is recorded FIRST and unconditionally, because recording it only once nothing else
      // had released would let functionReleases() on the very callee the token is handed to satisfy the
      // check: "somewhere inside startApprovalGate this host is replaced" is true, and is not the
      // question. Recording the hand-off unconditionally is what lets the gate see its own founding
      // instance instead of walking past it.
      const h = handsOffToken(n, token);
      if (h) handedOff = h;
      if (releasesToken(n, token, sf)) released = true;
      // A busy-set is a paint by construction (that is what a placeholder is). Crediting it would let
      // every site release itself the instant it went busy.
      else if (paintsAnything(n) && !busySet(n, sf)) paint = true;
      if (ts.isAwaitExpression(n)) awaits = true;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && CONTINUATION_VERB.test(n.expression.name.text)) awaits = true;
      // A PROMISE `.finally` covers every path, for the same reason a try/finally does and which this gate
      // already credits: the callback runs whether the work resolved or rejected. `setBusy(true); void
      // run(token).finally(() => setBusy(false));` releases on every outcome there is, and reporting it as
      // a freeze pointed at the one shape the header calls the idiomatic fix.
      //
      // Read through the nested boundary DELIBERATELY, and only here. The general rule that the effect scan
      // stops at a function boundary exists because a release in ONE BRANCH of a `.catch` is not a release
      // on every path; a `.finally` has no branches to be wrong about, so the same reasoning that forbids
      // the general case is what permits this one.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "finally") {
        for (const a of n.arguments) {
          const f = unwrap(a);
          if (!isFnLike(f) || !f.body) continue;
          let frees = false;
          const look = (m) => { if (frees) return; if (releasesToken(m, token, sf)) frees = true; else ts.forEachChild(m, look); };
          look(f.body);
          if (frees) released = true;
        }
      }
      const local = calleeLocal(n);
      // A local helper called WITHOUT the token releases it or it does not, and that is answerable here.
      // A call the token is passed INTO is answered by the hop instead.
      if (local && !h && functionReleases(local, token, 3)) released = true;
      ts.forEachChild(n, (c) => { if (!isFnLike(c)) scan(c); });
    };
    scan(node);
    return { released, paint, awaits, handedOff, conts };
  }

  /**
   * Fold one statement's own effect into the path state. A hand-off ACCUMULATES: it is the question moving
   * elsewhere, not the question being answered, and the gate has to still be holding every callee it was
   * handed to when it reaches the end of the path.
   */
  function step(st, e, extra = false) {
    const settled = st.settled || e.awaits;
    const handoffs = e.handedOff ? [...st.handoffs, e.handedOff] : st.handoffs;
    const conts = e.conts.length > 0 ? [...st.conts, ...e.conts] : st.conts;
    return {
      released: st.released || e.released || extra || e.handedOff !== null || e.conts.length > 0 || (e.paint && settled),
      settled, handoffs, conts,
    };
  }

  // ---- completion analysis ----
  // A tiny abstract interpreter over the statement forms src actually uses. Each analyse* returns the ways
  // a piece of code can COMPLETE: { kind: "normal" | "return" | "throw" | "break" | "continue", released }.
  // "normal" is falling off the end; `released` is sticky along a path.
  function analyseStatements(stmts, token, entering) {
    let cur = [{ kind: "normal", ...entering }];
    const out = [];
    for (const s of stmts) {
      const next = [];
      for (const c of cur) {
        if (c.kind !== "normal") { out.push(c); continue; }
        for (const r of analyseStatement(s, token, { released: c.released, settled: c.settled, handoffs: c.handoffs, conts: c.conts })) {
          if (r.kind === "normal") next.push(r);
          else out.push(r);
        }
      }
      cur = next;
      if (cur.length === 0) break;
    }
    return [...out, ...cur];
  }

  const NOEFFECT = { released: false, paint: false, awaits: false, handedOff: null, conts: [] };

  function analyseStatement(s, token, st) {
    if (ts.isBlock(s)) return analyseStatements(s.statements, token, st);

    if (ts.isIfStatement(s)) {
      // A branch taken because the region is already gone has nothing to paint into.
      const st0 = step(st, effect(s.expression, token), LIVENESS_GUARD.test(s.expression.getText(sf)));
      const then = analyseStatement(s.thenStatement, token, st0);
      const els = s.elseStatement ? analyseStatement(s.elseStatement, token, st0) : [{ kind: "normal", ...st0 }];
      return [...then, ...els];
    }

    if (ts.isTryStatement(s)) {
      const tryOut = analyseStatements(s.tryBlock.statements, token, st);
      // An exception can interrupt the try block at any point, so the catch is entered with what was
      // released BEFORE the try, never with the try block's own releases, and always SETTLED: reaching a
      // catch means the awaited work has already answered.
      const catchOut = s.catchClause ? analyseStatements(s.catchClause.block.statements, token, { released: st.released, settled: true, handoffs: st.handoffs, conts: st.conts }) : [];
      // A finally that releases covers every path out at once. That is the idiomatic fix, and the reason
      // this gate walks control flow rather than counting returns.
      const finallyReleases = s.finallyBlock ? analyseStatements(s.finallyBlock.statements, token, { released: false, settled: true, handoffs: [], conts: [] }).some((c) => c.released) : false;
      const all = s.catchClause ? [...tryOut, ...catchOut] : [...tryOut, { kind: "throw", released: finallyReleases, settled: true, handoffs: st.handoffs, conts: st.conts }];
      return all.map((c) => ({ ...c, released: c.released || finallyReleases }));
    }

    if (ts.isSwitchStatement(s)) {
      const st0 = step(st, effect(s.expression, token));
      const out = [];
      let hasDefault = false;
      for (const cl of s.caseBlock.clauses) {
        if (ts.isDefaultClause(cl)) hasDefault = true;
        for (const c of analyseStatements(cl.statements, token, st0)) out.push(c.kind === "break" ? { ...c, kind: "normal" } : c);
      }
      if (!hasDefault) out.push({ kind: "normal", ...st0 });
      return out;
    }

    if (isLoop(s)) {
      const body = analyseStatement(s.statement, token, st);
      const out = body.filter((c) => c.kind === "return" || c.kind === "throw");
      // A loop that completes normally carries its body's release out with it. That is not a courtesy: the
      // busy-set itself is often a loop (`for (const b of buttons) b.disabled = true`) and the release is
      // the mirror loop over the same collection, so refusing to propagate would report every modal action
      // in components/modal.ts as unreleased when it restores on all four of its paths.
      const normals = body.filter((c) => c.kind === "normal" || c.kind === "break");
      out.push({ kind: "normal", released: st.released || normals.some((c) => c.released), settled: st.settled || normals.some((c) => c.settled), handoffs: st.handoffs, conts: st.conts });
      return out;
    }

    if (ts.isLabeledStatement(s)) return analyseStatement(s.statement, token, st);

    if (ts.isReturnStatement(s)) {
      const e = s.expression ? effect(s.expression, token) : NOEFFECT;
      // Returning the host itself hands it to the caller, which is how every render function in src ends.
      const returnsToken = s.expression !== undefined && ts.isIdentifier(unwrap(s.expression)) && unwrap(s.expression).text === token;
      return [{ kind: "return", ...step(st, e, returnsToken), node: s }];
    }
    // A throw is a completion, not a freeze: it travels to a caller that has to deal with it.
    if (ts.isThrowStatement(s)) return [{ kind: "throw", released: true, settled: st.settled, handoffs: st.handoffs, conts: st.conts }];
    if (ts.isBreakStatement(s)) return [{ kind: "break", ...st }];
    if (ts.isContinueStatement(s)) return [{ kind: "continue", ...st }];

    const e = effect(s, token);
    return [{ kind: "normal", ...step(st, e) }];
  }

  /**
   * The completions reachable AFTER the busy-set, walking out through every construct enclosing it.
   *
   * Slicing the owner's top-level statement list instead would grade SIBLING branches the busy-set can
   * never reach: components/modal.ts sets its busy state inside `if (action.busyLabel)`, whose every path
   * returns, so the non-busy tail below that if would be reported as an unreleased exit of a busy state it
   * is not part of.
   *
   * The busy statement's OWN effect is skipped. It is itself a paint (that is what a placeholder is), and
   * counting it would let every site release itself the instant it went busy.
   */
  function completionsAfterBusySet(busyNode, owner, token) {
    let cur = busyNode;
    while (cur.parent && !isStmt(cur)) cur = cur.parent;
    let comps = [{ kind: "normal", released: false, settled: false, handoffs: [], conts: [] }];
    // How many statements the busy-set is actually followed by. Zero means the function IS the busy paint
    // (a setTimeout that shows a skeleton, a tally line), not a handler that walked away from a wait.
    let tail = 0;

    while (cur.parent && cur !== owner.body) {
      const parent = cur.parent;
      if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        const stmts = parent.statements;
        const i = stmts.indexOf(cur);
        const rest = i >= 0 ? stmts.slice(i + 1) : [];
        tail += rest.length;
        const out = comps.filter((c) => c.kind !== "normal");
        for (const c of comps.filter((c) => c.kind === "normal")) out.push(...analyseStatements(rest, token, { released: c.released, settled: c.settled, handoffs: c.handoffs, conts: c.conts }));
        comps = out;
        cur = parent;
        continue;
      }
      if (ts.isTryStatement(parent)) {
        // The catch is reachable from HERE only if something is still awaited between the busy-set and the
        // end of the try block. Without that test, a state set AFTER the last await (keys/shared.ts spends
        // its token input once the apply has already succeeded) would be graded against a catch it can
        // never reach, and would read as a freeze.
        if (parent.tryBlock === cur && parent.catchClause && comps.some((c) => c.settled)) {
          comps = comps.concat(analyseStatements(parent.catchClause.block.statements, token, { released: false, settled: true, handoffs: [], conts: [] }));
          tail += parent.catchClause.block.statements.length;
        }
        if (parent.finallyBlock) {
          const finRel = analyseStatements(parent.finallyBlock.statements, token, { released: false, settled: true, handoffs: [], conts: [] }).some((c) => c.released);
          if (finRel) comps = comps.map((c) => ({ ...c, released: true }));
        }
        cur = parent;
        continue;
      }
      if (isLoop(parent) || ts.isSwitchStatement(parent) || ts.isCaseBlock(parent)) {
        comps = comps.map((c) => (c.kind === "break" || c.kind === "continue" ? { ...c, kind: "normal" } : c));
        cur = parent;
        continue;
      }
      cur = parent;
    }
    return { comps, tail };
  }

  /**
   * Does this function have work IN FLIGHT: an await, a promise continuation, or a fire-and-forget call?
   *
   * Nested functions are NOT read. An await inside a click listener declared in a builder does not make
   * the builder's own `input.disabled = true` a wait: sources-downpipes/table.ts disables a switch for a
   * missing capability and wires a listener that awaits, and reading the two together would report a
   * permission gate as a frozen control.
   */
  const inFlightCache = new Map();
  function inFlight(fn) {
    if (!fn?.body) return false;
    if (inFlightCache.has(fn)) return inFlightCache.get(fn);
    let yes = false;
    const scan = (n) => {
      if (yes) return;
      if (ts.isAwaitExpression(n)) { yes = true; return; }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && CONTINUATION_VERB.test(n.expression.name.text)) { yes = true; return; }
      // `void engine.doThing()` is the console's fire-and-forget spelling; the work is still in flight.
      if (ts.isVoidExpression(n) && ts.isCallExpression(unwrap(n.expression))) { yes = true; return; }
      ts.forEachChild(n, (c) => { if (!isFnLike(c)) scan(c); });
    };
    scan(fn.body);
    inFlightCache.set(fn, yes);
    return yes;
  }

  /**
   * Grade one closure's exits against the token. A completion that has NOT settled is not a freeze: a
   * re-entrancy guard (`if (polling) return;`) leaves before anything is awaited, so nobody is left
   * waiting on this call and the wait is still owned by whichever call is in flight.
   */
  function gradeClosure(fn, token, entering) {
    if (!fn?.body || !ts.isBlock(fn.body)) return []; // a concise arrow body is one expression, no continuation
    const out = [];
    for (const c of analyseStatements(fn.body.statements, token, entering)) {
      if ((c.kind === "return" || c.kind === "normal") && !c.released && c.settled) out.push({ fn, node: c.node ?? fn });
    }
    return out;
  }

  /**
   * THE SECOND HOP. When the token is handed on, follow it one step into the callee and grade every ASYNC
   * continuation there that touches it. This is the entry that reaches the restore instance: renderConfirm
   * seeds approvalHost and hands it to startApprovalGate, whose recheck() is where the unauthorised branch
   * returned without painting. A gate that stopped at the hand-off would have missed the bug it exists for.
   */
  function gradeHandOff(calleeName, token) {
    const fn = localFns.get(calleeName);
    if (!fn) {
      // The callee lives in another file. Hand the question to that file's analyser rather than shrugging.
      const target = importedFrom.get(calleeName);
      const other = target ? analyserFor(target) : null;
      return other ? other.gradeFunctionNamed(calleeName, token) : { resolved: false, bad: [] };
    }
    return gradeFunction(fn, token);
  }

  function gradeFunctionNamed(name, token) {
    const fn = localFns.get(name);
    return fn ? gradeFunction(fn, token) : { resolved: false, bad: [] };
  }

  function gradeFunction(fn, token) {
    if (!fn?.body || !ts.isBlock(fn.body)) return { resolved: false, bad: [] };
    const bad = [];
    const visit = (n) => {
      if (isFnLike(n) && n !== fn && n.body && ts.isBlock(n.body) && inFlight(n) && mentionsToken(n, token)) {
        bad.push(...gradeClosure(n, token, { released: false, settled: false, handoffs: [], conts: [] }));
        return; // graded here; nested closures inside it are its own business
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return { resolved: true, bad };
  }

  // ---- drive it over every busy-set ----
  function run(report) {
    const seen = [];
    const visit = (node) => {
      const bs = busySet(node, sf);
      if (bs) {
        let owner = node.parent;
        while (owner && !isFnLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
        seen.push({ ...bs, node, owner, line: lineOf(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const s of seen) {
      // A DISABLE on its own is not a busy state. Most `x.disabled = true` in this console is a validity or
      // permission gate: a Next button off until a source type is picked, a read-only capability checkbox, a
      // radio a viewer may not move. Nothing is in flight and nothing is owed. It becomes a busy state only
      // when it brackets work. A pending LABEL, an aria-busy or a "Checking…" placeholder each assert the
      // wait in their own words and need no such test.
      if (s.kind === "disabled" && !inFlight(s.owner)) { report.notBusy++; continue; }
      // The busy-state renderers ARE the paint. Their release lives in a sibling by design.
      if (s.owner && BUSY_RENDERER.test(fnName(s.owner, sf))) { report.notBusy++; continue; }

      report.busySets++;
      report.busyFiles.add(rel);
      report.byKind[s.kind] = (report.byKind[s.kind] ?? 0) + 1;
      // The key names the OWNING FUNCTION as well as the file and the token, exactly as the baseline key
      // does. Keyed on file and token alone, "sessions-passkeys.ts:btn" would cover three different buttons
      // in three different cards that merely share the commonest variable name in the codebase, two of
      // which release in a try/finally: an entry written about one control would then go on silently
      // vouching for the other two after their finally was deleted.
      const key = `${rel}:${fnName(s.owner, sf)}:${s.token}`;
      if (ALLOWED[key]) { report.allowed.push({ rel, line: s.line, token: s.token, key, why: ALLOWED[key] }); continue; }
      // A concise arrow body (`() => host.replaceChildren(x)`) is one expression with no continuation.
      if (!s.owner || ts.isSourceFile(s.owner) || !s.owner.body || !ts.isBlock(s.owner.body)) { report.unowned.push({ rel, line: s.line, token: s.token }); continue; }

      // THE PROGRESS-CALLBACK CASE. The busy-set can be written from a callback handed INTO the async call
      // whose continuation then leaves: the wizard's bulk create writes "Creating 3 of 9" from a progress
      // callback while the `.then` on the same call returns on a lapsed session without putting the label
      // back. The owner walk cannot reach that, because the two closures are siblings; the call they are
      // both attached to is the one frame in which they are visibly the same control.
      if (s.owner && ts.isCallExpression(s.owner.parent) && s.owner.parent.arguments.includes(s.owner)) {
        let chain = s.owner.parent;
        while (chain.parent && (ts.isCallExpression(chain.parent) || ts.isPropertyAccessExpression(chain.parent))) chain = chain.parent;
        for (const c of continuationsIn(chain, s.token, (nm) => localFns.get(nm) ?? null)) {
          for (const b of gradeClosure(c, s.token, { released: false, settled: true, handoffs: [], conts: [] })) {
            report.findings.push({
              rel, busyLine: s.line, exitLine: lineOf(b.node), token: s.token, kind: s.kind,
              fn: `${fnName(s.owner, sf)} -> ${fnName(c, sf)}`, paths: 1, via: "progress callback",
            });
          }
        }
      }

      const { comps: completions, tail } = completionsAfterBusySet(s.node, s.owner, s.token);

      // THE INLINE-CONTINUATION PASS. Every promise continuation the path REACHES after the busy-set is
      // graded as its own set of exits, because that is where this codebase most often puts the release:
      // `void engine.thing().then(ok).catch(err => { if (isUnauthorised(err)) return goSignedOut(); ... })`
      // releases the control on one branch of the catch and not on the other, and reading the statement as
      // a whole credits the one branch to both.
      for (const c of new Set(completions.flatMap((c) => c.conts ?? []))) {
        for (const b of gradeClosure(c, s.token, { released: false, settled: true, handoffs: [], conts: [] })) {
          report.findings.push({
            rel, busyLine: s.line, exitLine: lineOf(b.node), token: s.token, kind: s.kind,
            fn: `${fnName(s.owner, sf)} -> ${fnName(c, sf)}`, paths: 1, via: "continuation",
          });
        }
      }

      // Nothing follows the busy-set inside its owner: this function's whole job was to show the wait.
      if (tail === 0) { report.notBusy++; continue; }
      // A busy state with nothing left to wait for is not a wait. keys/shared.ts spends its token input
      // AFTER the apply has already returned, as the terminal "this token is used up" state, and there is
      // no later answer that could release it because there is no later question. Graded only when an await
      // or a hand-off follows.
      if (!completions.some((c) => c.settled) && !completions.some((c) => (c.handoffs ?? []).length > 0)) { report.notBusy++; continue; }
      const bad = completions.filter((c) => (c.kind === "return" || c.kind === "normal") && !c.released);

      // If the token was handed on, the question moves to the callee and is answered there, not here.
      // `c.handoffs ?? []` infers never[] from the empty-array default, so the cast is comment-only.
      const hop = /** @type {any[]} */ (completions.flatMap((c) => c.handoffs ?? [])).map((h) => h.callee).find((c) => c);
      if (bad.length === 0 || hop) {
        if (hop) {
          const graded = gradeHandOff(hop, s.token);
          if (!graded.resolved) { report.unresolved.push({ rel, line: s.line, token: s.token, callee: hop }); continue; }
          if (graded.bad.length > 0) {
            report.findings.push({
              rel, busyLine: s.line, exitLine: lineOf(graded.bad[0].node), token: s.token, kind: s.kind,
              fn: `${fnName(s.owner, sf)} -> ${hop} -> ${fnName(graded.bad[0].fn, sf)}`, paths: graded.bad.length, via: "hand-off",
            });
            continue;
          }
        }
        if (bad.length === 0) { report.clean++; continue; }
      }

      const withNode = bad.find((c) => c.node);
      report.findings.push({
        rel, busyLine: s.line, exitLine: withNode ? lineOf(withNode.node) : s.line, token: s.token, kind: s.kind,
        fn: fnName(s.owner, sf), paths: bad.length, via: "direct",
      });
    }
  }

  return { run, gradeFunctionNamed, file, sf };
}

function fnName(fn, sf) {
  if (!fn || ts.isSourceFile(fn)) return "(module)";
  if (fn.name) return fn.name.getText(sf);
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && p.name) return p.name.getText(sf);
  if (p && ts.isPropertyAssignment(p) && p.name) return p.name.getText(sf);
  return "(anonymous)";
}

// ---- the ratchet ------------------------------------------------------------------------------------
// BASELINE IS EMPTY, AND THAT IS THE POINT. Screen-load regions seeded with a skeleton that can leave on a
// 401 without replacing it, and action controls that stay disabled on a label reading "Saving\u2026" over
// work that never happened, are both instances of the same defect class this gate exists to catch. Each
// finding this gate has ever raised has been read at its own path: a real freeze is fixed, and a finding
// that is not a real freeze is either written down in ALLOWED above with the release it actually has, or
// is a sign the gate itself is wrong about it (see continuationsIn, the .finally credit, and any exit that
// reads as a wait only because it opens with a participle).
//
// The ratchet has nothing to hold and the rule is the simple one: a finding fails the build. Do not re-open
// this list to land a screen. A row here is a freeze an operator can reach, and a ratchet only works if it
// drives the count to zero rather than tolerating it.
const BASELINE = [];

// ---- floors ------------------------------------------------------------------------------------------
// Set close enough to the counts this gate actually matches that a matcher which has stopped matching trips
// one. Every VOCABULARY carries its own floor as well as the total, because a total in the hundreds hides a
// single rule going to zero: the placeholder rule matching nothing is the founding instance becoming
// invisible again, and the aggregate would barely move.
const FLOOR_FILES = 420;
const FLOOR_BUSY_SETS = 150;
const FLOOR_BUSY_FILES = 60;
const FLOOR_BY_KIND = { disabled: 60, label: 30, placeholder: 15, toggle: 5, "data-busy": 4, "opts-busy": 2 };

// ---- run ---------------------------------------------------------------------------------------------
const files = walk(SRC);
// The arrays are filled by analyserFor().run(report), so an unannotated `[]` infers never[] and every later
// read of a finding's own fields reads as a property on never. The JSDoc is comment-only.
/** @type {{busySets: number, notBusy: number, clean: number, findings: any[], allowed: any[], unowned: any[], unresolved: any[], busyFiles: Set<string>, byKind: Record<string, number>}} */
const report = { busySets: 0, notBusy: 0, clean: 0, findings: [], allowed: [], unowned: [], unresolved: [], busyFiles: new Set(), byKind: {} };
for (const f of files) {
  const a = analyserFor(f);
  if (!a) {
    console.error(`[paint-before-leave] FAIL: could not parse ${relative(ROOT, f)}.`);
    process.exit(2);
  }
  a.run(report);
}

// findingKey identifies a site WITHOUT its line number, so the baseline below survives ordinary editing
// above it. A line-keyed baseline goes stale on the first unrelated insert and gets regenerated wholesale,
// which is how a baseline stops meaning anything.
const findingKey = (f) => `${f.rel}|${f.fn}|${f.token}|${f.kind}`;

// One control often carries two busy-sets (disabled + label) leaving by the same exit. Reporting the same
// freeze twice makes a fixed site look half-fixed, so the exit is what is counted.
const seenFinding = new Set();
report.findings = report.findings.filter((f) => {
  const k = `${f.rel}:${f.token}:${f.exitLine}`;
  if (seenFinding.has(k)) return false;
  seenFinding.add(k);
  return true;
});

// THE RATCHET. BASELINE lists sites this gate has decided are genuine freezes that are not yet fixed,
// named rather than hidden so the count is countable. A site NOT in this list fails the build, and a site
// IN it that has stopped matching fails too, so the list can only ever shrink. Delete the entry when you
// fix the site.
const inBaseline = new Set(BASELINE);
const newFindings = report.findings.filter((f) => !inBaseline.has(findingKey(f)));
const matchedBaseline = new Set(report.findings.map(findingKey).filter((k) => inBaseline.has(k)));
const staleBaseline = BASELINE.filter((k) => !matchedBaseline.has(k));

// FLOORS, checked before any verdict is printed so an empty or half-parsed scan can never reach the OK line.
const floorFailures = [];
if (files.length < FLOOR_FILES) floorFailures.push(`scanned ${files.length} .ts files under src, expected at least ${FLOOR_FILES}`);
if (report.busySets < FLOOR_BUSY_SETS) floorFailures.push(`matched ${report.busySets} busy-sets, expected at least ${FLOOR_BUSY_SETS}`);
if (report.busyFiles.size < FLOOR_BUSY_FILES) floorFailures.push(`${report.busyFiles.size} files carry a busy-set, expected at least ${FLOOR_BUSY_FILES}`);
for (const [kind, floor] of Object.entries(FLOOR_BY_KIND)) {
  const got = report.byKind[kind] ?? 0;
  if (got < floor) floorFailures.push(`the ${kind} vocabulary matched ${got} sites, expected at least ${floor}: that rule has stopped matching`);
}
for (const k of staleBaseline) {
  floorFailures.push(`baseline entry ${k} matched nothing; the site is fixed or renamed, so delete the entry (the ratchet only goes down)`);
}
for (const [k, why] of Object.entries(ALLOWED)) {
  if (!report.allowed.some((a) => a.key === k)) floorFailures.push(`stale allowlist entry ${k} (${why}) matched nothing; delete it`);
}
if (floorFailures.length > 0) {
  console.error("\n[paint-before-leave] FAIL: the gate could not check what it claims to check.");
  for (const f of floorFailures) console.error(`  - ${f}`);
  console.error("\nA gate that matches nothing reports a pass for the wrong reason. Fix the matcher, not the floor.\n");
  process.exit(2);
}

if (process.env.PBL_EMIT_BASELINE === "1") {
  for (const k of [...new Set(report.findings.map(findingKey))].sort()) console.log(`  ${JSON.stringify(k)},`);
  process.exit(0);
}

const kinds = Object.entries(report.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
console.log(
  `[paint-before-leave] ${files.length} files, ${report.busySets} busy-sets in ${report.busyFiles.size} files ` +
    `(${kinds}), ${report.notBusy} skipped as validity gates and busy renderers, ${report.clean} release on every path, ` +
    `${report.allowed.length} allowlisted, ${report.unresolved.length} unresolved hand-offs`,
);

// An unresolved hand-off is not a pass. It is the gate saying it lost the token, and it fails for the same
// reason the citation verifier refuses a stale sibling: an answer to a different question is not a weaker
// answer to this one.
if (report.unresolved.length > 0) {
  console.error(`\nHAND-OFFS THIS GATE COULD NOT FOLLOW (${report.unresolved.length}):`);
  for (const u of report.unresolved) console.error(`  ${u.rel}:${u.line}  "${u.token}" passed to ${u.callee ?? "an expression"}, which is not resolvable in this file`);
}

if (newFindings.length > 0) {
  console.error(`\nBUSY STATES THAT CAN BE LEFT WITHOUT A REPAINT (${newFindings.length}):\n`);
  for (const f of newFindings.sort((a, b) => a.rel.localeCompare(b.rel) || a.busyLine - b.busyLine)) {
    console.error(`  ${f.rel}:${f.busyLine}  ${f.fn}() puts "${f.token}" into a ${f.kind} busy state`);
    console.error(`    leaves at line ${f.exitLine} with ${f.paths} path${f.paths === 1 ? "" : "s"} that release nothing${f.via === "direct" ? "" : `, via the ${f.via}`}`);
  }
}

if (newFindings.length > 0 || report.unresolved.length > 0) {
  console.error("\nPAINT FIRST, THEN LEAVE. Release the control or repaint the host on the way out, or wrap the work");
  console.error("in try/finally so every path does. goSignedOut() is not a repaint: the nav bridge is a no-op until");
  console.error("app.ts installs it (src/lib/nav.ts, boot class nav-bridge-uninstalled), and the restore instance");
  console.error("called it on its way out and froze anyway.\n");
  process.exit(1);
}

console.log(`[paint-before-leave] OK: no busy state outside the baseline can be left without a repaint (${matchedBaseline.size} baselined sites still owed a fix).`);
