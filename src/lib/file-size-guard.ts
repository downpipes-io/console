// The one size ceiling for every file the console reads from the operator's disk: an identity.key, a
// downpipe-shamir-share-v1 share file, or a downpipe-wrapped-identity-v1 encrypted key file. Each of those
// artefacts is well under four kilobytes, so a file larger than this ceiling is not a key at all. It is the
// wrong file, and reading it whole into browser memory with FileReader.readAsText before any parser looks at
// it buys nothing and costs a copy of whatever it was.
//
// The check runs on File.size BEFORE a FileReader is constructed, so the refusal happens without a byte of
// the file being read. It is the pre-read control the file-handling policy (engine/docs/security/file-
// handling.md) cites as the documented maximum for the console's file pickers, and the catalogue rows for
// those pickers cite it as their client validator. A size that cannot be measured (a File-like value with no
// numeric size, which a browser never produces) is let through to the parser rather than refused, so the
// guard can never turn a real key into a refusal on a runtime quirk.
//
// The refusal message names the byte count and the ceiling and nothing else. A file size is not a secret;
// a byte of the file's content would be, and none is read.
//
// House style: Australian English, no em dashes, no rule-of-three.

/** The maximum size, in bytes, of any file a console file picker reads: 64 KiB. */
export const CONSOLE_FILE_MAX_BYTES = 64 * 1024;

/**
 * oversizedFileReason returns the refusal message for a file whose size exceeds CONSOLE_FILE_MAX_BYTES, or
 * null when the file may be read. Pure, so a test can drive it without a DOM.
 */
export function oversizedFileReason(file: { size?: unknown }): string | null {
  const size = file.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= CONSOLE_FILE_MAX_BYTES) return null;
  return `that file is ${size} bytes, above the ${CONSOLE_FILE_MAX_BYTES}-byte limit for a key, share or encrypted key file, so it was not read`;
}

/**
 * readTextFileBounded reads a selected file as text in this browser, after the size check above. The
 * FileReader is constructed only once the size has passed, so an oversized file is refused with no read
 * started. Rejects with the refusal reason, or with "could not read that file" when the browser's read fails.
 */
export function readTextFileBounded(file: File): Promise<string> {
  const reason = oversizedFileReason(file);
  if (reason !== null) return Promise.reject(new Error(reason));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsText(file);
  });
}
