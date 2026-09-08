// Per-provider "How to add <provider> as an identity provider" setup guidance, shown inline in the
// add-connection form (idp-connections.ts) the moment a provider is chosen. Each guide is the customer-facing
// half of a connection: the numbered steps to register downpipes at that IdP, the EXACT name that IdP gives
// its redirect/callback field (so the operator knows where to paste the callback URL the form shows live),
// how to make the IdP emit the groups/roles claim downpipes reads, and the provider-specific traps.
//
// Every step is validated against the provider's current official documentation, since admin portals move
// (Entra's redirect-URI UI, Google's "Google Auth Platform" rename, GitLab's "Edit profile > Access >
// Applications" path have all changed before). The engine's preset registry (oidc-presets.ts) owns the
// technical defaults (issuer, scopes, claim names); these guides own the human "what do I click" layer.
// They are keyed by the engine preset id, so a guide lines up with its form.
//
// Australian English; no em dashes. Pure data + a lookup; no I/O, no DOM (the screen renders it).

export interface IdpGuide {
  // What THIS provider calls the redirect/callback field, so the step "paste the callback URL" names the
  // right place (GitHub "Authorization callback URL", Okta "Sign-in redirect URIs", Auth0 "Allowed Callback
  // URLs", ...). The actual value is rendered live by the form (it embeds the connection id).
  redirectFieldName: string;
  // 5 to 9 ordered steps, each a short imperative sentence written for the operator doing the setup.
  steps: string[];
  // How group/role membership reaches downpipes: the claim/attribute the IdP must emit, or the honest
  // "sign-in only, assign roles here" note for providers that emit nothing (Google).
  groups?: { heading: string; items: string[] };
  // Provider-specific traps. A curated superset of the engine preset's notes; the form shows these instead
  // of the raw preset notes when a guide exists.
  gotchas?: string[];
  // The single most useful official doc page for this provider's setup.
  docsUrl?: string;
}

