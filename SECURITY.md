# Security policy for downpipes/console

The console is a TypeScript Cloudflare Worker serving a static single-page
application that runs entirely inside the **customer's own Cloudflare account**.
It is the operator UI: onboarding, key ceremony, downpipe and source management,
and run status. It communicates only with the in-account engine admin API and
never holds custody of backup data.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security findings.**

Report via email to:

    security@maelstrom.au

Include:

- a description of the vulnerability and the affected component;
- reproduction steps, a proof-of-concept, or a test vector if you have one;
- the potential impact as you understand it;
- your preferred contact for follow-up.

We will acknowledge your report within **2 business days** (48 to 72 hours) and keep
you informed throughout remediation. We will credit you by name (or anonymously, if
you prefer) once the fix is shipped.

We do not operate a bug-bounty programme at this time.

### Confidential reporting channel

If you would like to encrypt your report, request our OpenPGP public key by sending a
short note to `security@maelstrom.au` and we will reply with the key and its
fingerprint out of band. The `.well-known/security.txt` endpoint
(`https://console.downpipes.io/.well-known/security.txt`) carries the canonical
contact and is updated when the key changes. GitHub private vulnerability reporting on
the `downpipes/console` repository is also an acceptable confidential channel.

### Coordinated disclosure window

We follow a **90-day coordinated-disclosure** model. We ask that you give us up to 90
days from the date you report a finding before any public disclosure, so we can
confirm, remediate and ship a fix. If a fix is ready sooner we will disclose sooner,
and we will agree any extension with you in writing if a finding is unusually hard to
remediate. We will never ask you to delay disclosure indefinitely.

### Safe harbour

We will not pursue or support legal action against anyone who, in good faith and in
line with this policy, discovers and reports a vulnerability. Good-faith research means
you avoid privacy violations, data destruction and any interruption or degradation of
service; you only ever interact with accounts you own or have explicit permission to
test; you do not access, modify or retain customer data beyond the minimum needed to
demonstrate the finding; and you give us a reasonable time to remediate before public
disclosure. Activity conducted consistently with this policy is considered authorised,
and we will work with you to understand and resolve the issue quickly. This safe
harbour does not extend to violations of applicable law or to testing against
infrastructure you do not control. The console runs in the customer's own Cloudflare
account, so test only against your own deployment.

---

## Risk-based remediation SLA

These timeframes run from the date a finding is confirmed (that is, triaged and
reproduced, not merely reported).

| Severity  | Definition (examples)                                         | Target remediation  |
|-----------|---------------------------------------------------------------|---------------------|
| Critical  | RCE, authentication bypass, plaintext key exfiltration        | 2 business days     |
| High      | Privilege escalation, authentication downgrade, data exposure | 7 calendar days     |
| Medium    | Defence-in-depth bypass, CSP weakness, SSRF vector            | 30 calendar days    |
| Low       | Missing header, documentation gap, informational finding      | 90 calendar days    |

**Exception path.** Where the fix requires a coordinated release (for example a
Content Security Policy change that must be tested across multiple browser engines),
the target may be extended by up to 30 days with a written internal risk-acceptance
record. No extension applies to Critical or High findings.

**Severity assignment** follows the CVSS 4.0 base score, adjusted for the in-account
architecture (a finding that requires a prior Cloudflare account compromise is
down-scoped accordingly).

---

## Supported versions and branches

| Branch / tag | Status           | Notes                                    |
|-------------|------------------|------------------------------------------|
| `main`      | Supported        | All security fixes land here first       |
| Tagged releases | Supported for 90 days after tag | Fixes backported on request for Critical/High |
| Older releases | Not supported  | Upgrade to the latest tag                |

Deployments are manual. There is no automatic rollout; operators are responsible for
pulling and deploying fixes within the SLA window above.

---

## Dependency vulnerability handling

### Detection

Three automated mechanisms run on every push and pull request against `main`
(`.github/workflows/ci.yml`):

1. **`npm audit --omit=dev --audit-level=high`** (the `security` job) scans
   production dependencies and fails the build on any High or Critical advisory.

2. **`scripts/dependency-advisory-gate.mjs`** (the same job) audits **both** trees
   and grades them separately against `.github/dependency-advisories.json`. The
   production tree is a hard gate at High and above with no acknowledgement path of
   any kind. The build tree is ratcheted rather than gated at a severity: every
   advisory it carries must be written down with the version that fixes it, whether
   that fix is reachable from this repository, and a reason a reader can check, and
   an advisory that is not written down fails the build. An acknowledgement whose
   fix **is** reachable carries a review date and fails once that date passes, so a
   deferral comes back on a known day rather than becoming permanent. An
   acknowledgement the tree no longer carries also fails, so the list cannot rot.
   The gate prints the acknowledged advisories in full, and the questions it does
   not answer in full, on every run whatever the verdict.

3. **Dependabot** (`.github/dependabot.yml`) opens weekly pull requests for both
   `npm` packages and GitHub Actions pins, keeping the supply chain current. It is
   the only channel here that sees the GitHub Actions ecosystem at all: `npm audit`
   reads `package-lock.json` and cannot see a pinned action.

The `step-security/harden-runner` action is pinned to a full commit SHA in every
workflow job, and `actions/checkout` is run with `persist-credentials: false`, so
compromised upstream action tags cannot inject credentials.

