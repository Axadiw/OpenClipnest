/**
 * Validates an OAuth 2.1 redirect URI per RFC 8252 §7.3 + OAuth 2.1 BCP:
 * - `https://` to any host is allowed.
 * - `http://` is allowed ONLY for loopback (localhost / 127.0.0.1 / [::1])
 *   with any port, to support native-app callbacks.
 * - Everything else rejected.
 */
export function isValidOauthRedirectUri(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return false;
  let parsed: URL;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]';
  }
  return false;
}
