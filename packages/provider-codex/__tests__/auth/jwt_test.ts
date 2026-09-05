import { describe, expect, test } from 'vitest';

import { parseCodexAccessTokenExpiresAt, parseCodexIdTokenClaims } from '../../src/auth/jwt.ts';

// Helper builds a minimal JWT with given payload. Signature segment is fake.
const encodeBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const makeJwt = (payload: unknown): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

describe('parseCodexAccessTokenExpiresAt', () => {
  test('converts an integer Unix expiration to milliseconds', () => {
    expect(parseCodexAccessTokenExpiresAt(makeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(parseCodexAccessTokenExpiresAt(makeJwt({ exp: 1 }))).toBe(1000);
  });

  test.each([
    makeJwt({}),
    makeJwt({ exp: '1800000000' }),
    makeJwt({ exp: 1.5 }),
    makeJwt({ exp: Number.MAX_SAFE_INTEGER }),
    'not-a-jwt',
    'aaa.!!!.bbb',
  ])('returns undefined for missing or malformed expiration', token => {
    expect(parseCodexAccessTokenExpiresAt(token)).toBeUndefined();
  });
});

describe('parseCodexIdTokenClaims', () => {
  test('extracts all identity claims', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acc_123',
        chatgpt_user_id: 'user-abc',
      },
      'https://api.openai.com/profile': { email: 'a@b.com' },
    });
    expect(parseCodexIdTokenClaims(token)).toEqual({
      email: 'a@b.com',
      chatgptAccountId: 'acc_123',
      chatgptUserId: 'user-abc',
      planType: 'plus',
      isFedRampAccount: false,
    });
  });

  test('rejects token without 3 segments', () => {
    expect(() => parseCodexIdTokenClaims('not.a.jwt.really')).toThrow(/3 segments/);
    expect(() => parseCodexIdTokenClaims('one.two')).toThrow(/3 segments/);
  });

  test('rejects token whose payload is not base64url-decodable JSON', () => {
    expect(() => parseCodexIdTokenClaims('aaa.!!!.bbb')).toThrow();
  });

  test('allows absent auth and identity claims', () => {
    expect(parseCodexIdTokenClaims(makeJwt({}))).toEqual({ isFedRampAccount: false });
  });

  test('prefers top-level email and falls back to auth.user_id', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { user_id: 'legacy-user' },
      'https://api.openai.com/profile': { email: 'profile@example.com' },
      email: 'top-level@example.com',
    });
    expect(parseCodexIdTokenClaims(token)).toEqual({
      email: 'top-level@example.com',
      chatgptUserId: 'legacy-user',
      isFedRampAccount: false,
    });
  });

  test('extracts the FedRAMP account flag', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_is_fedramp: true },
    });
    expect(parseCodexIdTokenClaims(token)).toEqual({ isFedRampAccount: true });
  });

  test('handles base64url padding-free encoding (real OpenAI tokens have no padding)', () => {
    // encodeBase64Url already strips padding, matching real OpenAI tokens.
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
    });
    expect(parseCodexIdTokenClaims(token).chatgptAccountId).toBe('a');
  });

  test('rejects noncanonical JWT payload encodings', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_user_id: 'u', chatgpt_plan_type: 'plus' },
      'https://api.openai.com/profile': { email: 'a@b' },
      x: '',
    });
    const [header, payload, signature] = token.split('.');
    expect(payload?.endsWith('Q')).toBe(true);
    expect(() => parseCodexIdTokenClaims(`${header}.${payload}=.${signature}`)).toThrow();
    expect(() => parseCodexIdTokenClaims(`${header}.${payload}\n.${signature}`)).toThrow();
    expect(() => parseCodexIdTokenClaims(`${header}.${payload!.slice(0, -1)}R.${signature}`)).toThrow();
  });
});