// Keyed by the engine preset id (entra, okta, google, keycloak, jumpcloud, auth0, gitlab, generic-oidc,
// github, generic-oauth2). A preset with no entry here falls back to its engine-supplied notes.
export const IDP_GUIDES: Record<string, IdpGuide> = {
  github: {
    redirectFieldName: "Authorization callback URL",
    steps: [
      "Sign in to GitHub as an organisation owner and open Settings, then Developer settings, then OAuth Apps.",
      "Click New OAuth App.",
      'Set an Application name (for example "downpipes") and, for the Homepage URL, your own console address (the same origin as the callback URL shown below).',
      'Paste the callback URL shown below into "Authorization callback URL".',
      "Click Register application.",
      "Copy the Client ID, then click Generate a new client secret and copy the secret straight away (GitHub shows it only once).",
      "Paste the Client ID and secret into the fields below.",
    ],
    groups: {
      heading: "Team and organisation membership",
      items: [
        "downpipes requests the read:org and user:email scopes; read:org lets it read your team and organisation membership for group-to-role mapping.",
        "If your organisation has OAuth App access restrictions on (the default for new orgs), an owner must approve downpipes under Settings, Third-party access, OAuth app policy before membership is returned.",
      ],
    },
    gotchas: [
      "Register a classic OAuth App (the New OAuth App path), not a GitHub App.",
      "The client secret is shown only once. Copy it before you leave the page.",
      "downpipes keys identity on your immutable numeric user id, never the renameable login, so renaming a user never loses their access.",
    ],
    docsUrl: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app",
  },

  entra: {
    redirectFieldName: "Redirect URI (Web platform)",
    steps: [
      "Sign in to the Microsoft Entra admin center and open App registrations, then New registration.",
      'Name it (for example "downpipes"), choose "Accounts in this organizational directory only" (single tenant), leave the Redirect URI blank, and click Register.',
      "Open Manage, then Authentication, Add a platform, choose Web, paste the callback URL shown below as the Redirect URI, and click Configure. (The newest portal labels this Add Redirect URI; choose the Web tile either way.)",
      "Open Certificates & secrets, Client secrets, New client secret; add it and copy the secret Value immediately (the Value, not the Secret ID, and it is hidden once you leave the page).",
      "From the Overview pane, copy the Application (client) ID and the Directory (tenant) ID.",
      "Paste the tenant ID, client ID and secret into the fields below.",
      "Optional: under API permissions, Grant admin consent so users are not each prompted at first sign-in.",
    ],
    groups: {
      heading: "Emit the roles claim with App Roles",
      items: [
        "In the app registration open App roles, Create app role; set Allowed member types to Users/Groups and a Value (the role name downpipes matches, for example admin).",
        "Open Enterprise applications, your downpipes app, Users and groups; assign a user or group and pick the app role. The Value then arrives in the id_token roles claim.",
        "App Roles are recommended over group object-ids: they avoid the >200-group overflow and the GUID-to-name problem. Assigning a group to a role needs Entra ID P1 or P2; assigning individual users does not.",
      ],
    },
    gotchas: [
      "Copy the secret Value, not the Secret ID. It expires (24 months maximum), so set a renewal reminder.",
      "This preset uses the v2.0 endpoints (issuer ending /v2.0). Do not use the v1.0 sts.windows.net issuer.",
    ],
    docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps",
  },

  okta: {
    redirectFieldName: "Sign-in redirect URIs",
    steps: [
      "Sign in to the Okta Admin Console and open Applications, Applications, Create App Integration.",
      "Choose OIDC - OpenID Connect, then Web Application, and click Next.",
      'Name it (for example "downpipes") and paste the callback URL shown below into "Sign-in redirect URIs".',
      "Under Assignments, assign the app to the users or groups who may sign in, then click Save.",
      "On the app's General tab, copy the Client ID and Client secret from Client Credentials.",
      "Paste your Okta domain, the authorization server id (default), the client ID and the secret into the fields below.",
    ],
    groups: {
      heading: "Emit the groups claim on the custom authorization server",
      items: [
        'Open Security, API, Authorization Servers, open the "default" server, then Claims, Add Claim.',
        "Name it groups, set Include in token type to ID Token / Always, Value type to Groups, and Filter to Matches regex .* , then Create.",
        "The org authorization server cannot emit custom claims; the custom default server is required, which is why the issuer ends in /oauth2/default.",
      ],
    },
    gotchas: [
      "A claim returns at most 100 groups; if more match the filter the token request fails. Narrow the regex or use an allowlist.",
      "If the token call returns 401, set the app's client authentication to match downpipes (this engine uses client_secret_post; Okta web apps default to client secret basic).",
    ],
    docsUrl: "https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/",
  },

  google: {
    redirectFieldName: "Authorized redirect URIs",
    steps: [
      "In the Google Cloud Console, create or select a project owned by your Workspace organisation.",
      "Open Google Auth Platform, Audience, and set User type to Internal (limits sign-in to your organisation).",
      "Under Branding set the app name and a support email; under Data Access add the openid, email and profile scopes.",
      "Open Google Auth Platform, Clients, Create Client; set Application type to Web application and name it.",
      "Under Authorized redirect URIs, click Add URI, paste the callback URL shown below, and click Create.",
      "Copy the Client ID and Client secret (the full secret is shown only once) and your Workspace domain into the fields below.",
    ],
    groups: {
      heading: "Sign-in only (Google sends no groups)",
      items: [
        "Google does not put group membership in the id_token, so downpipes signs people in and you assign each person's role on the Roles and access tab.",
        "Workspace group sync via the Cloud Identity API is a possible future add-on, not required for sign-in.",
      ],
    },
    gotchas: [
      "Choose Internal, not External. Internal limits sign-in to your organisation and skips Google's app-verification review.",
      "The Workspace-domain (hd) gate is mandatory: without it any consumer Google account could sign in. downpipes verifies the hd claim in the returned token, so type your exact primary domain.",
      'The old "OAuth consent screen" page is now "Google Auth Platform"; older guides that say APIs & Services, Credentials redirect there.',
    ],
    docsUrl: "https://developers.google.com/identity/openid-connect/openid-connect",
  },

  keycloak: {
    redirectFieldName: "Valid redirect URIs",
    steps: [
      "Sign in to the Keycloak Admin Console and select the realm downpipes should use (the realm selector, top-left).",
      'Open Clients, Create client; set Client type to OpenID Connect and a Client ID (for example "downpipes"), then click Next.',
      "On Capability config turn Client authentication On (this makes it confidential), keep Standard flow enabled, and click Next.",
      'On Login settings paste the callback URL shown below into "Valid redirect URIs", then click Save.',
      "Open the Credentials tab and copy the Client secret; copy the Client ID from the Settings tab.",
      "Paste your Keycloak host, realm, client ID and secret into the fields below.",
    ],
    groups: {
      heading: "Put groups and roles in the ID token",
      items: [
        "Open the client's Client scopes, the <client-id>-dedicated scope, Add mapper, By configuration, Group Membership; set Token Claim Name to groups, Full group path Off, and Add to ID token On.",
        "For roles, ensure the realm-roles mapper also has Add to ID token On (Keycloak emits roles and groups in the access token only by default).",
      ],
    },
    gotchas: [
      "By default roles and groups are in the access token only. You must turn Add to ID token On, or sign-in works but no roles or groups arrive.",
      "Keep Full group path Off so the claim carries plain group names (downpipes maps on names), not /parent/child paths.",
      "Modern Keycloak serves /realms/<realm>; legacy installs (before 17, or RH-SSO) use /auth/realms. Do not include /auth in the host.",
    ],
    docsUrl: "https://www.keycloak.org/docs/latest/server_admin/index.html",
  },

  jumpcloud: {
    redirectFieldName: "Redirect URIs",
    steps: [
      "Sign in to the JumpCloud Admin Portal and open SSO Applications (under Access).",
      "Click Add New Application and choose the Custom Application tile, then Next.",
      "Select Manage Single Sign-On (SSO), then Configure SSO with OIDC, then Next.",
      'Set a Display Label (for example "downpipes") and, under Redirect URIs, add the callback URL shown below.',
      "Set Client Authentication Type to Client Secret POST and activate the application.",
      "In the one-time confirmation window, copy the Client ID and Client Secret into the fields below (they are shown only once).",
      "Open the User Groups tab and assign the groups whose members may sign in.",
    ],
    groups: {
      heading: "Emit groups as the memberOf attribute",
      items: [
        "In the app's SSO settings, under Attributes, tick include group attribute and set Groups Attribute Name to memberOf.",
        "Only groups assigned to the app (the User Groups tab) appear in memberOf. Assign each group that should map to a role.",
      ],
    },
    gotchas: [
      "memberOf is an attribute mapping, not a scope. Adding a groups scope does nothing.",
      "This preset is the US region (oauth.id.jumpcloud.com). EU or IN tenants have a different issuer host; use the Generic OIDC preset with your regional .well-known URL instead.",
    ],
    docsUrl: "https://jumpcloud.com/support/sso-with-oidc",
  },

  auth0: {
    redirectFieldName: "Allowed Callback URLs",
    steps: [
      "In the Auth0 Dashboard open Applications, Applications, Create Application.",
      'Name it (for example "downpipes"), choose Regular Web Applications, and click Create.',
      'On the Settings tab, under Application URIs, paste the callback URL shown below into "Allowed Callback URLs", then Save Changes.',
      "From the top of Settings copy the Domain (include the region, for example your-tenant.us.auth0.com), the Client ID and the Client Secret.",
      "Paste the domain, client ID and secret into the fields below. Leave the roles-claim namespace blank for sign-in only.",
    ],
    groups: {
      heading: "Emit a namespaced roles claim (optional)",
      items: [
        "To map roles, set a namespace below (a URL ending in /, for example https://downpipes.io/), then add a Post-Login Action.",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is operator-facing guide copy quoting Auth0's own template syntax (${namespace} is meant to appear literally), not a JS template literal.
        "In Actions create a Login / Post Login action with api.idToken.setCustomClaim(`${namespace}roles`, event.authorization.roles); the namespace ends in / so the claim key reads as <namespace>roles (for example https://downpipes.io/roles). Deploy it and add it to the Login flow. Assign roles to users under User Management, Roles.",
      ],
    },
    gotchas: [
      "The issuer needs a trailing slash (https://<domain>/). downpipes adds it; dropping it is the classic Auth0 issuer mismatch.",
      "Include the region in the domain (.us, .eu, ...) or discovery fails.",
      "Roles are not emitted by default; without the Post-Login Action there is no roles claim (sign-in still works).",
    ],
    docsUrl: "https://auth0.com/docs/get-started/applications/application-settings",
  },

  gitlab: {
    redirectFieldName: "Redirect URI",
    steps: [
      "Decide where to register the Application: your own user (only you sign in), a Group (your team, recommended), or the instance (self-managed admin only).",
      "Open the matching Applications page. User: avatar, Edit profile, Access, Applications. Group: the group's Settings, Applications. Instance: Admin, Applications.",
      'Enter a Name (for example "downpipes") and paste the callback URL shown below into "Redirect URI".',
      "Under Scopes tick openid, profile and email, then click Save application.",
      "Copy the Application ID and Secret into the fields below, and set your GitLab host (gitlab.com by default).",
    ],
    groups: {
      heading: "Group membership (groups_direct)",
      items: [
        "downpipes maps from the groups_direct id_token claim (your direct group memberships); no extra GitLab setup is needed beyond the openid scope.",
        "Inherited groups and owner/maintainer roles are not in groups_direct (those live at /userinfo, which this id_token flow does not read).",
      ],
    },
    gotchas: [
      "Pick the right Application owner: a user app authenticates only that user; a group app suits a team; an instance app is self-managed only.",
      "groups_direct needs GitLab 16.11 or newer; older self-managed instances will not emit it.",
      "For self-managed or Dedicated, set your real host (not gitlab.com).",
    ],
    docsUrl: "https://docs.gitlab.com/integration/openid_connect_provider/",
  },

  "generic-oidc": {
    redirectFieldName: "Redirect URI / Callback URL",
    steps: [
      'In your identity provider, register a new OpenID Connect application (a confidential "web" client).',
      "Paste the callback URL shown below as the redirect URI / callback URL.",
      "Enable the authorization-code flow with PKCE and the openid, email and profile scopes.",
      "Copy the issuer URL (the base that serves /.well-known/openid-configuration), the client ID and the client secret.",
      "Paste the issuer, client ID and secret into the fields below; set the groups/roles claim name if your IdP emits one.",
    ],
    groups: {
      heading: "Group/role mapping (optional)",
      items: [
        "If your IdP can put a groups or roles array in the id_token, set that claim's name below; leave it blank for sign-in only.",
        "downpipes verifies the id_token, so make sure the claim is in the ID token, not only in the access token or at /userinfo.",
      ],
    },
    gotchas: [
      "The issuer must serve /.well-known/openid-configuration over https and match the iss in its tokens exactly.",
      "This preset absorbs Auth0, PingOne, OneLogin, Authentik, Zitadel, Curity and similar. Use a named preset above if one fits your provider.",
    ],
  },

  "generic-oauth2": {
    redirectFieldName: "Redirect URI / Callback URL",
    steps: [
      "In your provider, register a new OAuth 2.0 application.",
      "Paste the callback URL shown below as the redirect URI / callback URL.",
      "Copy the authorization URL, token URL, API base URL and a user-info (profile) URL from the provider's API docs.",
      'Find the field in the profile response that holds the user\'s immutable id (often "id").',
      "Paste those URLs, the immutable-id field, the client ID and secret into the fields below.",
    ],
    groups: {
      heading: "Identity and groups",
      items: [
        "downpipes signs the user in from the profile response and keys on the immutable id field you name; group mapping depends on the provider's API.",
        "This is the extensibility hatch for OAuth2 providers with no id_token (Discord, Bitbucket, GitLab-OAuth, ...).",
      ],
    },
    gotchas: ["Use the immutable numeric or opaque id, never a renameable username, as the id field."],
  },
};

