import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub } from './upstream-state-repo.ts';
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../src/constants.ts';
import { callCodexAlphaSearch, callCodexImagesGenerations, callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from '../src/fetch.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexQuotaSnapshotEntryMap, CodexUpstreamState } from '../src/state.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null };
const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } });
const responsesLiteModel = stubProviderModel({
  id: 'gpt-6-astra',
  display_name: 'gpt-6-astra',
  endpoints: { responses: {} },
  providerData: { useResponsesLite: true },
});
const imageModel = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { imagesGenerations: {}, imagesEdits: {} } });

const upstreamId = 'up_a';
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const farFutureAccessToken: CodexAccessTokenEntry = {
  token: 'at_kv',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

let currentRecord: UpstreamRecord;

// Mirrors what the data-plane refresh hook persists when a fresh token arrives.
const seedFreshAccessToken = (entry: CodexAccessTokenEntry = farFutureAccessToken): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: entry }] });
};

const seedAccountState = (overrides: Partial<CodexAccountCredential>): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, ...overrides }] });
};

const readQuotaEntry = (): CodexQuotaSnapshotEntryMap | null =>
  (currentRecord.state as CodexUpstreamState).accounts[0].quotaSnapshot;

// putCodexQuota fires-and-forgets via .catch(() => {}); yield to the task
// queue so the saveState promise resolves before the caller asserts on state.
const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: createUpstreamStateRepoStub(() => currentRecord, state => {
      currentRecord = { ...currentRecord, state: state as CodexUpstreamState };
    }),
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (status = 200): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
      c.close();
    },
  }),
  {
    status,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    }),
  },
);

const errorJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: new Headers({ 'content-type': 'application/json', ...extraHeaders }) });

const idToken = (planType = 'plus'): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({
    email: 'a@b.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc',
      chatgpt_user_id: 'usr',
      chatgpt_plan_type: planType,
    },
  })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

const idTokenWithoutPlan = (): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {} })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

describe('callCodexResponses — gates', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const result = await callCodexResponses({
      upstreamId, account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });
  test('continues to upstream when a cached rate-limited quota snapshot is still open', async () => {
    seedAccountState({
      accessToken: farFutureAccessToken,
      quotaSnapshot: {
        premium: {
          fetchedAt: new Date('2026-06-05T00:00:00.000Z').getTime(),
          data: { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', ratelimited_until: '2026-06-05T01:00:00.000Z' },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('callCodexResponses — token freshness', () => {
  test('refreshes before call when no cached access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', id_token: idToken() }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const responsesInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(responsesInit.headers).get('authorization')).toBe('Bearer at_new');
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.token).toBe('at_new');
  });

  test('reuses fresh state-cached access token without refreshing', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_kv');
  });

  test('persistTerminalState refresh_failed when /oauth/token returns app_session_terminated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('refresh_failed', expect.stringMatching(/gone/));
  });
});

