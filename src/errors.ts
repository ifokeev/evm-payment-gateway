export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeErrorText(error: unknown): string {
  return errorText(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{128,}/gi, "[redacted-hex]");
}