// The generic SAML 2.0 setup guide (there is no SAML preset; the form composes the proposal). SAML differs
// from OIDC: the value the customer registers at their IdP is the ACS (Assertion Consumer Service) URL, the
// SP entity id is one the operator chooses, and trust comes from a pasted IdP signing certificate.
export interface SamlGuide {
  acsFieldName: string;
  steps: string[];
  gotchas?: string[];
}

export const SAML_GUIDE: SamlGuide = {
  acsFieldName: "ACS / Reply / Single sign-on URL",
  steps: [
    'In your IdP, create a new SAML 2.0 application (a generic "SAML" or "custom SAML" app).',
    "Set the ACS (Assertion Consumer Service) / Reply URL to the value shown below: this is where the signed assertion is POSTed.",
    "Set the SP entity id / Audience to the SP entity id you enter below (use a stable URL; it also goes in the SP metadata).",
    "Choose a persistent or emailAddress NameID format and turn on signing of assertions (downpipes requires signed assertions).",
    "Download the IdP's signing certificate (X.509 PEM) and paste it below; map the email (and optionally groups) attribute.",
    "Save the connection, then download the SP metadata from its card and upload it to your IdP if it prefers metadata over the values above.",
  ],
  gotchas: [
    "downpipes is SP-initiated and verifies the assertion signature against the certificate you paste; IdP-initiated sign-in is off by default.",
    "Transient NameID is not accepted (it is not stable enough to key access). Use persistent or emailAddress.",
    'Leave Email trust on "require-flag" unless your IdP does not assert a verified-email flag; "trust-idp" trusts any email the assertion carries and is recorded in the audit log.',
  ],
};
