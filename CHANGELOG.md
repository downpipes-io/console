# Changelog

All notable changes to the console are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
on a `0.x.y` line while the platform is in active development.

The console is the in-account management UI for the downpipes platform. It carries no
archive-format version of its own; the on-disk archive format (`downpipe/0.1.0`) is
versioned independently in the `downpipe` repository's archive format specification. The
identifier is a key-derivation label rather than a name, so a stale copy of it here does
not misname anything, it describes keys that derive to different bytes.

## [0.2.9] - 2026-10-11

### Added

- The Updates section of the Licence and updates screen shows an end-of-support notice for the running
  engine. A release is supported until 90 days after the next release ships. The notice shows from 30 days
  before that date (a warning) and after it (a danger notice), from the engine's `supportedUntil` and
  `supportStatus`. Nothing shows for the latest release, or when the engine sends neither field.
- The audit trail labels the `runlog-resumed` action: "Backup RUNLOG signature file restored by an Owner".

### Changed

- On the map, a destination that is reached on every pass but holds no run reads "no restorable copy yet",
  not partial.
- On the SAML connection form, the trust-idp note names the routes to the privileged roles: Access admin,
  Approver and Restore operator need a group mapping, a connection that verifies the email, a passkey or
  Cloudflare Access; Owner needs one of the last three, because a group cannot confer Owner.
- On the cost estimate, the inputs card and the destination pricing card are the same height in the
  two-column layout, and the offline recoveries field has a full-width row.
- Dependency install scripts are off, and the install guide uses `npm ci`.

### Dependencies

- Biome 2.5.15, knip 6.39.0, wrangler 4.145.0 and @cloudflare/workers-types 5.20261001.1.
- source-map-js 1.2.2, smol-toml 1.9.0 and brace-expansion 5.0.12 in the build tooling, set through npm `overrides`.

## [0.2.8] - 2026-10-05

### Added

- With engine 0.3.7, the "Sources attached" and "Sources detached" audit rows name the bindings that
  changed.

- The audit log shows "Support bundle downloaded" rows from engine 0.3.7, one for each support bundle
  you download or generate. Each row says if the engine sealed the bundle to the vendor key.

- The audit log names two new actions from engine 0.3.7: "Notification channel changed" and
  "Notification rule changed". The filter offers them in a Notifications group. Each row shows the change
  kind and the channel or rule id, never the URL.

- The audit log names "Passkey enrolled from an invite" rows from engine 0.3.7, in the Identity and
  sign-in group. A notification rule can select the "Owner demoted by SCIM" alert.

- The key ceremony now generates the configuration recovery key and the configuration wrap key, in both
  postures, and the install writes them to your engine with the signer. Your engine can then rebuild its
  own settings from its sealed configuration export, and the credentials this console stores are
  encrypted at rest. Neither key is a file to save, and an engine that already holds one keeps it.
- The Keys screen offers "Add configuration keys" when your engine has a signer but lacks either key. It
  installs only the missing keys and never touches your signer, break-glass key or operational key.
  When it adds the wrap key, the card says how many saved credentials your engine encrypted in the same
  step, and names the kinds it could not encrypt, which you then save again.
- The restore plan shows which live Workers KV keys and R2 objects an apply would replace, with up to 20
  names, and each sampled row says what is in the target now. "Keep live keys that already exist" on the
  restore form keeps them instead. Needs engine 0.3.7. Against an older engine, which would ignore the
  choice and replace the live keys, the plan says so and offers no approval request and no apply.
- The receipt of a restore that kept live keys lists them as kept, as you chose, and does not count
  them as records outstanding.
- The command palette finds a downpipe's audit trail by the downpipe's name. Type the name and choose
  the "Audit log for" row for that downpipe to open the audit log filtered to it. You need permission to
  read both downpipes and the audit log.
- Each pull credential on the Support settings and on the pull integration tiles has an "Expires after
  (days, optional)" field. You can set the term of the next mint up to the cap for its scope: 7 days for
  vendor diagnostics, 365 days for the SIEM audit feed and 400 days for metrics. If you leave it blank,
  the engine uses the default for the scope, as before. Before this change, every mint got the default.
  When dual control queues the mint, the field keeps the term, and the panel tells you to mint again with
  the same term after the second owner approves, because the approval applies to that term only.