describe('callCodexResponses — upstream classification', () => {
  test('happy path: 200 → ok:true, quota persisted', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.primary_used_percent).toBe(42);
    expect(stored?.premium.data.ratelimited_until).toBeUndefined();
  });

  test('upstream body has store:false and stream:true forced even if caller passes otherwise', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: false as unknown as true, store: true } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test('projects Responses Lite instructions and tools into stable input prefixes', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const request = {
      upstreamId,
      account: activeAccount,
      model: responsesLiteModel,
      body: {
        instructions: 'Base instructions.',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'exec', parameters: { type: 'object' } },
          {
            type: 'namespace',
            name: 'functions',
            description: 'Existing functions.',
            tools: [{ type: 'custom', name: 'shell', description: 'Run shell.' }],
          },
          { type: 'namespace', name: 'apps', description: 'Apps.', tools: [] },
        ],
        parallel_tool_calls: true,
        reasoning: { effort: 'high', context: 'current_turn' },
        stream: true,
      },
      headers: new Headers({ 'session-id': 'lite-thread' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } as unknown as Parameters<typeof callCodexResponses>[0];

    await callCodexResponses(request);
    await callCodexResponses({ ...request, headers: new Headers({ 'session-id': 'lite-thread' }) });

    const firstInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const first = await readJsonRequest(firstInit) as Record<string, unknown>;
    const second = await readJsonRequest(fetchSpy.mock.calls[1][1] as RequestInit) as Record<string, unknown>;
    const input = first.input as Array<Record<string, unknown>>;
    const additionalTools = input[0] as Record<string, unknown>;
    const tools = additionalTools.tools as Array<Record<string, unknown>>;

    expect(new Headers(firstInit.headers).get('x-openai-internal-codex-responses-lite')).toBe('true');
    expect(first).not.toHaveProperty('instructions');
    expect(first).not.toHaveProperty('tools');
    expect(first.parallel_tool_calls).toBe(false);
    expect(first.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
    expect(input[0]).toMatchObject({ type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/) });
    expect(input[1]).toEqual({
      type: 'message',
      id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      role: 'developer',
      content: [{ type: 'input_text', text: 'Base instructions.' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect(input[2]).toEqual({ type: 'message', role: 'user', content: 'hello' });
    expect(tools.map(tool => `${String(tool.type)}:${String(tool.name ?? '')}`)).toEqual([
      'web_search:',
      'namespace:functions',
      'namespace:apps',
    ]);
    expect(tools[1]).toEqual({
      type: 'namespace',
      name: 'functions',
      description: 'Existing functions.',
      tools: [
        { type: 'function', name: 'exec', parameters: { type: 'object' } },
        { type: 'custom', name: 'shell', description: 'Run shell.' },
      ],
    });
    expect((second.input as Array<Record<string, unknown>>).slice(0, 2)).toEqual(input.slice(0, 2));
  });

  test('does not duplicate an existing Responses Lite prefix', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId,
      account: activeAccount,
      model: responsesLiteModel,
      body: {
        input: [
          { type: 'additional_tools', role: 'developer', tools: [], id: 'at_existing' },
          { type: 'message', role: 'developer', content: 'already projected', id: 'msg_existing' },
          { type: 'message', role: 'user', content: 'hello' },
        ],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'lite-thread' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.filter(item => item.type === 'additional_tools')).toHaveLength(1);
    expect(input[0]?.id).toBe('at_existing');
  });

  test('builds Codex responses headers and metadata from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      isFedRampAccount: true,
      model,
      body: {
        input: [],
        stream: true,
        client_metadata: { 'x-codex-installation-id': 'downstream-installation' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers({
        'cf-connecting-ip': '203.0.113.10',
        forwarded: 'for=203.0.113.10',
        'openai-beta': 'responses=experimental',
        originator: 'downstream-originator',
        'session-id': 'downstream-session',
        'user-agent': 'curl/8.7.1',
        version: '1',
        'x-client-request-id': 'req-123',
        'x-codex-beta-features': 'responses_websockets=2026-02-06',
        'x-codex-turn-metadata': 'turn-meta',
        'x-codex-window-id': 'downstream-window',
        'x-real-ip': '203.0.113.10',
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('x-openai-fedramp')).toBe('true');
    expect(headers.get('originator')).toBe(CODEX_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CODEX_USER_AGENT);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('session-id')).toBe('downstream-session');
    expect(headers.get('session_id')).toBeNull();
    // Caller-supplied identity fields pass through; noise headers (cf-*,
    // forwarded, x-real-ip, openai-beta, x-codex-beta-features) are dropped.
    expect(headers.get('x-client-request-id')).toBe('req-123');
    expect(headers.get('thread-id')).toBe('downstream-session');
    expect(headers.get('x-codex-beta-features')).toBeNull();
    expect(headers.get('x-codex-window-id')).toBe('downstream-window');
    const turnMetadataJson = headers.get('x-codex-turn-metadata');
    const turnMetadata = JSON.parse(turnMetadataJson ?? 'null') as Record<string, unknown>;
    expect(turnMetadata).toEqual({
      installation_id: 'downstream-installation',
      session_id: 'downstream-session',
      thread_id: 'downstream-session',
      turn_id: expect.stringMatching(UUID_V7_RE),
      window_id: 'downstream-window',
      window_number: 0,
      context_window_id: expect.stringMatching(UUID_V7_RE),
      request_kind: 'turn',
    });
    // 'turn-meta' is not valid JSON; the unparseable blob is dropped and we
    // synthesize from identity instead.
    expect(headers.get('x-codex-turn-metadata')).not.toBe('turn-meta');
    expect(headers.get('cf-connecting-ip')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('openai-beta')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('downstream-session');
    expect(body.client_metadata).toEqual({
      'x-codex-installation-id': 'downstream-installation',
      session_id: turnMetadata.session_id,
      thread_id: turnMetadata.thread_id,
      'x-codex-window-id': turnMetadata.window_id,
      turn_id: turnMetadata.turn_id,
      'x-codex-turn-metadata': turnMetadataJson,
    });
  });

  test('synthesized Codex identity keeps supplied session and fallback window stable while rotating turn ids', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());
    const request = {
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'stable-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexResponses>[0];

    await callCodexResponses(request);
    await callCodexResponses({ ...request, headers: new Headers({ 'session-id': 'stable-session' }) });

    const firstHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('x-codex-window-id')).toBe('stable-session:0');
    expect(secondHeaders.get('x-codex-window-id')).toBe('stable-session:0');
    expect(firstHeaders.get('x-codex-turn-metadata')).not.toBe(secondHeaders.get('x-codex-turn-metadata'));
    expect(firstHeaders.get('x-client-request-id')).toBe('stable-session');
    expect(secondHeaders.get('x-client-request-id')).toBe('stable-session');
    const firstMetadata = JSON.parse(firstHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const secondMetadata = JSON.parse(secondHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(firstMetadata.installation_id).toBe(secondMetadata.installation_id);
    expect(firstMetadata.session_id).toBe('stable-session');
    expect(secondMetadata.session_id).toBe('stable-session');
    expect(firstMetadata.thread_id).toBe('stable-session');
    expect(secondMetadata.thread_id).toBe('stable-session');
    expect(firstMetadata.window_id).toBe('stable-session:0');
    expect(secondMetadata.window_id).toBe('stable-session:0');
    expect(firstMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(secondMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(firstMetadata.turn_id).not.toBe(secondMetadata.turn_id);
  });

  test('different sessions produce different synthesized window and turn metadata', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());

    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'session-a' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'session-b' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const firstHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('x-codex-window-id')).not.toBe(secondHeaders.get('x-codex-window-id'));
    expect(firstHeaders.get('x-codex-turn-metadata')).not.toBe(secondHeaders.get('x-codex-turn-metadata'));
    const firstMetadata = JSON.parse(firstHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const secondMetadata = JSON.parse(secondHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(firstMetadata.installation_id).toBe(secondMetadata.installation_id);
    expect(firstMetadata.session_id).toBe('session-a');
    expect(secondMetadata.session_id).toBe('session-b');
    expect(firstMetadata.window_id).toBe('session-a:0');
    expect(secondMetadata.window_id).toBe('session-b:0');
    expect(firstMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(secondMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(firstMetadata.turn_id).not.toBe(secondMetadata.turn_id);
    expect(firstMetadata.request_kind).toBe('turn');
    expect(secondMetadata.request_kind).toBe('turn');
  });

  test('defaults prompt_cache_key to the root session and preserves explicit values', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());

    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session', 'thread-id': 'child-thread' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: 'caller-cache-key' },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: null },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const injectedBody = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const preservedStringBody = await readJsonRequest(fetchSpy.mock.calls[1][1] as RequestInit) as Record<string, unknown>;
    const preservedNullBody = await readJsonRequest(fetchSpy.mock.calls[2][1] as RequestInit) as Record<string, unknown>;
    expect(injectedBody.prompt_cache_key).toBe('cache-session');
    expect(preservedStringBody.prompt_cache_key).toBe('caller-cache-key');
    expect(preservedNullBody).toHaveProperty('prompt_cache_key', null);
  });

  test('preserves a hyphenated Codex session id for prompt cache', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('cache-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('canonicalizes downstream session_id to the Codex session-id header', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ session_id: 'alias-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('alias-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('prefers downstream session-id over session_id when both are provided', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'canonical-session', session_id: 'alias-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('canonical-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('generates a Codex session id when the downstream request has none', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toMatch(UUID_V7_RE);
    expect(headers.get('thread-id')).toBe(headers.get('session-id'));
    expect(headers.get('session_id')).toBeNull();
  });

  test('derives the same session id across turns of a stateless conversation', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const turn = {
      upstreamId, account: activeAccount, model,
      body: {
        instructions: 'You are helpful.',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexResponses>[0];
    await callCodexResponses(turn);
    await callCodexResponses(turn);

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBeNull();
    expect(first).not.toMatch(UUID_V7_RE);
    expect(second).toBe(first);
  });

  test('derives distinct session ids when only the instructions differ', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const call = (instructions: string) => callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await call('You are a pirate.');
    await call('You are a scientist.');

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBe(second);
  });

  test('derives distinct session ids when only the first user message differs', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const call = (content: string) => callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions: 'System.',
        input: [{ type: 'message', role: 'user', content }],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await call('topic A');
    await call('topic B');

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBe(second);
  });

  test('uses account.openaiDeviceId as the installation id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const deviceId = '22222222-3333-4444-9555-666666666666';
    await callCodexResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: deviceId },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe(deviceId);
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe(deviceId);
  });

  test('prefers a caller-supplied installation id from client_metadata over the account device id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: 'account-device-id' },
      model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-codex-installation-id': 'caller-installation-id' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe('caller-installation-id');
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe('caller-installation-id');
  });

  test('passes through caller thread-id and x-client-request-id when distinct from session-id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({
        'session-id': 'sess',
        'thread-id': 'parent-thread',
        'x-client-request-id': 'req-xyz',
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('sess');
    expect(headers.get('thread-id')).toBe('parent-thread');
    expect(headers.get('x-client-request-id')).toBe('req-xyz');
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.session_id).toBe('sess');
    expect(turnMetadata.thread_id).toBe('parent-thread');
  });

  test('merges caller-supplied x-codex-turn-metadata extras over the synthesized blob', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({
        'session-id': 'sess',
        'x-codex-turn-metadata': JSON.stringify({
          turn_started_at_unix_ms: 1700000000000,
          thread_source: 'user',
          parent_thread_id: 'parent-thread',
          turn_id: 'caller-turn',
        }),
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.session_id).toBe('sess');
    expect(turnMetadata.turn_started_at_unix_ms).toBe(1700000000000);
    expect(turnMetadata.thread_source).toBe('user');
    expect(turnMetadata.parent_thread_id).toBe('parent-thread');
    expect(turnMetadata.turn_id).toBe('caller-turn');
    expect(turnMetadata.request_kind).toBe('turn');
    // turn_id propagates to body's client_metadata as well so the three
    // surfaces (header turn_metadata, body client_metadata, body
    // client_metadata.x-codex-turn-metadata) stay consistent.
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>).turn_id).toBe('caller-turn');
  });

  test('uses canonical body metadata before flat body and header projections', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-installation-id': 'flat-installation',
          session_id: 'flat-session',
          thread_id: 'flat-thread',
          turn_id: 'flat-turn',
          root_turn_id: 'flat-root-turn',
          'x-codex-window-id': 'flat-thread:7',
          'x-codex-turn-metadata': JSON.stringify({
            installation_id: 'canonical-installation',
            session_id: 'canonical-session',
            thread_id: 'canonical-thread',
            turn_id: 'canonical-turn',
            root_turn_id: 'canonical-root-turn',
            window_id: 'canonical-thread:2',
            window_number: 2,
            context_window_id: '019cba13-7d2c-75e2-bf79-c970d7bdfe42',
            request_kind: 'compaction',
            compaction: { trigger: 'auto', reason: 'context_limit' },
            turn_started_at_unix_ms: 1700000000002,
          }),
        },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      // A WebSocket upgrade's headers are frozen for the life of the socket,
      // so they carry the connection's first turn, not this one.
      headers: new Headers({
        'session-id': 'header-session',
        'x-codex-window-id': 'thread-1:0',
        'x-codex-turn-metadata': JSON.stringify({
          window_id: 'thread-1:0',
          window_number: 0,
          context_window_id: '019cba13-7d2c-75e1-88d4-91055dc0d7a9',
          request_kind: 'turn',
          turn_started_at_unix_ms: 1700000000000,
        }),
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.request_kind).toBe('compaction');
    expect(turnMetadata.compaction).toEqual({ trigger: 'auto', reason: 'context_limit' });
    expect(turnMetadata.turn_started_at_unix_ms).toBe(1700000000002);
    expect(turnMetadata.installation_id).toBe('canonical-installation');
    expect(turnMetadata.session_id).toBe('canonical-session');
    expect(turnMetadata.thread_id).toBe('canonical-thread');
    expect(turnMetadata.turn_id).toBe('canonical-turn');
    // The window advances on every auto-compaction and the advanced value
    // reaches us in the body alone.
    expect(turnMetadata.window_id).toBe('canonical-thread:2');
    expect(turnMetadata.window_number).toBe(2);
    expect(turnMetadata.context_window_id).toBe('019cba13-7d2c-75e2-bf79-c970d7bdfe42');
    expect(headers.get('x-codex-window-id')).toBe('canonical-thread:2');
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>).root_turn_id).toBe('canonical-root-turn');
  });

  test('keeps the unbounded tool inventory in the body blob and out of the header blob', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const toolNamespacesInfo = { namespaces: [{ name: 'shell', tools: ['exec'] }] };
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({ tool_namespaces_info: toolNamespacesInfo, thread_source: 'user' }),
        },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'sess' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const headerMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(headerMetadata.tool_namespaces_info).toBeUndefined();
    expect(headerMetadata.thread_source).toBe('user');

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const bodyMetadata = JSON.parse(
      (body.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
    ) as Record<string, unknown>;
    expect(bodyMetadata.tool_namespaces_info).toEqual(toolNamespacesInfo);
    expect(bodyMetadata.thread_source).toBe('user');
  });

  test('filters legacy and oversized metadata while bounding string extras', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const extras = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`extra_${index}`, `value-${index}`]));
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({
            request_kind: 'prewarm',
            agent_name: 'worker',
            tool_namespaces_info: { shell: { name: 'shell' } },
            code_mode_tool_names: ['legacy'],
            object_extra: { nested: true },
            'invalid key': 'value',
            oversized_extra: 'x'.repeat(129),
            ...extras,
          }),
        },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const headerMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const bodyMetadata = JSON.parse((body.client_metadata as Record<string, string>)['x-codex-turn-metadata']) as Record<string, unknown>;
    expect(bodyMetadata.request_kind).toBe('prewarm');
    expect(bodyMetadata.agent_name).toBe('worker');
    expect(bodyMetadata.tool_namespaces_info).toEqual({ shell: { name: 'shell' } });
    expect(headerMetadata.tool_namespaces_info).toBeUndefined();
    expect(bodyMetadata.code_mode_tool_names).toBeUndefined();
    expect(bodyMetadata.object_extra).toBeUndefined();
    expect(bodyMetadata['invalid key']).toBeUndefined();
    expect(bodyMetadata.oversized_extra).toBeUndefined();
    expect(bodyMetadata.extra_15).toBe('value-15');
    expect(bodyMetadata.extra_16).toBeUndefined();
  });

  test('omits turn and request identity from memory metadata', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({
            request_kind: 'memory',
            agent_name: 'memory-agent',
            session_id: 'memory-session',
            thread_id: 'memory-thread',
            turn_id: 'memory-turn',
            window_id: 'memory-thread:0',
            custom_label: 'memory',
          }),
        },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const metadata = JSON.parse((body.client_metadata as Record<string, string>)['x-codex-turn-metadata']) as Record<string, unknown>;
    expect(metadata).toEqual({ request_kind: 'memory', custom_label: 'memory' });
  });

  test('keeps only current flat client_metadata projections', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-extra-key': 'caller-supplied', root_turn_id: 'root-turn', session_id: '   ' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'header-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const clientMetadata = body.client_metadata as Record<string, unknown>;
    expect(clientMetadata.root_turn_id).toBe('root-turn');
    expect(clientMetadata['x-extra-key']).toBeUndefined();
    // A mirrored key identity could not absorb — a blank `session_id` resolves
    // to nothing, so identity falls back to the header — still comes from
    // identity instead of being spread over it.
    expect(clientMetadata.session_id).toBe('header-session');
    expect(clientMetadata.thread_id).toBe('header-session');
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('header-session');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken() }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    const firstMetadata = JSON.parse(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const retryMetadata = JSON.parse(new Headers((fetchSpy.mock.calls[2][1] as RequestInit).headers).get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(firstMetadata.window_number).toBe(0);
    expect(retryMetadata.window_number).toBe(0);
    expect(firstMetadata.context_window_id).toMatch(UUID_V7_RE);
    expect(retryMetadata.context_window_id).toBe(firstMetadata.context_window_id);
    expect(retryMetadata.turn_id).toBe(firstMetadata.turn_id);
    expect(await readJsonRequest(fetchSpy.mock.calls[2][1] as RequestInit)).toEqual(
      await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit),
    );
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached', resets_in_seconds: 7200 } }, {
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });

  test('retains a newly observed plan when the 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free') }))
      .mockResolvedValueOnce(sseResponse(401))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan() }))
      .mockResolvedValueOnce(sseResponse());
    const result = await callCodexResponses({
      upstreamId, account: activeAccount, model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });
});

