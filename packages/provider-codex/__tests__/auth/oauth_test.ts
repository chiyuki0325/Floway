import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildCodexAuthorizeUrl, CodexOAuthSessionTerminatedError, exchangeCodexAuthorizationCode, refreshCodexAccessToken } from '../../src/auth/oauth.ts';
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../../src/constants.ts';
import { directFetcher } from '@floway-dev/provider';

const okResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const errorResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

test('buildCodexAuthorizeUrl preserves the Codex CLI query surface and order', () => {
  expect(buildCodexAuthorizeUrl({ state: 'STATE', codeChallenge: 'CHALLENGE' })).toBe(
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs',
  );
});

describe('exchangeCodexAuthorizationCode', () => {
  test('POSTs form data and returns parsed tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      access_token: 'at', refresh_token: 'rt', id_token: 'it',
    }));
    const result = await exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher });
    expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', id_token: 'it' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('content-type')).toMatch(/application\/x-www-form-urlencoded/);
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('originator')).toBeNull();
    const body = (init as RequestInit).body as string;
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('CODE');
    expect(params.get('code_verifier')).toBe('VER');
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  test('keeps app_session_terminated generic on authorization-code exchange', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'app_session_terminated', message: 'Session ended' } }));
    await expect(exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher })).rejects.toThrow(/returned 400/);
  });

  test('throws generic error on other 4xx, message includes status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'invalid_grant', message: 'bad code' } }));
    await expect(exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher: directFetcher })).rejects.toThrow(/400/);
  });
});

describe('refreshCodexAccessToken', () => {
  test('POSTs the current Codex JSON refresh contract', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ access_token: 'at2', refresh_token: 'rt2', id_token: 'it2' }));
    const result = await refreshCodexAccessToken('rt_old', directFetcher);
    expect(result).toEqual({ access_token: 'at2', refresh_token: 'rt2', id_token: 'it2' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(CODEX_USER_AGENT);
    expect(headers.get('originator')).toBe(CODEX_ORIGINATOR);
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'rt_old',
    });
  });

  test('accepts omitted and null token fields without inventing replacements', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okResponse({ access_token: 'at2', refresh_token: null }))
      .mockResolvedValueOnce(okResponse({}));
    await expect(refreshCodexAccessToken('rt_old', directFetcher)).resolves.toEqual({ access_token: 'at2' });
    await expect(refreshCodexAccessToken('rt_old', directFetcher)).resolves.toEqual({});
  });

  test.each([
    ['access_token', 42],
    ['refresh_token', ''],
    ['id_token', false],
  ])('rejects malformed %s', async (key, value) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ [key]: value }));
    await expect(refreshCodexAccessToken('rt_old', directFetcher)).rejects.toThrow(new RegExp(`malformed ${key}`));
  });

  test.each([
    ['nested code', 400, { error: { code: 'refresh_token_expired', message: 'expired' } }],
    ['string error', 400, { error: 'refresh_token_reused' }],
    ['top-level code', 500, { code: 'refresh_token_invalidated', detail: 'invalidated' }],
  ])('classifies permanent refresh failure from %s', async (_shape, status, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(status, body));
    await expect(refreshCodexAccessToken('rt_dead', directFetcher)).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError);
  });

  test('classifies every HTTP 401 refresh failure as permanent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(401, { detail: 'unauthorized' }));
    const error = await refreshCodexAccessToken('rt_dead', directFetcher).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect((error as CodexOAuthSessionTerminatedError).code).toBe('http_401');
  });

  test('classifies case-insensitive invalid_grant on HTTP 400 as permanent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(400, { error: { code: 'Invalid_Grant', message: 'replayed' } }));
    const error = await refreshCodexAccessToken('rt_replayed', directFetcher).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexOAuthSessionTerminatedError);
    expect((error as CodexOAuthSessionTerminatedError).code).toBe('Invalid_Grant');
  });

  test.each([
    [400, { error: { code: 'app_session_terminated', message: 'gone' } }],
    [500, { error: { code: 'invalid_grant', message: 'server failure' } }],
    [503, { error: { code: 'temporarily_unavailable', message: 'retry' } }],
  ])('keeps non-permanent HTTP %s refresh failure transient', async (status, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(status, body));
    await expect(refreshCodexAccessToken('rt_retry', directFetcher)).rejects.toThrow(new RegExp(`returned ${status}`));
  });
});
