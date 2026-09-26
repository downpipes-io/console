# Contributing to downpipes/console

The console is the in-account management GUI for the downpipes platform: onboarding, the
key ceremony, downpipe and source management, schedules, run status and the restore
drill. It runs in the customer's own Cloudflare account and talks ONLY to the in-account
engine admin API.

## Contributor Licence Agreement

Pull requests are accepted only from contributors who have signed the
[Contributor Licence Agreement](CLA.md). State that you accept it in the description of your first
pull request; the maintainer records the acceptance and you only do it once.

## Non-negotiables

- No custody, no vendor inbound. The console never sends a key or customer data to the
  vendor. It calls the in-account engine only.
- The key ceremony generates the break-glass identity in the browser and the operator
  keeps the PRIVATE half offline; it is never uploaded to the engine or the vendor. Only
  the break-glass PUBLIC key (and the signer) go to the engine. The recovery sheet states
  this in plain language.
- Custom domains only. No `*.workers.dev`.
- Surface the cost truth: a high-frequency full re-read of a large KV namespace is the
  bill-shock risk; the schedule picker shows the projected cost and steers KV off hourly.

## Style

Australian English. The crypto in the key ceremony reuses the pinned
@noble/post-quantum and @noble/curves, in the same
byte encodings the engine and the Go offline tool use; `npm run validate:keygen` proves
the generated keys are well-formed and sound.

## Commits

Short, imperative, scoped subject lines, for example `keys: clear ceremony state on
sign-out`. Describe the change and the reason, not the process that produced it. Keep
each commit focused on one logical change so review and revert stay simple.

## Pull requests

Open a pull request against `main`. Before you push:

- run `npm run typecheck` and `npm run lint`;
- run `npm run validate` when you changed `src/` or `public/app.js` (the validator suite
  includes the CSP-hash and bundle-drift gates);
- rebuild the bundle if you touched `src/app.ts` or anything it imports, because the
  committed `public/app.js` is the artefact the worker serves;
- keep the change small and describe what it changes and why in the PR body.

Every push and pull request against `main` runs the CI workflow
(`.github/workflows/ci.yml`): type check, the validator suite, the bundle-drift gate
and a production-dependency `npm audit`. The `CI Success` check must pass before a
change can merge.

## Developer Certificate of Origin

This project uses the Developer Certificate of Origin (DCO). Sign off every commit to
certify you wrote the change or have the right to submit it under the project licence:

```
git commit -s
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. Commits without a
sign-off are rejected.
