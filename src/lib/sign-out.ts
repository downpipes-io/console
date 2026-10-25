// Engine-side half of sign-out. The console asks the engine to end the passkey session and waits a short,
// bounded time for the answer, so a failed or unanswered request is reported to the operator instead of
// being dropped. Local sign-out never waits on this: the caller clears its own state regardless, and only
// the warning waits, for at most the cap.

/** The part of the engine client sign-out needs. */
export interface SignOutEngine {
  passkeyLogout(signal?: AbortSignal): Promise<{ ok: boolean }>;
}

/** How long sign-out waits for the engine before it reports the session as unconfirmed. */
export const SIGN_OUT_WAIT_MS = 3000;

/** Shown when the engine did not confirm the session ended. */
export const SIGN_OUT_UNCONFIRMED_MESSAGE =
  "Signed out of this console, but the engine did not confirm that the session ended. It can stay valid until it expires. To end it now, sign in again and use Sign out my other sessions.";

export type SignOutOutcome = "ended" | "unconfirmed" | "none";

/**
 * endEngineSession asks the engine to end the session and resolves "ended" only when it answers ok in time.
 * A rejection (including a synchronous throw), a refusal or no answer within timeoutMs resolves "unconfirmed"
 * (onError receives a rejection). At the cap the request is aborted; that abort is already reported as
 * "unconfirmed", so it does not reach onError. It never rejects. With no engine client there is nothing to
 * end and it resolves "none".
 */
export async function endEngineSession(
  engine: SignOutEngine | null,
  timeoutMs: number = SIGN_OUT_WAIT_MS,
  onError?: (err: unknown) => void,
): Promise<SignOutOutcome> {
  if (engine === null) return "none";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"unconfirmed">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unconfirmed");
    }, timeoutMs);
  });
  const answered = Promise.resolve()
    .then(() => engine.passkeyLogout(controller.signal))
    .then(
      (r): SignOutOutcome => (r.ok === true ? "ended" : "unconfirmed"),
      (err: unknown): SignOutOutcome => {
        if (!controller.signal.aborted) onError?.(err);
        return "unconfirmed";
      },
    );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