- `RECOVER-SPLIT.txt`, which the M-of-N split downloads, now states the share format: the field and
  its polynomial, the x values, the line syntax of each file, what the share and checksum lines encode,
  and the AES-256-GCM envelope. A compatible Shamir tool can then recover the key without the console.

- A failed run's detail drawer on the Runs screen shows a Support reference: the short one-way digest
  that the engine stamps on the failed run and on its log line for the same fault. Quote it when you raise
  a failed run. A run from an engine that does not record the digest shows no reference.
- The audit log shows until when a time-boxed role grant or custom-role assignment runs, and which
  email-trust policy (require-flag or trust-idp) a new SAML connection has. Needs engine 0.3.7. Events
  from an older engine do not carry these values and show as before.
- The Generic OAuth2 form shows six optional fields from engine 0.3.7: scopes, email URL, email field,
  email-verified field, groups URL and group name field. The "How to add Generic OAuth2" guide tells you
  to find the email endpoint and scopes, because sign-in needs an email address. Before, a Generic OAuth2
  connection had no email source, and the engine refused every sign-in through it.
  On an older engine the form has no such fields, and the guide says that the engine refuses every
  sign-in through this preset and asks you to update the engine first.
- The SAML trust-idp warning and the SAML guide now say that the email-trust choice is recorded in the
  audit log from engine 0.3.7. An older engine does not record it.
- Setup at `/setup` is the first run. It asks one question at a time, in this order: Welcome, Connect
  (the read-only token), Destination, Protect, Keys, Apply (one deploy
  token installs the keys and attaches the sources), First backup and Finish. "Your backup plan" beside
  it lists each decision as you make it, and at Finish it becomes a receipt you can print. "You are
  protected" shows only after the engine verifies the seal of the first backup. The team invite is at
  `/setup/team`. A console that finished setup before this version is not sent back to it.
- The Costs screen has an "Offline recoveries per month" input, a whole number with a default of 0. The
  projection prices each offline recovery as a download of the full archive at your egress rate.
- The recovery sheet prints a restore command that uses `--signer-fingerprint` with the signer
  fingerprint from your key ceremony, then the `--signer signer.pub` command. It says when the sheet is
  not enough on its own: no engine 0.3.7 or later has written to the bucket, or you re-keyed after the
  sheet. The Offline recovery panel on the Keys screen shows the same two routes. The fingerprint-pinned
  restore needs reader 0.3.4.
- The audit log names two more engine actions: "Configuration keys added" and "Support pulled
  diagnostics".
- The SAML form shows an "Email verified attribute" field when you choose require-flag, and you cannot
  add the connection without it. The form sends it as `emailVerifiedAttr`.
- The identity-provider list shows trust-idp with a neutral badge. A require-flag connection with no
  verified attribute shows a warning badge that says it admits nobody.
- The Generic OAuth2 form shows a note once you set the Email field and leave the Email-verified field
  blank: an invite on that connection binds only Viewer, Operator, or a custom role with no people, access
  or approval permission.
- The Keys screen's Posture tab has a "Destination RUNLOG signature" section. It shows a signer re-key's
  RUNLOG hand-over progress and the hold on new runs. An Owner can check a destination's RUNLOG signature
  and re-sign a RUNLOG that does not verify, after reading the digest of the stored bytes. "Anti-rollback
  floor" lets an Owner check and reset a destination's floor, and "Chain anomaly" lets an Owner check and
  relink one downpipe's chain. Each action needs a passkey and a typed confirmation.
- The audit log names "Backup RUNLOG handed over to the new signer", "Backup RUNLOG re-signed by an Owner",
  "Backup RUNLOG floor reset by an Owner" and "Backup RUNLOG chain relinked by an Owner". A notification
  rule can select the matching alert events.
- The audit log names "Scheduled prune armed with no second approver", and a notification rule can select
  its warning alert. The audit log also names "Refused requests over the hourly limit".
