// Validate the outbound email how-to on the setup surface (the Hardening view's "How" sheet,
// screens/setup/b/q-finish.ts outboundEmailHowTo) against what the engine needs. It moved there from the
// retired first-run deck's "Before you begin" card, and the property moved with it.
//
// Run: node test/validate-onboarding-email-prereq.ts
//
// THE DEFECT. The how-to said "Complete Email Routing onboarding for your sender domain, then bind EMAIL".
// Email Routing is Cloudflare's inbound forwarding product. The engine sends through the Email Service send
// binding, which needs the sender domain onboarded under Compute, Email Service, Email Sending (the engine's
// wrangler.toml [[send_email]] comment and its preflight "email-sending" probe name that path). Role-invite
// email also needs INVITE_EMAIL_FROM (engine env.d.ts), which the how-to did not name. An operator who
// followed the old text onboarded the wrong product and got no email.
//
// The how-to is rendered for real and its text is read, so the assertion is on what an operator sees.
//
// FS-WRITES: none outside this repo

import { installDomShim, textOf } from "./dom-shim.ts";

installDomShim();

import { outboundEmailHowTo } from "../src/screens/setup/b/q-finish.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

const text = textOf(outboundEmailHowTo() as unknown as HTMLElement);

console.log("-- the Outbound email how-to --");
ok("the how-to rendered (not a blank render)", text.includes("onboard your sender domain"));
ok("it sends the operator to Email Sending under Email Service", text.includes("Compute, then Email Service, then Email Sending"));
ok("it no longer names Email Routing, the inbound product", !text.includes("Email Routing"));
ok("it names EMAIL_FROM", text.includes("EMAIL_FROM"));
ok("it names INVITE_EMAIL_FROM for invite emails", text.includes("INVITE_EMAIL_FROM"));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} validate-onboarding-email-prereq: ${checks} checks, ${failures} failures`);
verdictReached(failures, checks);
if (failures > 0) process.exitCode = 1;