describe('callCodexResponses — background-write registration', () => {
  // Background state writes (quota snapshot on 2xx/429, access-token put on
  // 401-retry) must reach the runtime's waitUntil slot so workerd does not
  // cancel them the instant the streaming response returns to the client.
  // Without this, freshly-minted Codex tokens and quota snapshots get dropped
  // on the floor and the next request re-mints / re-races the upstream.
  test('2xx persists quota snapshot via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  test('401-retry persists the fresh access token before returning', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken() }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    // The access-token write is awaited because its CAS result carries the
    // effective plan; only the successful retry's quota write is backgrounded.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.token).toBe('at2');
  });
});

describe('callCodexImagesGenerations', () => {
  test('does not replace a meaningful quota snapshot with a headerless image response', async () => {
    const quotaSnapshot: CodexQuotaSnapshotEntryMap = {
      premium: {
        fetchedAt: 1,
        data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'premium', primary_used_percent: 42 },
      },
    };
    seedAccountState({ accessToken: { ...farFutureAccessToken, planType: 'plus' }, quotaSnapshot });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(result.response.status).toBe(200);
    expect(readQuotaEntry()).toEqual(quotaSnapshot);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test('keeps image turn identity and originator stable across a 401 refresh retry', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('plus') }))
      .mockResolvedValueOnce(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      isFedRampAccount: true,
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers({ originator: 'chatgpt_cca' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    const imageCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'));
    expect(imageCalls).toHaveLength(2);
    const firstHeaders = new Headers((imageCalls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((imageCalls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('originator')).toBe('chatgpt_cca');
    expect(secondHeaders.get('originator')).toBe('chatgpt_cca');
    expect(firstHeaders.get('x-openai-fedramp')).toBe('true');
    expect(secondHeaders.get('x-openai-fedramp')).toBe('true');
    expect(firstHeaders.get('x-codex-image-turn-id')).toMatch(UUID_V7_RE);
    expect(secondHeaders.get('x-codex-image-turn-id')).toBe(firstHeaders.get('x-codex-image-turn-id'));
  });

  test('uses a refreshed Free plan before dispatching the image request', async () => {
    seedAccountState({ accessToken: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(200, {
      access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'),
    }));
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/oauth/token');
  });

  test('stops a 401 retry when the refreshed plan becomes Free', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, {
        access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'),
      }));
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'))).toHaveLength(1);
  });

  test('does not invalidate a sibling token that won before the 401 was handled', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, token: 'at_failed', planType: 'plus' });
    const winner: CodexAccessTokenEntry = {
      token: 'at_winner',
      expiresAt: farFutureAccessToken.expiresAt,
      refreshedAt: '2026-08-10T00:00:02.000Z',
      planType: 'free',
      planObservedAt: '2026-08-10T00:00:02.000Z',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      seedAccountState({ refresh_token: 'rt_winner', accessToken: winner });
      return errorJson(401, { error: { code: 'expired_token', message: 'expired' } });
    });
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: { ...activeAccount, accessToken: { ...farFutureAccessToken, token: 'at_failed', planType: 'plus' } },
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken).toEqual(winner);
  });

  test('keeps the latest known plan when a retry refresh omits the plan claim', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, {
        access_token: 'at2', refresh_token: 'rt_v2', id_token: idTokenWithoutPlan(),
      }))
      .mockResolvedValueOnce(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await callCodexImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'free',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'))).toHaveLength(2);
    await flushMicrotasks();
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('plus');
  });
});