- The Licence and updates screen's Provenance section shows the update-signer fingerprint, the key the
  engine verifies updates with, beside the declared release-signer pin. When the pin does not match, it
  shows the engine's warning, which names the fix.

### Changed

- On a large fleet, the Downpipes list reads run history for the rows on screen first. An enabled
  downpipe that has run shows Loading in State until the list reads its run history.

- While a status filter is on, a note on the Downpipes list counts the downpipes whose run state is still
  loading. Each one that matches the filter joins it when its run state loads.

- The SAML guide tells you to keep Email trust on trust-idp unless your IdP sends a verified-email
  attribute.

- When a paste in the Licence token box does not have the shape of a licence token, the message now also
  says that your licence email gives a claim code, not a token, and that the claim code goes in the Claim
  code field above. A claim code put in the token box gets this message.

- The recovery sheet no longer asks you to keep a copy of `CONFIG_WRAP_KEY`. It says the ceremony
  generated it and installed it to your engine, and that losing it costs a re-entered credential, never
  an archive.

- The key ceremony no longer downloads `signer.key`, in setup or on the Keys screen.
  The signer private installs straight to your engine, as the operational private does, so no copy of
  your signing key stays on the machine that ran the ceremony. `identity.key`, `recipient.pub` and
  `signer.pub` still download.

- The in-console Keycloak guide now says that when the ID token carries `realm_access.roles`, the engine
  maps on those roles only and ignores the `groups` claim. It no longer tells you to add the realm-roles
  mapper as well as the groups mapper.

- The identity provider guidance on the Access and security screen no longer says that, without
  Cloudflare Access, the engine cannot tell who made a call. Passkey and native SSO sign-ins are also
  attributable. The sentence now applies to the shared admin token only.

- The Auto-refresh hint on Settings, Accessibility now names all four screens that the preference
  controls: Overview, the Topology map, the Security centre and the Downpipes list. It also says that the
  Downpipes list refreshes every 4 seconds while a run is in progress.

- The "The engine refused this on authority" message no longer says that the audit log records the
  refusal. The engine's authority check counts the refusal in its diagnostics, and the support bundle
  includes that count. The message now says so. On some actions the audit log also records the attempt
  as failed, but not on all of them.

- The "Turn on outbound email" how-to in setup sends you to Compute, Email Service, Email Sending to
  onboard the sender domain, which is what the engine needs. It no longer names Email Routing, and it
  says that invite emails also need `INVITE_EMAIL_FROM`.

- The offline-key posture statement is now `key-posture-ack/v3`. It no longer says the engine proves its
  test data recoverable every hour. It says the engine does this on its canary schedule, hourly by
  default, while the canary is on. It also names this console, as well as the offline reader, as a way to
  prune your archives. Needs engine 0.3.7, which records `v3` and refuses `v2`.

- The Config approvals inbox shows pending changes only, which is all the engine sends. An approved or
  rejected change leaves the inbox, in the demo as against a real engine. The config history screen
  shows the configuration versions that the engine records after it applies a change.

- The create wizard no longer holds a hidden token field and a "Protect and continue" step that no
  source could open. Every source the wizard offers is already attached or is read with the discovery
  token. To protect a source that is not attached, add it under Sources first.

- Hints and messages across the console, including the component descriptions on the Licences screen,
  say what the console and engine do. Many hints are shorter and link to the docs page that explains
  them.

- When a claim code finds no free estate on the licence, the message says to contact
  support@downpipes.io to add one. It no longer tells every licence holder to buy a larger Business band.

- A retention prune result counts the objects that are only hidden behind a delete marker, whose bytes
  the bucket keeps, and the deletes the destination refused, apart from the objects reclaimed. Needs
  engine 0.3.7, which reports those counts.
- The "Add a SAML 2.0 provider" form now defaults Email trust to trust-idp. Before, it defaulted to
  require-flag and had no field for the verified attribute, so a connection built with the default
  admitted nobody. A note under the picker says which roles an emailed invite can receive: on trust-idp,
  only Viewer, Operator, or a custom role with no people, access or approval permission; every role,
  including Owner, binds under require-flag once the attribute is set.

### Fixed