**What these three do not cover**, stated here because a green build is otherwise
read as more than it is. `.github/workflows/dependency-review.yml` is present and
reviews nothing: every run fails with "Dependency review is not supported on this
repository", because the action needs GitHub Advanced Security as well as the
dependency graph on a private repository. The licence allow-list it carries is
therefore a statement of intent rather than a control. GitHub code scanning and
secret scanning are off at the repository setting; the `secret-scan` job runs
gitleaks over the full history independently and blocks on a finding, so the
history is scanned, and push protection is not in place. The full list, with the
measurement behind each line, is the `notCovered` block of
`.github/dependency-advisories.json`, which the gate prints on every run.

### Response

- A production-tree finding at **High or Critical** blocks `CI Success` and
  therefore blocks merge. It must be resolved before any code lands. There is no
  override: the production tree is bundled into `public/app.js` and runs in the
  operator's browser beside the key material.
- A **new** build-tree advisory at any severity blocks `CI Success` until it is
  either fixed or written into `.github/dependency-advisories.json` with the reason
  it is still there. The build tree is in scope because it is where the code that
  bundles and deploys the shipped Worker runs, which is why its advisories are
  recorded rather than filtered out.
- **Medium and below** advisories in the production tree do not block CI but are
  reviewed in the weekly Dependabot sweep and remediated within the SLA above.
- Dependabot PRs for security advisories are reviewed and merged within the
  applicable SLA window. Non-security version bumps are reviewed weekly.

### Crypto dependencies

The console's cryptographic dependencies (`@noble/curves 2.2.0`,
`@noble/post-quantum 0.6.1`, exact-pinned in `package.json`) implement the key
ceremony: generating the X25519 + ML-KEM-1024 recipient key pair and the
Ed25519 + ML-DSA-87 signing key pair used by the engine. Advisories against these
libraries are treated as **at least High** regardless of the CVSS base score,
because a break directly affects the integrity of every key the operator generates.

---

## Security architecture summary

This section records the controls that are actually implemented, so that a
security review can quickly locate the relevant source.

**Authentication.** The console is a static SPA served by a Worker
(`src/worker.ts`). It makes no authentication decisions itself: all admin API calls
are authenticated by the engine's Cloudflare Access JWT or `ADMIN_TOKEN` bearer
mechanism. The console attaches the bearer only in the `authorization` HTTP header,
never in a URL or query string.

**Key ceremony.** The break-glass private key is generated in-browser using
`crypto.getRandomValues` and offered as a download. It is never POSTed to the
engine, never written to `localStorage` or `sessionStorage`, and is cleared from
memory on confirmed save or sign-out. The key generation logic is in
`src/keygen.ts` (`runKeyCeremony`, `makeRecipient`, `makeSigner`); the screens
that invoke it are `src/screens/onboarding-ceremony.ts` (the first-run wizard)
and `src/screens/keys.ts` (the Keys screen, which also hosts rotation and
offline recovery guidance).

**Client-side storage hygiene.** `localStorage` holds only the operator-selected
theme (`dp-theme`, written by `src/lib/theme.ts`) and the engine URL
(`dp-engine-url`, written by `src/lib/store.ts`): no token, no key material,
no PII. The in-memory ceremony key material is held in `state.ceremony` and
nulled by `clearSensitiveState()` in `src/lib/store.ts`.

**Content Security Policy.** Every console response carries a strict hash-based
CSP assembled by `buildCsp` in `src/worker.ts`. The policy is:

- `default-src 'self'`: all resource types default to same-origin.
- `script-src 'self' <sha256-hash>`: same-origin bundle plus a single
  sha256 hash (`CSP_SCRIPT_THEME_HASH`) for the one sanctioned inline
  pre-paint theme script in `public/index.html`; no `'unsafe-inline'` and
  no `'unsafe-hashes'`.
- `style-src 'self'`: same-origin stylesheet only; dynamic styling is
  applied via the CSSOM, which CSP does not gate.
- `connect-src 'self'`: a single, env-independent value. The console proxies
  the engine over a same-origin service binding, so every browser call is
  same-origin and no engine hostname is pinned: there is no split topology and
  no `ALLOWED_ENGINE_ORIGIN` branch (`buildCsp` hardcodes `'self'`).
- `img-src 'self' data:`, `font-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
- `report-uri /csp-report` + `report-to csp-endpoint`: violations are reported
  to a same-origin 204 sink; the `Reporting-Endpoints` response header names the
  endpoint group.

There are no third-party scripts, CDN resources, or analytics.

**Transport headers.** HSTS, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` are applied to every
response.

**Key-ceremony validator.** CI runs `npm run validate:keygen`
(`test/validate-keygen.ts`) on every push. This exercises the full keygen code path
(`src/keygen.ts`) offline and fails the build if the key ceremony produces keys that
are the wrong length, or whose x25519, ML-KEM-1024, Ed25519, or ML-DSA-87
round-trips do not verify. It does not test localStorage behaviour.

---

## Known open findings

The console's most recent OWASP ASVS 5.0 assessment records the current finding set. The open items most relevant to the console are:

- **GAP-05 (medium):** No self-service session enumeration or termination
  (the console cannot invalidate a Cloudflare Access edge session;
  this is an architectural delegation, not a bug in the SPA).
- **GAP-06 / GAP-07 / GAP-08 (low):** Session lifetime and concurrent-session
  policy not yet documented.

These are tracked and being addressed. If you believe you have found an exploitable
path that builds on these, please report it privately rather than assuming it is
already known.
