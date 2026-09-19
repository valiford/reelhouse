/** Client diagnostics stay bounded and redacted: message text only —
 *  never payloads, headers, or URLs, which can carry household queries. */
const MAX_DIAGNOSTIC_CHARS = 200;

export function boundedMessage(error: unknown, max: number = MAX_DIAGNOSTIC_CHARS): string {
  const raw =
    error instanceof Error ? error.message
    : typeof error === "string" ? error
    : "unknown error";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
