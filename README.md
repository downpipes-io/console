<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/downpipes-mark-light.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/downpipes-mark-dark.svg">
    <img alt="downpipes" src="./assets/downpipes-mark-dark.svg" width="96">
  </picture>
</p>

<h1 align="center">downpipes/console</h1>

<p align="center">The in-account console for downpipes. Every action in the browser; nothing for customers to run in a terminal after deploy.</p>

<p align="center">
  <a href="https://github.com/downpipes-io/console/actions/workflows/ci.yml"><img src="https://github.com/downpipes-io/console/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/downpipes-io/console"><img src="https://api.scorecard.dev/projects/github.com/downpipes-io/console/badge" alt="OpenSSF Scorecard"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/licence-Elastic--2.0-blue" alt="Licence Elastic 2.0"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/bundle-1.2%20MiB%20%2F%20358%20KiB%20gz-brightgreen" alt="Bundle size">
</p>

The management console for the [downpipes](https://downpipes.io) backup platform. It runs in your own Cloudflare account, serves a static single-page app on a custom domain, and its data source is exactly one API: the in-account engine's `/admin` surface. There is no vendor inbound path and no custody of keys or data. (One optional, operator-triggered exception: the release-provenance check reads the published update-channel record.)

## What it does

- **Onboarding and the key ceremony.** A guided wizard connects the console to your engine and runs the ceremony: the break-glass identity is generated in your browser, the private half is saved offline by you (with a printable recovery sheet), and only public keys go anywhere. The configure step shows the exact `wrangler.toml` wiring and `wrangler secret put` commands for the engine, then polls `GET /admin/status` until the signer, break-glass key and destination all report present. The console cannot write the engine's secrets; the poll is the proof your commands took effect.
- **Sources and downpipes.** Attach sources, then create downpipes (source, include and exclude selectors, schedule) singly, in bulk, or many-to-many across sources and destinations, with a live cost projection that flags expensive schedules before you commit them.
- **Runs, restores and drills.** Run history with receipts, a restore flow that dry-runs and verifies a sealed archive before anything is written back, granular and table-level restores, and restore drills that prove recoverability on a schedule. Restore sits on the recovery path and is never gated by the licence.
- **Assurance surfaces.** The Security Centre (posture checks with honest severities and operator-visible overrides), a topology map of sources, downpipes and destinations, canary flight results, compliance evidence packs, and the tamper-evident audit log with a verify-chain action.
- **Integrations and updates.** Alert routing to notification and SIEM destinations (auto-parsing first: Slack, Teams, PagerDuty, Splunk, Datadog, Elastic and the wider catalogue at [downpipes.io/integrations](https://downpipes.io/integrations/)), plus the update channel: applying a signed engine and console update is one paste and one confirm, success-or-rollback.

## Security model

The break-glass private identity is generated in the browser and never leaves it except as a file you save offline; the engine and the vendor only ever see the break-glass public key, so a compromise of the live account cannot read past archives. The run-signer private key does go to your in-account engine, because the engine signs every run; the recovery sheet and the configure step both state this plainly. The operational private key is optional and crosses to the engine only if you opt in to in-account restore; left offline, the engine runs in a break-glass-only posture and every drill and restore reports that recovery is exercised offline with the break-glass key.

Every server-supplied string is HTML-escaped before it reaches the DOM, the strict CSP allows only same-origin external scripts, and the console's data path talks only to your in-account engine admin API.

## Architecture

A deliberately boring, auditable shape: one static Worker serving one esbuild bundle (no UI framework: vanilla TypeScript plus the pinned @noble crypto libraries; canvas-rendered visualisations; 1.2 MiB / 358 KiB gzipped), plus the engine's admin API as the single data source. The committed`public/app.js` is the built artefact the worker serves, and the validate chain includes a determinism guard proving the committed bundle byte-matches a clean rebuild.

```bash
npm install
npm run validate    # the full chain: 73 validators as of July 2026, including the bundle-drift guard
npm run typecheck
npm run build       # esbuild via scripts/stamp-build.mjs; validate:bundle proves the committed bundle byte-matches
```

Validators drive real behaviour rather than mocks where it matters: the key ceremony produces keys byte-compatible with the engine and the Go reader (`validate:keygen`), the freshness table is exercised across its real mount, fill and poll lifecycle, cost projections are checked against the model, and accessibility contrast is enforced as a gate.

## Deployment

The console deploys to your own account on a custom domain (never a `workers.dev` address), typically behind Cloudflare Access:

```bash
npx wrangler deploy
```

This repository ships two Wrangler configs: `wrangler.toml` is the one you edit and deploy from for your console, and `wrangler.dev.toml` is a template for a second, non-production instance you can stand up alongside it, pointed at a non-production engine.

The guided path, including pairing and the discovery token, is the docs quickstart: [docs.downpipes.io/start-here/quickstart](https://docs.downpipes.io/start-here/quickstart).

## The downpipes family

| Repository | What it is | Licence |
|------------|-----------|---------|
| [`engine`](https://github.com/downpipes-io/engine) | The in-account backup Worker: capture, seal, schedule, restore | Elastic 2.0 |
| `console` (this repo) | The in-account management console; every action in the browser | Elastic 2.0 |
| [`downpipe`](https://github.com/downpipes-io/downpipe) | The offline Go reader: verify and recover archives with no vendor | MIT |

Docs live at [docs.downpipes.io](https://docs.downpipes.io), and you can mount them in your AI tooling: [use the docs in your agent](https://docs.downpipes.io/reference/connect-docs-to-ai). The product site is [downpipes.io](https://downpipes.io).

## Verify a release

Every tagged release is reproducible and signed. See [VERIFY.md](VERIFY.md) for the exact
commands to rebuild the bundle from source and check its cosign and SLSA attestations.

## Support and security

General support: support@downpipes.io. Report a vulnerability by email rather than a public
issue; see [SECURITY.md](SECURITY.md) for the address and what to include.

## Licence

Elastic License 2.0 (ELv2). See [LICENSE](LICENSE).

Free to use, modify and self-host in your own account. You may not provide the software to third parties as a hosted or managed service.
