/**
 * Validate a credential that will be placed into an HTTP header (a bearer
 * token, an access token, a password). HTTP header values are ByteStrings, so
 * every character must be <= 0xFF and not a control character; a token pasted
 * with a stray space, newline, or a hidden/box-drawing character (e.g. copied
 * out of a rendered table) otherwise makes Node throw the cryptic
 * "Cannot convert argument to a ByteString ..." deep in fetch.
 *
 * Trims surrounding whitespace and throws a clear, user-facing Error on any
 * invalid character so the caller can return a helpful 400 instead.
 */
export function cleanCredential(value, label = 'value') {
  if (value == null) return value;
  const trimmed = String(value).trim();
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    // > 0xFF: non-Latin1 (e.g. a box-drawing │). control chars (except tab).
    if (code > 255 || (code < 32 && code !== 9) || code === 127) {
      throw new Error(`That ${label} contains an invalid character. Re-copy it, it may have picked up a stray space, line break, or hidden character.`);
    }
  }
  return trimmed;
}
