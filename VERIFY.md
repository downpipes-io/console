# Verify that a release is what it claims to be

You do not have to trust us. This document lets you confirm, yourself, that a downpipes console
release was built by CI from the tagged source in this repository and published byte-exactly on
the update channel.

## What this proves, and what it does not

- It PROVES the artefact on the update channel is byte-for-byte the artefact you get by building
  the tagged commit yourself, and that CI attested exactly those bytes.
- It does NOT prove the source is benign. A defect written into the source reproduces perfectly.
  Reading the source is the separate assurance that covers that.
- It does NOT prove real-time runtime execution. Cloudflare Workers exposes no hardware
  attestation of the running isolate. The console verifies its own bundle identity against the
  signed channel at apply time and records the verdict; between applies you trust the Cloudflare
  control plane and whoever can access your own account, the same trust every Worker you run
  already carries.

## Release integrity

This repository's own source-control and build gates sit upstream of everything above: every
change reaches `main` through a pull request and a green CI check, `main` and release tags
require signatures, and the release workflow checks a tag's signature against this repository's
allowed-signers file before it builds. See [What protects the release
path](https://docs.downpipes.io/operations/verify-a-release/#what-protects-the-release-path) for
the full picture, including reproducible builds and the update-channel's own signing.

## Step 1: rebuild the artefact from the tagged source

```bash
git checkout vX.Y.Z
npm ci
node scripts/build-release-bundle.mjs > release-facts.json
# prints { version, sha256, ... }; writes dist/console-X.Y.Z.json
sha256sum dist/console-X.Y.Z.json
```

The build is a deterministic function of the committed source; `npm run validate:bundle` proves
the committed `public/app.js` byte-matches a clean rebuild on every push.

## Step 2: verify the cosign signatures and SLSA provenance

Every release carries a cosign bundle per file and an SLSA provenance attestation:

```bash
cosign verify-blob --bundle dist/console-X.Y.Z.json.cosign-bundle \
  --certificate-identity-regexp '^https://github.com/downpipes-io/console/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  dist/console-X.Y.Z.json

slsa-verifier verify-artifact dist/console-X.Y.Z.json \
  --provenance-path console.intoto.jsonl \
  --source-uri github.com/downpipes-io/console
```

The keyless signature and its certificate are logged in the public Sigstore Rekor transparency
log, so a signature served to you and hidden from everyone else is detectable.

## Step 3: read the account's own record

The engine's `GET /admin/status` and the console's Licence and updates screen show the digest the
account applied and cross-check it against the published release record. See
[docs.downpipes.io/operations/verify-a-release](https://docs.downpipes.io/operations/verify-a-release)
for the full guided path.