- The Offline recovery panel on the Keys screen printed verify and restore commands that passed
  `--receipt-signer signer.pub`. The reader takes a signer private-key file there, so each command
  stopped with exit 6 before it checked anything. The commands no longer pass the flag. The panel says
  how to sign a receipt with `--receipt-signer` and a signer private-key file.

- "Sign out everyone" no longer says that it invalidates every recovery code. Recovery codes are
  verified with a separate key and keep working, and the warning, dialog and message say so.

- The S3 drop hint and the push destination line say that each batch is one object in the format you
  chose, keyed with that format's extension. They said the drop always writes NDJSON.

- The syslog-over-TLS hint no longer says that a private address is accepted. The engine refuses one.

- The Destinations screen names the lock mode of an enforced Object Lock. Under governance mode it says
  that a principal with the bypass permission can shorten or remove the retention. When the store
  refused the verification's cleanup delete, the note says that the credential is not allowed to delete,
  which is not a lock. It called that refusal an object lock.

- A run's Tier-0 break-glass cause in the Runs drawer says how to tell an older run from a
  break-glass-only downpipe with sliced runs off, which records the cause on every run.

- The dialog that turns off the new-location sign-in notification says that the per-operator history is
  kept. It said the history expires.

- Choosing Custom pricing on a Costs destination keeps the rates already set, and says that a rate left
  at 0 prices that cost at nothing. Before, choosing Custom set all four rates to 0.

- Adding a group mapping for a group that already has one says that the mapping is replaced. It said
  "added".

- The Observed cost seed takes runs a month from each downpipe's schedule, as the engine runs it. It
  pooled the gaps between all runs, manual runs included, so a burst of manual runs projected thousands
  of runs a month. The Manual cadence presets count the engine's early starts in the same way (Daily is
  33.6 runs a month).

- The protection statement shows a deferred scheduled restore test (no completed backup, no records, or
  a break-glass-only key posture) as deferred, not as a failed test.

- The config approval and change number switches in the Security centre read "Unavailable", with a way
  to try again, when the engine's policy reply does not include the setting.

- The governance posture strip on the Access and security screen counts the optional controls and the
  controls not enforced server-side apart.

- The Destinations screen no longer shows a bucket with Object Lock on and no immutability mode as
  protected when nothing retains the archives. With engine 0.3.7 or later, the engine records if the
  bucket has a default retention rule. With a rule, the Immutability cell reads "Object-Lock, bucket
  default rule". With no rule, it reads "Object-Lock on, nothing retained" as a warning, the drawer
  and card give the two remedies, and the destination does not clear the note about an off-account
  destination with immutability. If the engine did not record the rule, the cell reads "Object-Lock,
  rule not checked" and the card tells you to save the destination again with Replace. An Azure Blob
  container is different, because the engine cannot read its default retention policy with a key or a
  SAS. Its cell reads "Object-Lock, rule not readable", and the card
  tells you to set an immutability mode. Before, all these states read "Object-Lock, no policy set" as
  ok and cleared the note.
- The member removal dialog no longer says that only an Owner's IdP confirmation is recorded. It now says
  that the console asks the engine to record the confirmation, and that you see a warning if the engine does
  not record it. With engine 0.3.7, the engine records the confirmation for every role that can remove a
  member, which is the Owner and the Access admin. With an older engine, an Access admin sees the warning.
- The canary cadence picker no longer offers "Every 5 minutes". The canary flies only from the engine's
  15-minute cron tick, so that preset flew every 15 minutes. The shortest preset is now 15 minutes. An
  interval under 15 minutes that is already stored stays selected, and its label now reads "Every 15
  minutes (set to 5 minutes)". A stored interval that is not a multiple of 15 minutes is named by the
  tick it flies on, for example "Every 15 minutes (set to 20 minutes)", on the canary screen and in the
  picker. The hint no longer says scheduled flights are always further apart than the setting: from
  engine 0.3.7 a flight starts on the tick at the end of the interval.

