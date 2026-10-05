// Console copy for the native-SSO no-grant refusal. The engine admits a native sign-in (OIDC, OAuth2,
// SAML) only when the account holds a role row, a pending invite for its verified email, or a mapped
// group; otherwise it refuses the sign-in with no session. Cloudflare Access and passkey sign-ins are
// unchanged: with no grant they still resolve to Viewer. This file pins the console copy that must state
// that distinction rather than claiming every sign-in with no grant lands on Viewer.
//
// Run with: node test/validate-sso-no-grant-copy.ts

import type { EngineClient, RoleEntry, Caller } from "../src/api.ts";
import { renderRolesTable } from "../src/screens/access-security/roles-members.ts";
import { IDP_GUIDES } from "../src/screens/idp-guides.ts";
import { setCaller, setWhoamiAvailable } from "../src/lib/store.ts";
import { installDomShim, textOf, markConnected, type ShimNode } from "./dom-shim.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

installDomShim();

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const OWNER: Caller = { method: "passkey", email: "owner1@example.com", role: "owner", groups: [], isOnlyOwner: false };

function fakeEngine(): EngineClient {
  return {
    async deleteRole() {
      return { status: "applied", value: { deleted: true } };
    },
  } as unknown as EngineClient;
}

async function main(): Promise<void> {
  setCaller(OWNER);
  setWhoamiAvailable(true);

  console.log("-- roles-members: the empty-roster copy names the SSO refusal, not a blanket Viewer floor --");
  {
    const el = renderRolesTable(fakeEngine(), [], () => undefined) as unknown as ShimNode;
    markConnected(el);
    const text = textOf(el);
    ok(
      "states the bootstrap Owner arrives through Cloudflare Access or a passkey",
      text.includes("The first person to sign in through Cloudflare Access or a passkey is the bootstrap Owner."),
    );
    ok(
      "states an SSO sign-in with no grant is refused, not defaulted to Viewer",
      text.includes("A Cloudflare Access or passkey member with no grant holds Viewer; an SSO sign-in with no grant is refused."),
    );
    ok("does not claim every new member simply defaults to Viewer", !text.includes("new members default to Viewer"));
  }

  console.log("\n-- roles-members: the populated-table default-role hint carries the same distinction --");
  {
    const rows: RoleEntry[] = [{ email: "teammate@example.com", role: "operator", grantedBy: "owner1@example.com", grantedAt: "2026-01-03T00:00:00.000Z" }];
    const el = renderRolesTable(fakeEngine(), rows, () => undefined) as unknown as ShimNode;
    markConnected(el);
    const text = textOf(el);
    ok(
      "states a member with no grant holds Viewer only through Cloudflare Access or a passkey",
      text.includes("A member with no grant holds Viewer (through Cloudflare Access or a passkey); an SSO sign-in with none is refused."),
    );
    ok("does not claim a bare 'New members default to Viewer'", !text.includes("New members default to Viewer."));
  }

  console.log("\n-- idp-guides: the Google guide tells an owner to invite people, not that sign-in alone is enough --");
  {
    const google = IDP_GUIDES.google;
    ok("the Google guide exists", google !== undefined);
    const groupsText = google?.groups?.items.join(" ") ?? "";
    ok(
      "states an owner must invite each person before they sign in",
      groupsText.includes("invite each person by email on the Roles and access tab before they sign in"),
    );
    ok("does not claim Google sign-in alone hands out access", !groupsText.includes("downpipes signs people in and you assign each person's role"));
  }

  console.log("\n-- idp-guides: the GitHub guide states an unmapped, uninvited account is refused --");
  {
    const github = IDP_GUIDES.github;
    const stepsText = github?.steps.join(" ") ?? "";
    ok(
      "the first step states downpipes admits only an invited or mapped GitHub account",
      stepsText.includes("downpipes admits only an account you invite by email or whose organisation or team you map on Roles and access"),
    );
  }

  console.log(failures === 0 ? "\nSSO-NO-GRANT-COPY PASS" : `\n${failures} FAILURE(S)`);
  verdictReached(failures);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nVALIDATE-SSO-NO-GRANT-COPY THREW:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
