// Minimal byte helpers for the console (base64url no-pad, concat, SHA-384), matching the
// encodings the engine and the Go offline tool use.

import { recordMaterialRejected } from "./lib/client-diag/ring.ts";

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Decode lookup, derived once from B64URL: index by ASCII code, -1 means not in the alphabet.
const B64URL_LUT: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) t[B64URL.charCodeAt(i)] = i;
  return t;
})();

export function b64urlEncode(data: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= data.length; i += 3) {
    const n = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rem = data.length - i;
  if (rem === 1) {
    const n = data[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (data[i]! << 16) | (data[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

// b64urlDecode decodes a strict base64url-no-pad string (RFC 4648 §5, no padding).
// It rejects:
//   - any character outside the base64url alphabet (A-Z a-z 0-9 - _)
//   - standard base64 padding characters ('=')
//   - standard base64 alphabet characters ('+', '/')
//   - whitespace (no trimming)
//   - non-canonical lengths (i.e. lengths that are 1 mod 4, which cannot be the
//     output of any valid base64url-no-pad encoding)
// This matches Go's base64.RawURLEncoding.Strict behaviour.
// Every reject branch below records its own closed class into the console-diagnostics ring before it
// throws. This decoder is the gate every piece of pasted key, share and recovery material passes through, and it
// is the ONLY place that knows WHY the material was refused: the screens above it coarsen the throw into one
// "that does not look right" hint, and no request is made, so the engine has no record of the refusal and could
// never have one. A customer who cannot get their recovery share accepted, and a support engineer holding their
// pack, were looking at the same nothing.
//
// The class is decided by the BRANCH, not by reading the message. Nothing about the material rides: not the
// text, not the offending character, not its position, and deliberately not the length, which is a fingerprint
// of the secret (and the class already says the length was what was wrong).
//
// The THROWN MESSAGE is held to the same bar, and it did not used to be. It carried the offending character, its
// offset into the material and the material's length, on the reasoning that an Error stays in the browser. That
// reasoning is one `errMessage(err)` away from being false: the screens above this decoder already render caught
// errors into the page, and a rendered message is one screenshot away from a support ticket. `s` here is a pasted
// wrapping key, share or recovery code. So the message now names the FAULT CLASS and nothing else: same closed
// class as the ring, no character, no offset, no length.
export function b64urlDecode(s: string): Uint8Array {
  // A length of 1 mod 4 is never produced by valid base64url-no-pad encoding
  // (valid lengths are 0, 2, 3 mod 4 for 0, 1, 2 trailing bytes respectively).
  if (s.length % 4 === 1) {
    recordMaterialRejected("bad-length");
    throw new Error("invalid base64url: the material is not a whole number of encoded bytes");
  }

  const lut = B64URL_LUT;

  // Decode STRAIGHT INTO a Uint8Array rather than accumulating a number[] and copying at the end. The old
  // shape put every decoded byte of a key, share or wrapping key into a JS array that nothing could zero and
  // that the caller never saw, so wiping the returned buffer left a full second copy behind for the collector
  // to reclaim whenever it liked. This is the one decode on the break-glass path, so that copy was the
  // material itself. The output length is exact: base64url-no-pad yields floor(len * 6 / 8) bytes, and the
  // 1-mod-4 length is already rejected above, so `n` is never an over-allocation that would leave a
  // trailing zero byte in the result.
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let n = 0;
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Reject anything outside the 7-bit ASCII range (covers Unicode, surrogate pairs, etc.)
    if (code > 127) {
      // A smart quote, an en dash or a non-breaking space: what an email client or a word processor does to a
      // share on its way to the operator. The string they were sent and the string they pasted LOOK identical.
      recordMaterialRejected("non-ascii");
      throw new Error("invalid base64url: the material contains a non-ASCII character");
    }
    const v = lut[code]!;
    if (v < 0) {
      // '=' is standard-base64 PADDING and '+' / '/' are the standard alphabet: the material was produced by a
      // standard-base64 encoder rather than this product's base64url-no-pad. It is the most fixable rejection
      // there is and the one an operator can never diagnose from the screen, so it gets its own class.
      const padding = s[i] === "=";
      recordMaterialRejected(padding ? "padding-present" : "non-alphabet");
      throw new Error(
        padding
          ? "invalid base64url: the material carries standard-base64 padding"
          : "invalid base64url: the material contains a character outside the base64url alphabet",
      );
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ab narrows a Uint8Array to the ArrayBuffer-backed generic TypeScript 5.7+ requires at the
// Web Crypto boundary. Every buffer here is ArrayBuffer-backed, so the assertion is sound.
export function ab(x: Uint8Array): Uint8Array<ArrayBuffer> {
  return x as Uint8Array<ArrayBuffer>;
}

export async function sha384Hex(data: Uint8Array): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-384", ab(data)));
  let out = "";
  for (const b of sum) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
