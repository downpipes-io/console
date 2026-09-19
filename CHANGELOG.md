# Changelog

All notable changes to the console are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
on a `0.x.y` line while the platform is in active development.

The console is the in-account management UI for the downpipes platform. It carries no
archive-format version of its own; the on-disk archive format (`downpipe/0.1.0`) is
versioned independently in the `downpipe` repository's `docs/format/SPEC.md`. The
identifier is a key-derivation label rather than a name, so a stale copy of it here does
not misname anything, it describes keys that derive to different bytes.

## [Unreleased]

## [0.2.6] - 2026-09-21

The first release built and attested by the public release workflow. It carries
everything below and the 0.2.5 changes, which were tagged on 17 September but never
released.

### Changed

- The two session sign-out confirmations (this session, every other session) now say that
  a passkey prompt may follow, and that dismissing it or failing it signs nothing out.
- The first public CI run is green on a standalone clone.
- Dead compatibility re-exports removed; every consumer already imported the real definition.

### Dependencies

- TypeScript 7.0.2 compiles the console (as the `typescript-7` package); TypeScript 6 stays
  installed under its own name for the tools that still need the JavaScript compiler API.
- c8 12, with the branch-coverage gap it exposed closed by tests rather than a lower floor.
- esbuild 0.28.2 and fast-check 4.10.0.
- @noble/hashes 2.4.0, @noble/curves 2.4.0 and @noble/post-quantum 0.7.1.
- wrangler 4.131.2, @cloudflare/vitest-pool-workers 0.22 and @cloudflare/workers-types 5.
- Biome 2.5.14, with its new optional-chaining rule satisfied at the sites it names.
- knip 6.36.
- GitHub Actions pins advanced to their current releases.

## [0.2.5] - 2026-09-17

Tagged but not released: the tag arrived in the same push that created the release
workflow, so no artefacts were built and nothing was attested. Its changes ship in 0.2.6.

### Added

- Access and security lists every live session for the account, with a Sign out on each,
  and can end one session on its own.

### Changed

- A stale Cloudflare Access caller is sent back through Access instead of being shown the
  passkey sheet, and a step-up that ends without a passkey is named as such.
- A pasted admin token is exchanged for a minted session and then discarded; the token
  itself is not kept in the browser.
- Every console file picker refuses a file above 64 KiB before reading it.
- The console's browser storage for a session is cleared on every ending, including one
  the server initiates.
- Requests carrying hop-by-hop headers are refused before routing, and every text response
  the console originates declares its charset.
- The break-glass prune panel states exactly what it sends.

## [0.2.4] - 2026-09-07

### Changed

- The Licence screen explains that binding completes after the first source attach or
  update while the engine's account is not yet known, instead of warning about a
  different account.

## [0.2.3] - 2026-09-07

### Changed

- A self-serve licence now binds to the Cloudflare accounts that activate it, up to
  the band's estate count, so activation no longer warns about a different account.

## [0.2.2] - 2026-09-07

### Fixed

- Every one-shot deploy token prompt whose token redeploys the engine now states that an
  engine which binds a Secrets Store secret needs the Secrets Store permission added to
  the template.
- The apply progress panel now recognises a console-only update as finished, instead of
  reporting an unexpected outcome.

## [0.2.1] - 2026-09-06

The first console rebuild since 0.1.10 (2026-07-04); the component had been carried
forward unrebuilt through the 0.2.0 engine release.

### Added

- A new Integrations screen lists every SIEM, observability, ITSM and notification
  destination as logo tiles in one place, showing at a glance which are connected, off,
  or available to add.
- SIEM log push (Splunk HEC and other common formats), OTLP metrics push, and
  pull-based feeds for Prometheus, Microsoft Sentinel, Cribl and Exabeam can now be
  configured and monitored from the console.
- Restoring a Cloudflare D1 database supports restoring a subset of tables, and media
  and object restores can be queued and tracked per item with self-identifying labels.
- Break-glass key recovery: an M-of-N Shamir key quorum can be reassembled and
  downloaded directly in the browser, without a command line.
- Azure Blob Storage can be added as a destination from the console, alongside
  Cloudflare R2, Amazon S3 and Google Cloud Storage.
- Licences activate with a short claim code sent by email, exchanged for the signed
  licence token, instead of pasting the token by hand.
- Multi-destination backup cost estimates now sum storage, write and restore/drill
  costs across every destination in a 3-2-1 setup, not only the primary.

### Fixed

- Security Centre, including passkeys, recovery codes and the owner-approval inbox, is
  reachable immediately after deploy, rather than only after the guided setup
  (destination, source, first downpipe) is finished. This was blocking retirement of the
  one-time setup token on a brand new account.
- Adding a second destination next to the default Cloudflare storage created at deploy
  time now shows that default destination honestly, labelled as the deploy-time binding,
  with no Replace option offered since it holds no separate credential to replace.
- The support pack panel explains how to get a ticket reference by email before it asks
  you to attach the pack to a ticket.
- Self-serve licence bands now display by their names on the Licence card and the
  Overview tile.

### Security

- After a forced passkey re-enrolment, the console now requires the operator to confirm
  they have saved their new recovery codes before the previous codes are retired.

## [0.1.0] - 2026-06-21

### Added

- Root `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `.editorconfig`, issue and pull-request
  templates, and a `.well-known/security.txt` disclosure endpoint.

### Changed

- `CONTRIBUTING.md` now documents commit conventions, the pull-request process and the
  Developer Certificate of Origin sign-off, and no longer claims CI is out of scope.

### Removed

- Stray `coverage/` output that had been tracked in version control despite the ignore
  rule.

[Unreleased]: https://github.com/downpipes-io/console/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/downpipes-io/console/releases/tag/v0.2.6
[0.2.5]: https://github.com/downpipes-io/console/releases/tag/v0.2.5
[0.2.4]: https://github.com/downpipes-io/console/releases/tag/v0.2.4
[0.2.3]: https://github.com/downpipes-io/console/releases/tag/v0.2.3
[0.2.2]: https://github.com/downpipes-io/console/releases/tag/v0.2.2
[0.2.1]: https://github.com/downpipes-io/console/releases/tag/v0.2.1
[0.1.0]: https://github.com/downpipes-io/console/releases/tag/v0.1.0
