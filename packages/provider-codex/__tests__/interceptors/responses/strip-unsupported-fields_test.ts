import { test } from 'vitest';

import { stripUnsupportedFields } from '../../../src/interceptors/responses/strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from '../../../src/interceptors/responses/types.ts';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, assertFalse, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('drops unverified fields while projecting supported Codex stream options', async () => {
  // Several fields reach Codex only through permissive callers. Widen through
  // unknown so the test covers the complete compatibility filter.
  const ctx = invocation({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    max_output_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    user: 'caller-id',
    metadata: { trace_id: 'abc' },
    prompt_cache_retention: '24h',
    safety_identifier: 'caller-supplied',
    stream_options: { reasoning_summary_delivery: 'sequential_cutoff', include_usage: true },
  } as unknown as CanonicalResponsesPayload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertFalse('max_output_tokens' in ctx.payload);
  assertFalse('temperature' in ctx.payload);
  assertFalse('top_p' in ctx.payload);
  assertFalse('frequency_penalty' in ctx.payload);
  assertFalse('presence_penalty' in ctx.payload);
  assertFalse('user' in ctx.payload);
  assertFalse('metadata' in ctx.payload);
  assertFalse('prompt_cache_retention' in ctx.payload);
  assertFalse('safety_identifier' in ctx.payload);
  assertEquals(ctx.payload.stream_options, { reasoning_summary_delivery: 'sequential_cutoff' });
});

test('drops generic stream options without the Codex-supported field', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [],
    stream_options: { include_usage: true },
  } as unknown as CanonicalResponsesPayload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertFalse('stream_options' in ctx.payload);
});

test('leaves supported fields intact', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    instructions: 'be terse',
    prompt_cache_options: { mode: 'future_mode', ttl: '1h' },
    stream: true,
    store: false,
    temperature: 0.7,
  });

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.model, 'gpt-test');
  assertEquals(ctx.payload.input, [{ type: 'message', role: 'user', content: 'hello' }]);
  assertEquals(ctx.payload.instructions, 'be terse');
  assertEquals(ctx.payload.prompt_cache_options, { mode: 'future_mode', ttl: '1h' });
  assertEquals(ctx.payload.stream, true);
  assertEquals(ctx.payload.store, false);
  assertFalse('temperature' in ctx.payload);
});

test('payload without any unsupported fields is preserved as-is', async () => {
  const payload: CanonicalResponsesPayload = { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] };
  const ctx = invocation(payload);

  await stripUnsupportedFields(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });
});