- The edit form of an auto-observed credential registry item no longer offers changes that the engine
  does not keep. The "No expiry / rotate on policy" box and the lifecycle select are now read-only with
  the auto-observed reason, as the label, kind and date are. The date also stays read-only after the form
  opens: before, the form made it editable again when it opened. From engine 0.3.7 the engine refuses a
  change to these fields on an observed item.

- The Require Access panel under Sessions and fallback now shows that the shared-token path is closed
  after an Owner retires the token or after you delete the `ADMIN_TOKEN` secret. Before this change, the
  panel showed "Shared-token fallback not disabled" and the close command in both cases. Needs engine
  0.3.7. With an older engine, the panel shows the earlier sentence, which says that the engine accepts
  the token unless an Owner retired it or the secret is deleted. When Cloudflare Access is not
  configured, the closed state is a warning and tells you to wire Access, as it is for
  `ADMIN_TOKEN_DISABLED`. When the engine cannot read its retire record, the panel says that the engine
  refuses the token until it can read that record.
- The audit log no longer shows a plain "Chain intact" when the engine could not check for deleted
  newest entries. When the engine cannot read its record of the chain head, the verdict is a warning
  that says the check could not run, and it tells you to export the log and investigate the store. When
  the engine also holds no entries, the verdict says that no entries are held and does not say "intact".
- The To date on the audit log filter now includes the day that you pick. The console sends the end of
  that UTC day to the engine. Before this change, it sent the bare date, and the engine left out every
  entry on that day.
- The role pickers on the Access screen (the members form and the group mapping) and in the setup team
  invite now offer only the built-in roles that you can grant. You can grant a role only when you
  hold every capability it gives, and only an Owner can grant Owner. Before this change, an Access admin
  saw Operator, Approver, Restore operator and Owner, and the engine refused each one after Save. Each
  picker now names the roles it does not offer. When you change the role of a member who holds a role
  that you cannot grant, the form tells you that saving replaces it.
- The governance grid on the Access and security screen no longer shows group-claim role mapping as
  pending on an engine that serves it. The grid now asks the engine. It marks the control enforced when
  the engine answers the group mapping route, and keeps it pending when the engine does not.
- A push that you set up from the Custom endpoint tile now stays on that tile. The console tags it
  `custom-endpoint`, so a format and delivery pair that a named vendor also uses (for example
  `splunk-hec` over `http`) no longer moves the push to that vendor's tile. Test send, Enable and Replace
  stay on the Custom endpoint tile. A push saved before this change keeps its old tile until you set it
  up again from the Custom endpoint tile.

- The canary screen names each destination that one flight does not reach. A flight goes to 12
  destinations at most, and before this change the rest had no row and no mention, and the status read
  "all 12" on an account with more. The status now reads, for example, "12 of 15".

- The schedule hint in the create wizard and the bulk import no longer says a run is never late. The
  cadence is a ceiling on the due time: a run can come early, and it normally starts at the next 15-minute
  tick. A tick that runs low on budget carries a due run to the next tick.

- A custodian sign-off now needs a holder. Before this change, a holder typed and then cleared left a
  sign-off row with a blank holder and the prefilled date, and the recovery sheet printed that date for
  nobody. On an M-of-N split, a share with no holder now keeps its line but no date.

- When the engine does not record a key-posture acknowledgement, the Keys screen now shows why, for
  example the engine's "rate limited (HTTP 429)" or "the console could not reach the engine". It tells
  you to update the console and engine only when the engine refuses the statement itself, which is what
  version skew causes.

- A viewer now sees the notification rules. The engine lets every role read rules but refuses the
  channel list without `notify.config`, and that refusal made the whole Rules panel show an error. The
  panel now shows each rule with its channels by id.

- The Remove member dialogue no longer says that recovery codes alone can enrol a new passkey. A
  passkey or a recovery code still signs the person in. After the role is removed, a recovery code or an
  invite can enrol a new passkey only if the engine cannot read the role table, or finds it empty.

- When the engine refuses to email a custody share, the console now shows the correct reason for more
  refusals. A rate limit now shows "Too many sends just now". Before, the engine's "rate limited" reason
  did not match and the console showed a general line. A send refused because your Cloudflare Access
  sign-in is older than five minutes now tells you to sign in to Access again in a new tab and then send
  from the same page. A passkey check that did not complete shows the reason the check recorded, for
  example that no passkey is enrolled for your account. If there is no recorded reason, it tells you to
  send again and confirm with your passkey. A session that the engine does not accept has its own line.
  Each of these lines says that nothing was sent.

