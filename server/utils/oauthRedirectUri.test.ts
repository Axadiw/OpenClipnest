import { describe, it, expect } from 'vitest';
import { isValidOauthRedirectUri } from './oauthRedirectUri.js';

describe('isValidOauthRedirectUri', () => {
  const cases: Array<{ name: string; input: unknown; expected: boolean }> = [
    // --- valid https ---
    { name: 'https with host and path',          input: 'https://example.com/cb',         expected: true },
    { name: 'https with explicit port',          input: 'https://example.com:8443/cb',     expected: true },
    { name: 'https with query',                  input: 'https://example.com/cb?x=1',      expected: true },
    { name: 'https to loopback (also fine)',     input: 'https://localhost/cb',            expected: true },

    // --- valid http loopback ---
    { name: 'http localhost no port',            input: 'http://localhost/cb',             expected: true },
    { name: 'http localhost with port',          input: 'http://localhost:8080/cb',        expected: true },
    { name: 'http 127.0.0.1 with port',          input: 'http://127.0.0.1:5173/cb',        expected: true },
    { name: 'http [::1] IPv6 loopback',          input: 'http://[::1]:8080/cb',            expected: true },
    { name: 'http localhost with path & query',  input: 'http://localhost:33333/cb?x=1',   expected: true },

    // --- invalid http non-loopback ---
    { name: 'http to attacker.com',              input: 'http://attacker.com/cb',          expected: false },
    { name: 'http to 192.168.1.1 (LAN, not loopback)', input: 'http://192.168.1.1/cb',     expected: false },
    { name: 'http to 0.0.0.0 (not loopback per spec)', input: 'http://0.0.0.0/cb',         expected: false },
    { name: 'http to ::1 without brackets (URL parser rejects)', input: 'http://::1/cb',   expected: false },

    // --- invalid scheme ---
    { name: 'ftp scheme',                        input: 'ftp://example.com/cb',            expected: false },
    { name: 'file scheme',                       input: 'file:///etc/passwd',              expected: false },
    { name: 'data scheme',                       input: 'data:text/html,<script>',         expected: false },
    { name: 'javascript scheme',                 input: 'javascript:alert(1)',             expected: false },
    { name: 'about:blank',                       input: 'about:blank',                     expected: false },

    // --- invalid syntax ---
    { name: 'plain word',                        input: 'not-a-url',                       expected: false },
    { name: 'http://x bare host with no TLD',    input: 'http://x',                        expected: false },
    { name: 'just a path',                       input: '/cb',                             expected: false },
    { name: 'empty string',                      input: '',                                expected: false },

    // --- non-string input ---
    { name: 'undefined',                         input: undefined,                         expected: false },
    { name: 'null',                              input: null,                              expected: false },
    { name: 'number',                            input: 123,                               expected: false },
    { name: 'object',                            input: { url: 'https://x.com' },          expected: false },
    { name: 'array',                             input: ['https://x.com'],                 expected: false },
    { name: 'boolean',                           input: true,                              expected: false },

    // --- oversized URL ---
    { name: 'over 2048 chars',                   input: 'https://example.com/' + 'a'.repeat(2048), expected: false },
  ];

  for (const c of cases) {
    it(`${c.expected ? 'accepts' : 'rejects'}: ${c.name}`, () => {
      expect(isValidOauthRedirectUri(c.input)).toBe(c.expected);
    });
  }
});
