// SAML SIGNING-CERT ROLLOVER: THE FIELD GUARD COUNTS THE RESULTING PINNED SET, NOT THE PASTE.
//
//   node test/validate-samlcert-rollover-capacity.ts
//
// THE CLASS. A rollover is documented as APPEND (so assertions signed by either key verify through the
// overlap) then REPLACE (so the retired certificate is pruned). Append only ever RAISES the pinned count,
// which the engine caps at eight, and the cap is on the RESULT: the engine validates the existing pinned
// set concatenated with the paste. This screen's guard must test the RESULT, not only the paste, or seven
// pinned plus two pasted would see two and let it through.
//
// WHAT THE OPERATOR MUST BE TOLD. The engine's refusal for an over-capacity array is the wrong-shape
// sentence, "idpSigningCerts must be a non-empty array of PEM X.509 certificates", because strArray returns
// one null for "not an array", "an entry is not a bounded string" and "too many entries" alike. An operator
// rolling a signing certificate over against their provider's cut-over deadline must not be told their
// perfectly good certificates are not certificates, since the remedy that sentence implies, re-export from
// the provider, cannot work. The remedy that does work, Replace, is the other control on the same screen
// and must be named.
//
// House style: Australian English, no em dashes, no rule-of-three, precise claims.

import { flushAsync, installDomShim, markConnected, qsa, textOf } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

installDomShim();

const { certRolloverSection } = await import("../src/screens/idp-connections/cert-rollover.ts");

const base = makeChecks();
let checksRun = 0;
function ok(label: string, cond: boolean): void {
  checksRun++;
  base.ok(label, cond);
}

function pem(tag: string): string {
  return `-----BEGIN CERTIFICATE-----\nMIIC${tag}\n-----END CERTIFICATE-----`;
}
function pems(n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) => pem(`c${String(from + i).padStart(3, "0")}`));
}

const NO_CHANGE_NUMBER = () => Promise.resolve({ requireConfigApproval: false, requireChangeNumber: false });

// open renders the REAL section against a connection holding `pinned` certificates, and returns handles on
// its live controls plus a count of how many times the engine was actually called.
async function open(pinned: number): Promise<{
  paste: (text: string) => void;
  mode: (v: "append" | "replace") => void;
  apply: () => void;
  text: () => string;
  calls: () => number;
}> {
  let calls = 0;
  const engineStub = {
    getConfigApprovalPolicy: NO_CHANGE_NUMBER,
    rolloverIdpSigningCerts: () => {
      calls++;
      return Promise.resolve({ value: { ok: true } });
    },
  } as never;
  const conn = {
    id: "c1", kind: "saml", label: "Okta", enabled: true, idpEntityId: "https://idp.example",
    emailVerifiedPolicy: "require-flag", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "",
    idpSigningCerts: pems(pinned),
  };
  const root = certRolloverSection(engineStub, conn as never, true, () => {});
  markConnected(root);
  const box = qsa(root, "textarea").find((n) => n.getAttribute("id") === "saml-rollover-certs");
  if (!box) throw new Error("the rollover paste box did not render");
  const sel = qsa(root, "select").find((n) => n.getAttribute("id") === "saml-rollover-mode");
  if (!sel) throw new Error("the rollover mode picker did not render");
  const btn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "idp-connections.button.cert-rollover");
  if (!btn) throw new Error("the rollover apply button did not render");
  return {
    paste: (text) => {
      (box as unknown as { value: string }).value = text;
    },
    mode: (v) => {
      (sel as unknown as { value: string }).value = v;
    },
    apply: () => btn.click(),
    text: () => textOf(root),
    calls: () => calls,
  };
}