- "Encrypt the key file in this browser" on the password manager and encrypted drive options now says
  which file your browser did not download. Before, it always said "Ciphertext downloaded" and "The
  wrapping key was downloaded", also when the browser blocked a download. Each file now has a
  Re-download button, and the warning stays until the browser accepts the file. The warning names the
  file that exists only on this page: the wrapping key, or `identity.key.enc` when only that file did not
  download.

- The paper companion on the encrypted drive option now prints the whole `identity.key.enc` file: the
  first line, the `iv` line and the `ciphertext` line. Before, it printed only the ciphertext, which cannot
  recover the key without the `iv` line. The paper copy now recovers the key with the wrapping key alone:
  type or scan it back into `identity.key.enc` and give it to the offline reader with `--envelope`. The
  console checks that the printed text reads back as a complete file.
- The restore run picker lists sealed runs only. Before this change, it also listed runs that were in
  flight, failed or abandoned, and a restore from one of them can only fail at the dry run. You can still
  type any run id on the restore form. The run history keeps only the last 50 runs of each downpipe. When
  it holds runs but none of them sealed, the picker says so, and says that you can restore an older sealed
  run by its run id. It does not tell you to wait for a first backup.

- The restore plan and the receipt show records whose backup holds an incompleteness marker in their own
  group, "not captured (incompleteness markers)". Before this change, they were in the "re-provisioned out
  of band" group, but the backup holds no data for them to re-provision.

- When the engine refuses a restore apply before it writes, the restore screen shows the refusal and still
  says that nothing has been written. Before this change, it said that the outcome of the apply was
  unknown. The engine refuses before it writes when you dismiss the passkey step-up, when your Access
  sign-in is too old, when your role cannot apply, when it rate-limits you, and for any other 4xx answer.
  A batch restore row says "Nothing was written for this row." for the same refusals. A 5xx answer, or no
  answer, still shows that the outcome is unknown.

- A batch restore row shows its reason as a full sentence before the text that follows it. Before this
  change, a rate-limited row read "rate limited by the engine (retry after 3s) Nothing was written for this
  row." It now reads "The engine received too many requests and refused this one. Try again after 3
  seconds. Nothing was written for this row."

- The Change button above a restore plan asks for confirmation only when an approval armed Apply. On an
  estate that does not require a second approver, it opens the form directly, because there is no
  approval to lose.

- After an apply that did not complete, the Progress panel beside the restore reads "Not consumed. The
  apply did not complete." for Approval, or "The apply did not complete." when no approval was required.
  Before this change, it read "Applied". The engine consumes an approval only when an apply completes.

- When you enter a licence that ends earlier than the active licence, the Licence card now asks you to
  confirm. The engine refuses such a licence and changes nothing. Its message told you to activate the
  licence again with `allowSupersede`, but no control in the console could send that flag. The dialogue
  states both end dates. When the two dates are on the same day, it shows the full time of each. "Use
  this licence" sends the licence again with the flag, and the confirmation states the new end date.
  "Keep the active licence" changes nothing, and the card shows a status note that the active licence
  stays.

- When an update stays unverified, the Licence and updates screen checks the engine 30 more times, 20
  seconds apart. After the last check, the line now tells you to reload the screen. Before this change,
  the line continued to say "Still verifying" after the checks stopped. This also applies to the
  pending update card and to a gradual ramp.

- The Microsoft Sentinel integration tile no longer shows a link that searches Azure Marketplace for the
  Content Hub solution. The solution is not listed yet, so the search found nothing. The tile shows the
  ARM template method only. The link comes back when the listing is published.
- A downpipe record that the engine returns with no configuration, or with no source, no longer stops
  the Map from loading. A record that has an id shows as an unknown route. Its drawer states what the
  console could not read and tells you to send a support pack. It offers Delete downpipe and, when the
  engine reports orphaned records, the owner's roster clean-up. The Map counts these routes in their own
  note. A record with no id cannot show, and this includes a record whose source is readable. The Map
  states how many there are and tells you to send a support pack.