// `callCodexResponsesCompact` shares OAuth + quota + 401-retry plumbing with
// `callCodexResponses` (both go through `prepareCodexCall` →
// `dispatchCodexHttpCall` → `refreshAccessTokenForRetry`). The streaming
// suite above pins those shared paths; this block exercises only the
// compact-specific wire contract — endpoint URL, `Accept: application/json`,
// body shape (no `stream`, no `store`), unary JSON decoding — plus the 401
// retry on the unary endpoint to confirm the retry decision is taken from
// the bare response status (no SSE wrap in the path).
const compactJsonResponse = (overrides?: Partial<ResponsesResult>): Response =>
  new Response(JSON.stringify({
    id: 'resp_x',
    object: 'response.compaction',
    model: 'gpt-5.4',
    status: 'completed',
    output: [{ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' }],
    usage: { input_tokens: 550, output_tokens: 167, total_tokens: 717 },
    ...overrides,
  }), {
    status: 200,
    headers: new Headers({
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    }),
  });

describe('callCodexResponsesCompact', () => {
  test('posts to /codex/responses/compact with application/json and no stream/store', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, isFedRampAccount: true, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hello' }] },
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    const headers = new Headers(init.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('x-openai-fedramp')).toBe('true');
    expect(headers.get('x-codex-installation-id')).toBe(activeAccount.openaiDeviceId);
    expect(headers.get('x-client-request-id')).toBeNull();

    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4');
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.stream).toBeUndefined();
    expect(body.store).toBeUndefined();

    expect(result.result.object).toBe('response.compaction');
    expect(result.result.output[0]).toMatchObject({ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' });
  });

  test('projects the Codex compact payload instead of the public OpenAI compact shape', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    await callCodexResponsesCompact({
      upstreamId,
      account: activeAccount,
      model,
      body: {
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        instructions: 'Base instructions.',
        tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' } }],
        parallel_tool_calls: true,
        reasoning: { effort: 'high', summary: 'concise' },
        service_tier: 'priority',
        prompt_cache_key: 'session-key',
        text: { verbosity: 'low' },
        previous_response_id: 'resp_previous',
        prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        prompt_cache_retention: '24h',
        stream: true,
        store: true,
        temperature: 0.2,
        access_programs: { cyber: 'daybreak_blue' },
      } as Parameters<typeof callCodexResponsesCompact>[0]['body'] & { access_programs: { cyber: string } },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit);
    expect(body).toEqual({
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      instructions: 'Base instructions.',
      tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' } }],
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'concise' },
      service_tier: 'priority',
      prompt_cache_key: 'session-key',
      text: { verbosity: 'low' },
      access_programs: { cyber: 'daybreak_blue' },
    });
  });

  test('uses the Responses Lite transport contract for compaction', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    await callCodexResponsesCompact({
      upstreamId,
      account: activeAccount,
      model: responsesLiteModel,
      body: {
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        instructions: 'Base instructions.',
      },
      headers: new Headers({ 'session-id': 'lite-thread' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    const body = await readJsonRequest(init) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    expect(headers.get('x-openai-internal-codex-responses-lite')).toBe('true');
    expect(body).not.toHaveProperty('instructions');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({ context: 'all_turns' });
    expect(input[0]).toMatchObject({ type: 'additional_tools', role: 'developer', tools: [] });
    expect(input[1]).toMatchObject({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Base instructions.' }] });
  });

  test('2xx persists quota snapshot via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  test('401 other → refresh + retry once on the compact endpoint, succeed', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken() }), { status: 200 }))
      .mockResolvedValueOnce(compactJsonResponse());
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    // Both compact requests hit the same URL; the bearer flipped from at_kv to at2.
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    const firstInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const retryInit = fetchSpy.mock.calls[2][1] as RequestInit;
    const firstHeaders = new Headers(firstInit.headers);
    const retryHeaders = new Headers(retryInit.headers);
    expect(retryHeaders.get('authorization')).toBe('Bearer at2');
    expect(retryHeaders.get('x-codex-installation-id')).toBe(firstHeaders.get('x-codex-installation-id'));
    expect(retryHeaders.get('x-client-request-id')).toBeNull();
    expect(retryHeaders.get('x-codex-turn-metadata')).toBe(firstHeaders.get('x-codex-turn-metadata'));
    expect(await readJsonRequest(retryInit)).toEqual(await readJsonRequest(firstInit));
  });

  test('retains a newly observed plan when the compact 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free') }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan() }))
      .mockResolvedValueOnce(compactJsonResponse());
    const result = await callCodexResponsesCompact({
      upstreamId,
      account: activeAccount,
      model,
      body: { input: [], instructions: 'compact' },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return synthetic 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached' } }, {
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through verbatim without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });

});

describe('callCodexAlphaSearch', () => {
  test('posts the search request to the ChatGPT Codex endpoint with selected model and account auth', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      encrypted_output: null,
      output: 'Search result',
      results: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      isFedRampAccount: true,
      model,
      body: { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers({ 'x-codex-turn-metadata': '{"turn_id":"turn-search"}' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    expect(result.response.status).toBe(200);
    expect(result.modelKey).toBe('gpt-5.4');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('x-openai-fedramp')).toBe('true');
    expect(headers.get('x-codex-turn-metadata')).toBe('{"turn_id":"turn-search"}');
    expect(await readJsonRequest(init)).toMatchObject({
      id: 'search-session',
      model: 'gpt-5.4',
      commands: { search_query: [{ q: 'Floway' }] },
    });
  });

  test('retains a newly observed plan when the search 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free') }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan() }))
      .mockResolvedValueOnce(errorJson(200, { encrypted_output: null, output: 'Search result', results: [] }));
    const result = await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      model,
      body: { commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });

  test('normalizes a missing request id and omits absent turn metadata', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: 'Search result' }), { status: 200 }));

    await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      model,
      body: { commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(headers.has('x-codex-turn-metadata')).toBe(false);
    expect(typeof body.id).toBe('string');
    expect(headers.get('session-id')).toBe(body.id);
    expect(headers.get('thread-id')).toBe(body.id);
    expect(headers.get('x-client-request-id')).toBe(body.id);
  });
});
