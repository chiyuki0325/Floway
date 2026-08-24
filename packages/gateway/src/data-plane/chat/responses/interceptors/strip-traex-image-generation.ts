import type { ResponsesInterceptor } from './types.ts';
import type { CanonicalResponsesPayload, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

// TraeX uploads ChatGPT's private image tool as a client-defined
// `image_gen.imagegen` function. GPT reserves that qualified name and rejects
// TraeX's mismatched schema before inference. Remove only that private tool;
// the public Responses `{ type: 'image_generation' }` tool remains available
// to Floway's provider-independent server-tool shim.
//
// References:
// - https://www.trae.ai/
// - https://developers.openai.com/api/docs/guides/tools-image-generation
// - https://github.com/openai/codex/blob/a25e986323931ec54909b0cd936b612f30c8ce46/codex-rs/rollout-trace/src/tool_dispatch.rs#L267
const TRAEX_IMAGE_NAMESPACE = 'image_gen';
const TRAEX_IMAGE_FUNCTION = 'imagegen';
const TRAEX_QUALIFIED_IMAGE_FUNCTION = `${TRAEX_IMAGE_NAMESPACE}.${TRAEX_IMAGE_FUNCTION}`;

interface FilteredTools {
  readonly tools: ResponsesTool[];
  readonly removed: boolean;
}

const filterTraexImageGenerationTools = (tools: readonly ResponsesTool[]): FilteredTools => {
  let removed = false;
  const filtered: ResponsesTool[] = [];

  for (const tool of tools) {
    if (tool.type === 'function' && tool.name === TRAEX_QUALIFIED_IMAGE_FUNCTION) {
      removed = true;
      continue;
    }

    if (tool.type !== 'namespace' || tool.name !== TRAEX_IMAGE_NAMESPACE) {
      filtered.push(tool);
      continue;
    }

    const nested = tool.tools.filter(candidate => candidate.type !== 'function' || candidate.name !== TRAEX_IMAGE_FUNCTION);
    if (nested.length === tool.tools.length) {
      filtered.push(tool);
      continue;
    }

    removed = true;
    if (nested.length > 0) filtered.push({ ...tool, tools: nested });
  }

  return { tools: removed ? filtered : [...tools], removed };
};

const isTraexImageGenerationChoice = (choice: ResponsesToolChoice): boolean =>
  typeof choice === 'object'
  && choice !== null
  && choice.type === 'function'
  && choice.name === TRAEX_QUALIFIED_IMAGE_FUNCTION;

const isTraexImageGenerationAllowedTool = (tool: Record<string, unknown>): boolean =>
  tool.type === 'function' && tool.name === TRAEX_QUALIFIED_IMAGE_FUNCTION;

const hasDeclaredTools = (payload: CanonicalResponsesPayload): boolean => {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return true;
  return payload.input.some(item => (item.type === 'additional_tools' || item.type === 'tool_search_output') && item.tools.length > 0);
};

const cleanToolChoice = (payload: CanonicalResponsesPayload): void => {
  const choice = payload.tool_choice;
  if (choice === undefined || choice === null) return;

  if (isTraexImageGenerationChoice(choice)) {
    delete payload.tool_choice;
    return;
  }

  if (typeof choice === 'object' && choice.type === 'allowed_tools') {
    const tools = choice.tools.filter(tool => !isTraexImageGenerationAllowedTool(tool));
    if (tools.length === choice.tools.length) return;
    if (tools.length === 0) {
      delete payload.tool_choice;
    } else {
      payload.tool_choice = { ...choice, tools };
    }
    return;
  }

  if (choice === 'required' && !hasDeclaredTools(payload)) delete payload.tool_choice;
};

export const stripTraexImageGeneration = (payload: CanonicalResponsesPayload): CanonicalResponsesPayload => {
  const topLevel = Array.isArray(payload.tools)
    ? filterTraexImageGenerationTools(payload.tools)
    : { tools: [], removed: false };
  let removed = topLevel.removed;

  const input = payload.input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const nested = filterTraexImageGenerationTools(item.tools);
    if (!nested.removed) return item;
    removed = true;
    return { ...item, tools: nested.tools };
  });

  if (!removed) return payload;

  const next: CanonicalResponsesPayload = { ...payload, input };
  if (topLevel.removed) {
    if (topLevel.tools.length === 0) {
      delete next.tools;
    } else {
      next.tools = topLevel.tools;
    }
  }
  cleanToolChoice(next);
  return next;
};

export const withTraexImageGenerationStripped: ResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('strip-traex-image-generation-tool')) return await run();
  ctx.payload = stripTraexImageGeneration(ctx.payload);
  return await run();
};