- The control-plane recovery banner offers "Confirm and restore access" after the automatic resume. When
  the automatic resume of a staged export has put your configuration back and the operator role table is
  empty, the engine accepts the break-glass confirm, but the banner showed no button. The banner now offers
  the confirm, and it no longer says that scheduled backups have stopped. The banner and the confirm
  dialogue say that the confirm writes the export's downpipes and destinations again and replaces the
  discovery settings, so any change to them after the automatic resume is lost. They tell you to enter
  the discovery API token, the STS external IDs and each destination secret that the export did not hold
  again after the confirm. When the export is staged but its resume has not run, the configuration was
  put back by hand, so the banner offers no confirm and tells you to grant an owner role first.

- When the engine claims a recovery-time estimate on the Reports screen and sends no readable figure, a
  support pack now records the fault as a duration anomaly, missing or unparseable. The screen says so.
  The record carries the class of the fault only, never the figure.

- Each create from the create wizard, the advanced editor, the bulk import and the Sources bulk protect
  now tells the engine that it creates a new downpipe. If a downpipe with the same id already exists, the
  engine refuses that create and names the id, and the existing downpipe stays as it is. Before this
  change, the create replaced it. The delete dialogue again says that you can recreate the route later.

- A Secrets downpipe that the create wizard or the Sources bulk protect makes now records each secret
  under its Secrets Store name and store id. Before this change it recorded a display label, for example
  "Src Sec Api Key", so the engine could not match the secret and its wiring read "unknown". When the
  console cannot read the store record, the name is the binding without its SRC_SEC_ prefix.

- "Re-attach all" on the Sources screen now reports each downpipe whose source names no binding. Before
  this change, a heal that found only such downpipes said that all configured sources were already
  attached, although those downpipes still could not run. The message now counts them and tells you to
  open each one and set its source.

- The Re-attach button on each row of Needs attention on the Sources screen now needs the Owner, as
  "Re-attach all" does. Before this change it opened for an Operator, but each route it opens ends at the
  source attach, which the engine lets only an Owner do. An Operator now sees why the button is off.

- When the Map shows more flows than it animates, the diagnostics in a support pack now record the
  still frame as `edge-budget`. Before this change they recorded the live view as running. The line under
  the Map and the diagnostics row now read the same state from the Map itself. Needs engine 0.3.7 to keep
  the row. An older engine drops it.

- The cost calculator now starts its destination pricing list with the destinations that your
  downpipes write to. Before this change it listed every destination on the account, and the estimate
  counted a copy in a destination that no downpipe uses. When the console finds no destination on the
  account that a downpipe writes to, the list still starts with every destination. This includes when you
  have no downpipes and when the console cannot read them. The pricing note says so.

- The command palette's "Drill latest run of every downpipe" now starts the fleet drill. Before this
  change it only opened the Overview. The palette waits until the Overview has finished its setup check,
  which can take up to 4 seconds on a slow engine. If the Overview cannot start the drill, for example
  because setup is not complete, a message says so and tells you where the Drill all button is.

- On the tour and the training walk, a dialog that a screen or a tour chapter opens stays under the
  welcome card and the tour rail, so their buttons can be clicked, and a toast shows above the dialog it
  reports on. A confirm raised from a link in the tour chrome still shows above that chrome.
- `npm run deploy` deploys a release-tag checkout. Its preflight ran the developer chains, `npm run validate`
  and `npm run lint`. `test/validate-client-diag.ts` refuses (exit 2, CANNOT CHECK) when the engine checkout
  beside it is behind its own origin/main. The deploy page tells you to check out the release tag in
  both engine and console, and a tag is behind main as soon as anything lands after it, so the deploy
  stopped before it started. The preflight now
  checks that `node_modules` matches `package-lock.json`, typechecks, and runs `npm run validate:customer`: the
  29 members that guard your keys in the browser and the page that holds them. Measured in a fresh clone of the public tree, the preflight took 36 seconds at load average 15 to 30 and 75 seconds at 95 to 110; validate alone ran for 624 seconds there before it refused.
  `npm run validate` and `npm run lint` are unchanged. `test/validate-customer-preflight.ts`, in
  `npm run validate`, fails when a member of the developer chains is not classified in
  `scripts/customer-preflight.json` (kept, or left out with a one-line reason), or when `deploy.sh` stops
  running the customer preflight.

