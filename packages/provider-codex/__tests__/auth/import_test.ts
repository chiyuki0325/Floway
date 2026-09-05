import { afterEach, describe, expect, test, vi } from 'vitest';

import { importCodexFromAuthJson, importCodexFromCallback } from '../../src/auth/import.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

const encodeBase64Url = (input: string): string => {
  const b64 = btoa(input);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const makeJwt = (payload: unknown): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

const identityPayload = {
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc', chatgpt_user_id: 'usr' },
  'https://api.openai.com/profile': { email: 'a@b.com' },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('importCodexFromAuthJson', () => {
  test('happy path returns identity + tokens', async () => {
    const accessToken = makeJwt({ exp: 1_800_000_000 });
    const authJson = JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: 'rt1',
        id_token: makeJwt(identityPayload),
        account_id: 'acc',
      },
    });
    const result = await importCodexFromAuthJson(authJson);
    expect(result.config.accounts).toEqual([{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus', isFedRampAccount: false }]);
    expect(result.state.accounts[0].chatgptAccountId).toBe('acc');
    expect(result.state.accounts[0].refresh_token).toBe('rt1');
    expect(result.state.accounts[0].state).toBe('active');
    expect(result.state.accounts[0].accessToken?.token).toBe(accessToken);
    expect(result.state.accounts[0].accessToken?.planType).toBe('plus');
    expect(result.state.accounts[0].accessToken?.planObservedAt).toBe(result.state.accounts[0].accessToken?.refreshedAt);
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(1_800_000_000_000);
    expect(result.state.accounts[0].openaiDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('marks an imported access token without a valid exp immediately stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    const result = await importCodexFromAuthJson(JSON.stringify({
      tokens: {
        access_token: 'not-a-jwt',
        refresh_token: 'rt1',
        id_token: makeJwt(identityPayload),
      },
    }));
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(Date.now());
  });

  test('rejects malformed payload', async () => {
    await expect(importCodexFromAuthJson('not json')).rejects.toThrow(/not valid JSON/);
    await expect(importCodexFromAuthJson('null')).rejects.toThrow();
    await expect(importCodexFromAuthJson('{}')).rejects.toThrow(/tokens/);
    await expect(importCodexFromAuthJson(JSON.stringify({ tokens: { refresh_token: 'r', id_token: makeJwt(identityPayload) } }))).rejects.toThrow(/access_token/);
  });

  test('persists optional identity and FedRAMP claims', async () => {
    const result = await importCodexFromAuthJson(JSON.stringify({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: makeJwt({
          'https://api.openai.com/auth': { chatgpt_account_is_fedramp: true },
        }),
      },
    }));
    expect(result.config.accounts).toEqual([{ isFedRampAccount: true }]);
    expect(result.state.accounts[0].chatgptAccountId).toBeUndefined();
    expect(result.state.accounts[0].accessToken?.planType).toBeUndefined();
  });
});

describe('importCodexFromCallback', () => {
  test('exchanges code → tokens, parses identity, returns config+state', async () => {
    const accessToken = makeJwt({ exp: 1_800_000_000 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: accessToken, refresh_token: 'rt', id_token: makeJwt(identityPayload),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result.config.accounts[0].email).toBe('a@b.com');
    expect(result.state.accounts[0].refresh_token).toBe('rt');
    expect(result.state.accounts[0].accessToken?.token).toBe(accessToken);
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(1_800_000_000_000);
    expect(result.state.accounts[0].accessToken?.planType).toBe('plus');
    expect(result.state.accounts[0].accessToken?.planObservedAt).toBe(result.state.accounts[0].accessToken?.refreshedAt);
    expect(result.state.accounts[0].openaiDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('uses an immediately stale expiry when the access token has no valid exp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'not-a-jwt', refresh_token: 'rt', id_token: makeJwt(identityPayload),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(Date.now());
  });

  test('routes the token exchange through the supplied fetcher', async () => {
    const fetcher = vi.fn<Fetcher>(async () => new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', id_token: makeJwt(identityPayload),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await importCodexFromCallback({ code: 'CODE', codeVerifier: 'VER', fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://auth.openai.com/oauth/token');
  });
});