// attempt drives one whole interaction and reports whether the engine was reached and what the screen says.
async function attempt(pinned: number, pasted: number, mode: "append" | "replace"): Promise<{ reached: boolean; text: string }> {
  const h = await open(pinned);
  h.mode(mode);
  h.paste(pems(pasted, 900).join("\n"));
  h.apply();
  // runRollover is async (it awaits requireChange before it POSTs), so the microtask queue has to drain
  // before "did the engine hear about it" can be read. A synchronous read here would report every attempt
  // as refused, which is the shape of a check that cannot fail.
  await flushAsync();
  return { reached: h.calls() > 0, text: h.text() };
}

const MAX = 8;

async function main(): Promise<void> {
  // ---- DOSE-RESPONSE on APPEND: where does the FIELD refuse? -------------------------------------
  console.log("\nDOSE-RESPONSE, Append (pinned + pasted), driven through the real section and its real handler:");
  const doses: [number, number][] = [[1, 1], [1, 7], [4, 4], [4, 5], [7, 1], [7, 2], [8, 1], [0, 8], [0, 9]];
  const results: { pinned: number; pasted: number; reached: boolean; text: string }[] = [];
  for (const [pinned, pasted] of doses) {
    const r = await attempt(pinned, pasted, "append");
    results.push({ pinned, pasted, ...r });
    console.log(`  ${pinned} + ${pasted} = ${pinned + pasted}\t${r.reached ? "SENT" : "REFUSED AT THE FIELD"}`);
  }
  const at = (p: number, q: number) => results.find((r) => r.pinned === p && r.pasted === q)!;

  ok(`an append whose RESULT is at or under ${MAX} is sent (1+7, 4+4, 7+1)`, at(1, 7).reached && at(4, 4).reached && at(7, 1).reached);
  ok(`an append whose RESULT exceeds ${MAX} is refused at the field, and NEVER reaches the engine (4+5)`, at(4, 5).reached === false);
  ok(`  the same at 7 + 2, which the old paste-only guard let straight through`, at(7, 2).reached === false);
  ok(`  and at 8 + 1, an already-full pinned set`, at(8, 1).reached === false);
  ok(`the edge is on the RESULT, not the paste: 0 + 8 is sent while 4 + 5 is refused`, at(0, 8).reached === true && at(4, 5).reached === false);

  // ---- IS THE REFUSAL HONEST, AND DOES ITS REMEDY HELP -------------------------------------------
  const refusal = at(7, 2).text;
  ok(`the refusal names how many are ALREADY pinned`, /already pins 7 certificate\(s\)/.test(refusal));
  ok(`it names what the operator pasted and what the result would be`, /appending 2 more would make 9/.test(refusal));
  ok(`it names the cap`, new RegExp(`over the limit of ${MAX}`).test(refusal));
  ok(`it names REPLACE, which is the only step that lowers the count`, /Choose Replace/.test(refusal));
  ok(`and it does not tell the operator their certificates are not certificates`, !/must be a non-empty array of PEM/.test(refusal));

  // ---- NEGATIVE CONTROLS: these MUST classify DIFFERENTLY ----------------------------------------
  // If every refusal on this screen were the capacity sentence, the guard would be a blunt instrument.
  console.log("\nNEGATIVE CONTROLS (must classify differently)");
  {
    const h = await open(7);
    h.mode("append");
    h.paste("not a certificate at all");
    h.apply();
    await flushAsync();
    const t = h.text();
    ok(`a paste with no PEM armour keeps its OWN message`, /begins with -----BEGIN CERTIFICATE-----/.test(t));
    ok(`  and does not borrow the capacity message`, !/already pins/.test(t));
    ok(`  and nothing is sent`, h.calls() === 0);
  }
  {
    const h = await open(7);
    h.mode("append");
    h.paste("-----BEGIN CERTIFICATE-----\nMIICmangled");
    h.apply();
    await flushAsync();
    const t = h.text();
    ok(`a paste whose END line an editor mangled keeps ITS own message`, /must end with -----END CERTIFICATE-----/.test(t));
    ok(`  and does not borrow the capacity message`, !/already pins/.test(t));
    ok(`  and nothing is sent`, h.calls() === 0);
  }

  // ---- NEGATIVE CONTROL: a connection whose certs array is ABSENT must not crash the control -----
  // The first cut of this guard read conn.idpSigningCerts.length behind a kind check alone, and
  // validate-gated-202-decode drove it with a SAML connection carrying no certs array at all: a TypeError
  // inside the click handler on the screen whose whole job is a rollover. The type says the field is there;
  // the wire decides. Pinned here so the defensive read cannot be tidied away.
  console.log("\nNEGATIVE CONTROL: a SAML connection whose certs array is absent");
  {
    let calls = 0;
    const engineStub = { getConfigApprovalPolicy: NO_CHANGE_NUMBER, rolloverIdpSigningCerts: () => { calls++; return Promise.resolve({ value: { ok: true } }); } } as never;
    const conn = { id: "c1", kind: "saml", label: "Okta", enabled: true, idpEntityId: "https://idp.example", emailVerifiedPolicy: "require-flag", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "" };
    const root = certRolloverSection(engineStub, conn as never, true, () => {});
    markConnected(root);
    const box = qsa(root, "textarea").find((n) => n.getAttribute("id") === "saml-rollover-certs")!;
    (box as unknown as { value: string }).value = pems(1, 700).join("\n");
    const btn = qsa(root, "button").find((b) => b.getAttribute("data-dp") === "idp-connections.button.cert-rollover")!;
    let threw = false;
    try {
      btn.click();
      await flushAsync();
    } catch {
      threw = true;
    }
    ok(`the control does not throw when the pinned array is absent`, threw === false);
    ok(`  and the append still reaches the engine, which has the last word on capacity`, calls === 1);
  }

  // ---- DIFFERENTIAL CONTROL: the same over-capacity input down the OTHER mode --------------------
  // Replace is the mode whose whole purpose is to LOWER the count, so the identical paste that Append
  // refuses must be accepted here. If the guard were mode-blind it would refuse the very remedy it
  // recommends, which would be a worse refusal than the one being fixed.
  console.log("\nDIFFERENTIAL CONTROL: the same paste under Replace, the mode that prunes");
  {
    const rep = await attempt(8, 8, "replace");
    ok(`Replace with a full ${MAX} onto an already-full set is SENT, because it prunes rather than adds`, rep.reached === true);
    const app = await attempt(8, 8, "append");
    ok(`  while Append with the identical paste is refused`, app.reached === false);
    const repOver = await attempt(1, 9, "replace");
    ok(`Replace still refuses a paste of more than ${MAX}, with the PASTE-count message rather than the pinned one`, repOver.reached === false && /Paste at most 8 certificates/.test(repOver.text) && !/already pins/.test(repOver.text));
  }

  // ---- POSITION CONTROL --------------------------------------------------------------------------
  // Vary what should not matter: the number of certificates PINNED, holding the result constant. Every
  // split that sums to 9 must refuse, and every split that sums to 8 must send.
  console.log("\nPOSITION CONTROL: the split between pinned and pasted, at a constant result");
  {
    const nines = await Promise.all(([[1, 8], [4, 5], [7, 2], [8, 1]] as [number, number][]).map(([p, q]) => attempt(p, q, "append")));
    ok(`every split summing to 9 refuses, whichever side carries the certificates`, nines.every((r) => r.reached === false));
    const eights = await Promise.all(([[0, 8], [1, 7], [4, 4], [7, 1]] as [number, number][]).map(([p, q]) => attempt(p, q, "append")));
    ok(`every split summing to 8 is sent`, eights.every((r) => r.reached === true));
  }

  console.log(
    base.failures === 0
      ? `\nSAMLCERT ROLLOVER CAPACITY PASS (${checksRun} checks)`
      : `\n${base.failures} FAILURE(S) of ${checksRun} checks`,
  );
  if (base.failures > 0) process.exitCode = 1;
  process.exit(base.failures > 0 ? 1 : 0);
}

await main();