- The test shim's `flushAsync` (`test/dom-shim-bridges.ts`) waited a fixed number of event-loop turns. Web
  Crypto runs on Node's thread pool, so on a busy machine the break-glass restore and prune panel tests read
  the panel before the key was recovered: `test/validate-break-glass-prune.ts` failed under a busy validate
  and passed on its own. A flush now also waits until no Web Crypto call is in flight and a full pass of turns
  saw none start or finish.
  `test/validate-dom-shim-flush.ts` slows Web Crypto on purpose and fails when a flush returns before a call,
  or the step queued behind it, has settled.
- Turning restore approval on or off in Security Centre, and in setup, asks you to confirm with your own
  passkey when your session needs it. A dismissed or failed prompt changes nothing.
- A delete of a record that is no longer there says it was not found, so nothing was deleted, and points
  to the refreshed list or map.
- A refused canary flight or canary change shows the engine's own reason.
- A refused read of the notification channels shows the refusal, not an empty "not set up" tile.
- The Access and security screen no longer shows a capability hint that contradicts the control beside it.
- The guided tour clears the drawer's title when it seats an anchor there, so the two do not overlap.

### Security

- The group mapping table shows a mapping scoped to one identity provider, and Remove deletes exactly the row you chose.

### Removed

- The `/onboarding` card deck and the Overview setup checklist. Setup at `/setup` replaces both.

### Dependencies

- TypeScript 7.0.2 is now the `typescript` package, and `npm run typecheck` runs it. The gates that walk
  the syntax tree import the TypeScript 6 compiler API from `@typescript/typescript6`. `npm run
  lint:circular` loads `scripts/typescript6-preload.mjs` first, which gives madge's parser that same API.
- wrangler 4.142.0 (from 4.131.2), which a deploy's `npm ci` installs.
- @types/node 26.6.3 (from 22.20.0).
- @cloudflare/workers-types 5.20260928.1 (from 5.20260914.1).
- @vitest/coverage-istanbul 4.1.11 (from 4.1.9). vitest and @vitest/coverage-istanbul stay at 4.1.11,
  because @cloudflare/vitest-pool-workers 0.22.0 accepts only vitest 4.
- fast-check 4.10.2 (from 4.10.0).
- @stryker-mutator/core 10.0.0 (from 9.6.1).
- @noble/curves 2.4.0, @noble/hashes 2.4.0 and @noble/post-quantum 0.7.1 are already their latest
  releases.
- GitHub Actions pins: actions/checkout 7.0.1, actions/setup-node 7.0.0 and
  actions/download-artifact 8.0.1. The release workflow pins cosign 3.1.3 (`cosign-release`).

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

Its changes ship in the 0.2.6 release.

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
  time now shows that default destination, labelled as the deploy-time binding,
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

- A `.well-known/security.txt` disclosure endpoint.

### Removed

- Stray `coverage/` output that had been tracked in version control despite the ignore
  rule.

[0.2.9]: https://github.com/downpipes-io/console/releases/tag/v0.2.9
[0.2.8]: https://github.com/downpipes-io/console/releases/tag/v0.2.8
[0.2.6]: https://github.com/downpipes-io/console/releases/tag/v0.2.6
[0.2.5]: https://github.com/downpipes-io/console/releases/tag/v0.2.5
[0.2.4]: https://github.com/downpipes-io/console/releases/tag/v0.2.4
[0.2.3]: https://github.com/downpipes-io/console/releases/tag/v0.2.3
[0.2.2]: https://github.com/downpipes-io/console/releases/tag/v0.2.2
[0.2.1]: https://github.com/downpipes-io/console/releases/tag/v0.2.1
[0.1.0]: https://github.com/downpipes-io/console/releases/tag/v0.1.0
