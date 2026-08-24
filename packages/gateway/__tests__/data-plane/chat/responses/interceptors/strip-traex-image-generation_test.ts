import { test } from 'vitest';

import {
  stripTraexImageGeneration,
  withTraexImageGenerationStripped,
} from '../../../../../src/data-plane/chat/responses/interceptors/strip-traex-image-generation.ts';
import type { ResponsesInvocation } from '../../../../../src/data-plane/chat/responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesTool } from '@floway-dev/protocols/responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const traexImageTool = (): ResponsesTool => ({
  type: 'namespace',
  name: 'image_gen',
  description: 'Tools in the image_gen namespace.',
  tools: [{
    type: 'function',
    name: 'imagegen',
    description: 'Generate an image.',
    parameters: { type: 'object', properties: {} },
    strict: false,
  }],
});

const functionTool = (name: string): ResponsesTool => ({
  type: 'function',
  name,
  parameters: { type: 'object', properties: {} },
  strict: false,
});

test('strips the TraeX image tool while preserving public and unrelated tools', () => {
  const payload: CanonicalResponsesPayload = {
    model: 'gpt-test',
    input: [],
    tools: [
      traexImageTool(),
      { type: 'image_generation' },
      functionTool('lookup'),
    ],
    tool_choice: 'auto',
  };

  const result = stripTraexImageGeneration(payload);

  assertEquals(result.tools, [
    { type: 'image_generation' },
    functionTool('lookup'),
  ]);
  assertEquals(result.tool_choice, 'auto');
  assertEquals(payload.tools?.[0], traexImageTool());
});

test('strips the reserved function from every Responses tool container', () => {
  const payload: CanonicalResponsesPayload = {
    model: 'gpt-test',
    tools: [functionTool('image_gen.imagegen'), functionTool('top-level-survivor')],
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{
          type: 'namespace',
          name: 'image_gen',
          description: 'mixed namespace',
          tools: [
            (traexImageTool() as Extract<ResponsesTool, { type: 'namespace' }>).tools[0]!,
            functionTool('survivor') as Extract<ResponsesTool, { type: 'function' }>,
          ],
        }],
      },
      { type: 'tool_search_output', tools: [traexImageTool()] },
    ],
  };

  const result = stripTraexImageGeneration(payload);

  assertEquals(result.tools, [functionTool('top-level-survivor')]);
  assertEquals(result.input, [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{
        type: 'namespace',
        name: 'image_gen',
        description: 'mixed namespace',
        tools: [functionTool('survivor')],
      }],
    },
    { type: 'tool_search_output', tools: [] },
  ]);
});

test('cleans forced choices that still point at the stripped tool', () => {
  const forced = stripTraexImageGeneration({
    model: 'gpt-test',
    input: [],
    tools: [traexImageTool()],
    tool_choice: { type: 'function', name: 'image_gen.imagegen' },
  });
  assertEquals(Object.hasOwn(forced, 'tools'), false);
  assertEquals(Object.hasOwn(forced, 'tool_choice'), false);

  const allowed = stripTraexImageGeneration({
    model: 'gpt-test',
    input: [],
    tools: [traexImageTool(), functionTool('lookup')],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'required',
      tools: [
        { type: 'function', name: 'image_gen.imagegen' },
        { type: 'function', name: 'lookup' },
      ],
    },
  });
  assertEquals(allowed.tool_choice, {
    type: 'allowed_tools',
    mode: 'required',
    tools: [{ type: 'function', name: 'lookup' }],
  });

  const required = stripTraexImageGeneration({
    model: 'gpt-test',
    input: [],
    tools: [traexImageTool()],
    tool_choice: 'required',
  });
  assertEquals(Object.hasOwn(required, 'tool_choice'), false);
});

test('preserves near matches and the original payload object', () => {
  const payload: CanonicalResponsesPayload = {
    model: 'gpt-test',
    input: [],
    tools: [
      functionTool('imagegen'),
      {
        type: 'namespace',
        name: 'other',
        description: 'other namespace',
        tools: [(traexImageTool() as Extract<ResponsesTool, { type: 'namespace' }>).tools[0]!],
      },
      {
        type: 'namespace',
        name: 'image_gen',
        description: 'custom tool with the same local name',
        tools: [{ type: 'custom', name: 'imagegen' }],
      },
    ],
  };

  assert(stripTraexImageGeneration(payload) === payload);
});

test('interceptor applies across target APIs when its flag is on', async () => {
  const stubCtx = mockChatGatewayCtx();
  const okEvents = () => Promise.resolve(eventResult(
    (async function* () {
      yield doneFrame();
    })(),
    testTelemetryModelIdentity,
  ));

  for (const targetApi of ['responses', 'messages', 'chat-completions'] as const) {
    const invocation: ResponsesInvocation = {
      payload: { model: 'gpt-test', input: [], tools: [traexImageTool()] },
      candidate: stubModelCandidate({ enabledFlags: new Set<FlagId>(['strip-traex-image-generation-tool']) }),
      targetApi,
      headers: new Headers(),
      action: 'generate',
    };

    await withTraexImageGenerationStripped(invocation, stubCtx, okEvents);

    assertEquals(Object.hasOwn(invocation.payload, 'tools'), false);
  }
});

test('interceptor preserves the request when its flag is off', async () => {
  const stubCtx = mockChatGatewayCtx();
  const invocation: ResponsesInvocation = {
    payload: { model: 'gpt-test', input: [], tools: [traexImageTool()] },
    candidate: stubModelCandidate({ enabledFlags: new Set() }),
    targetApi: 'responses',
    headers: new Headers(),
    action: 'generate',
  };

  await withTraexImageGenerationStripped(invocation, stubCtx, () => Promise.resolve(eventResult(
    (async function* () {
      yield doneFrame();
    })(),
    testTelemetryModelIdentity,
  )));

  assertEquals(invocation.payload.tools, [traexImageTool()]);
});
