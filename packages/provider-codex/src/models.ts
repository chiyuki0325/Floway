import {
  CODEX_BACKEND_BASE,
  CODEX_CLI_VERSION,
  CODEX_FEDRAMP_HEADER,
  CODEX_IMAGE_MODEL_ID,
  CODEX_MODELS_PATH,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from './constants.ts';
import { GPT_IMAGE_2_PRICING, pricingForCodexModelKey } from './pricing.ts';
import { type Fetcher, type FlagId, type ProviderModel, type UpstreamChatModelConfig } from '@floway-dev/provider';

export type CodexInputModality = 'text' | 'image' | 'audio';

export interface CodexReasoningLevel {
  effort: string;
  description: string;
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexCatalogCapabilities {
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent: number;
  input_modalities: readonly CodexInputModality[];
  supported_reasoning_levels?: readonly CodexReasoningLevel[];
  default_reasoning_level?: string;
  use_responses_lite: boolean;
  support_verbosity?: boolean;
  default_verbosity?: string | null;
  service_tiers?: readonly CodexServiceTier[];
  default_service_tier?: string | null;
  additional_speed_tiers?: readonly string[];
  supports_search_tool?: boolean;
  web_search_tool_type?: string;
  supports_reasoning_summary_parameter?: boolean;
  default_reasoning_summary?: string;
  shell_type?: string;
  apply_patch_tool_type?: string | null;
  truncation_policy?: { mode: string; limit: number };
  supports_image_detail_original?: boolean;
  experimental_supported_tools?: readonly string[];
  auto_compact_token_limit?: number | null;
  comp_hash?: string | null;
  model_messages?: Record<string, unknown> | null;
  include_skills_usage_instructions?: boolean;
  include_plugin_usage_instructions?: boolean;
  include_apps_usage_instructions?: boolean;
  node_repl_auto_review_required?: boolean;
  node_repl_disabled?: boolean;
  auto_review_model_override?: string | null;
  model_specialty?: string | null;
  tool_mode?: string | null;
  multi_agent_version?: string | null;
  multi_agent_reasoning_effort?: string | null;
}

export interface CodexRawModel {
  id: string;
  display_name: string;
  context_window: number;
  input_modalities?: readonly CodexInputModality[];
  reasoning_efforts?: readonly string[];
  default_reasoning_effort?: string;
  use_responses_lite?: boolean;
  catalog?: CodexCatalogCapabilities;
}

export interface CodexProviderModelData {
  useResponsesLite?: true;
  catalog?: CodexCatalogCapabilities;
}

// `fetcher` is required so the catalog refresh traverses the same proxy/
// dial chain configured for request-time traffic.
export const fetchCodexCatalog = async (opts: { accessToken: string; accountId?: string; isFedRampAccount?: boolean; signal?: AbortSignal; fetcher: Fetcher }): Promise<CodexRawModel[]> => {
  const headers = new Headers({
    authorization: `Bearer ${opts.accessToken}`,
    originator: CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
    accept: 'application/json',
  });
  if (opts.accountId !== undefined) headers.set('chatgpt-account-id', opts.accountId);
  if (opts.isFedRampAccount === true) headers.set(CODEX_FEDRAMP_HEADER, 'true');
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_MODELS_PATH}?client_version=${CODEX_CLI_VERSION}`, {
    method: 'GET',
    headers,
    signal: opts.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Codex /models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Codex /models response missing models array');
  return parsed.models.map(assertRawModel);
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const codexModelUsesResponsesLite = (model: ProviderModel): boolean =>
  isPlainRecord(model.providerData) && model.providerData.useResponsesLite === true;

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} malformed`);
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${field} malformed`);
  return value;
};

const optionalNullableString = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new TypeError(`${field} malformed`);
  return value;
};

const optionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} malformed`);
  return value;
};

const optionalNullableInteger = (value: unknown, field: string): number | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${field} malformed`);
  return value;
};

const optionalStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new TypeError(`${field} malformed`);
  return [...new Set(value)];
};

const optionalServiceTiers = (value: unknown, field: string): CodexServiceTier[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${field} malformed`);
  return value.map(entry => {
    if (!isPlainRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.description !== 'string') {
      throw new TypeError(`${field} malformed`);
    }
    return { id: entry.id, name: entry.name, description: entry.description };
  });
};

const optionalTruncationPolicy = (value: unknown, field: string): { mode: string; limit: number } | undefined => {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || typeof value.mode !== 'string' || typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit)) {
    throw new TypeError(`${field} malformed`);
  }
  return { mode: value.mode, limit: value.limit };
};

// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/openai_models.rs#L390-L485
const assertRawModel = (value: unknown): CodexRawModel => {
  if (!isPlainRecord(value)) throw new TypeError('Codex model entry is not an object');
  const slug = value.slug;
  if (typeof slug !== 'string') throw new TypeError('Codex model entry missing slug');
  const field = (name: string): string => `Codex model entry ${slug} ${name}`;
  const display_name = value.display_name;
  if (typeof display_name !== 'string') throw new TypeError(`${field('display_name')} malformed`);

  const sourceContextWindow = optionalPositiveInteger(value.context_window, field('context_window'));
  const maxContextWindow = optionalPositiveInteger(value.max_context_window, field('max_context_window'));
  const contextWindow = sourceContextWindow ?? maxContextWindow;
  if (contextWindow === undefined) throw new TypeError(`${field('context_window')} and max_context_window missing`);

  let inputModalities: CodexInputModality[];
  if (value.input_modalities === undefined) {
    inputModalities = ['text', 'image'];
  } else {
    if (!Array.isArray(value.input_modalities)) throw new TypeError(`${field('input_modalities')} malformed`);
    inputModalities = [];
    for (const modality of value.input_modalities) {
      if (modality !== 'text' && modality !== 'image' && modality !== 'audio') {
        throw new TypeError(`${field('input_modalities')} unknown modality ${JSON.stringify(modality)}`);
      }
      if (!inputModalities.includes(modality)) inputModalities.push(modality);
    }
  }

  let reasoningLevels: CodexReasoningLevel[] | undefined;
  if (value.supported_reasoning_levels !== undefined) {
    if (!Array.isArray(value.supported_reasoning_levels)) throw new TypeError(`${field('supported_reasoning_levels')} malformed`);
    reasoningLevels = value.supported_reasoning_levels.map(entry => {
      if (!isPlainRecord(entry) || typeof entry.effort !== 'string' || entry.effort.length === 0 || typeof entry.description !== 'string') {
        throw new TypeError(`${field('reasoning level entry')} malformed`);
      }
      return { effort: entry.effort, description: entry.description };
    });
  }
  const defaultReasoningLevel = optionalString(value.default_reasoning_level, field('default_reasoning_level'));
  if (defaultReasoningLevel !== undefined && reasoningLevels !== undefined && !reasoningLevels.some(level => level.effort === defaultReasoningLevel)) {
    throw new TypeError(`${field('default_reasoning_level')} not in supported_reasoning_levels`);
  }

  const effectiveContextWindowPercent = value.effective_context_window_percent === undefined
    ? 95
    : optionalPositiveInteger(value.effective_context_window_percent, field('effective_context_window_percent'))!;
  const useResponsesLite = optionalBoolean(value.use_responses_lite, field('use_responses_lite')) ?? false;
  const modelMessages = value.model_messages;
  if (modelMessages !== undefined && modelMessages !== null && !isPlainRecord(modelMessages)) throw new TypeError(`${field('model_messages')} malformed`);

  const catalog: CodexCatalogCapabilities = {
    ...(sourceContextWindow !== undefined && { context_window: sourceContextWindow }),
    ...(maxContextWindow !== undefined && { max_context_window: maxContextWindow }),
    effective_context_window_percent: effectiveContextWindowPercent,
    input_modalities: inputModalities,
    ...(reasoningLevels !== undefined && { supported_reasoning_levels: reasoningLevels }),
    ...(defaultReasoningLevel !== undefined && { default_reasoning_level: defaultReasoningLevel }),
    use_responses_lite: useResponsesLite,
    ...defined('support_verbosity', optionalBoolean(value.support_verbosity, field('support_verbosity'))),
    ...defined('default_verbosity', optionalNullableString(value.default_verbosity, field('default_verbosity'))),
    ...defined('service_tiers', optionalServiceTiers(value.service_tiers, field('service_tiers'))),
    ...defined('default_service_tier', optionalNullableString(value.default_service_tier, field('default_service_tier'))),
    ...defined('additional_speed_tiers', optionalStringArray(value.additional_speed_tiers, field('additional_speed_tiers'))),
    ...defined('supports_search_tool', optionalBoolean(value.supports_search_tool, field('supports_search_tool'))),
    ...defined('web_search_tool_type', optionalString(value.web_search_tool_type, field('web_search_tool_type'))),
    ...defined('supports_reasoning_summary_parameter', optionalBoolean(value.supports_reasoning_summary_parameter, field('supports_reasoning_summary_parameter'))),
    ...defined('default_reasoning_summary', optionalString(value.default_reasoning_summary, field('default_reasoning_summary'))),
    ...defined('shell_type', optionalString(value.shell_type, field('shell_type'))),
    ...defined('apply_patch_tool_type', optionalNullableString(value.apply_patch_tool_type, field('apply_patch_tool_type'))),
    ...defined('truncation_policy', optionalTruncationPolicy(value.truncation_policy, field('truncation_policy'))),
    ...defined('supports_image_detail_original', optionalBoolean(value.supports_image_detail_original, field('supports_image_detail_original'))),
    ...defined('experimental_supported_tools', optionalStringArray(value.experimental_supported_tools, field('experimental_supported_tools'))),
    ...defined('auto_compact_token_limit', optionalNullableInteger(value.auto_compact_token_limit, field('auto_compact_token_limit'))),
    ...defined('comp_hash', optionalNullableString(value.comp_hash, field('comp_hash'))),
    ...defined('model_messages', modelMessages as Record<string, unknown> | null | undefined),
    ...defined('include_skills_usage_instructions', optionalBoolean(value.include_skills_usage_instructions, field('include_skills_usage_instructions'))),
    ...defined('include_plugin_usage_instructions', optionalBoolean(value.include_plugin_usage_instructions, field('include_plugin_usage_instructions'))),
    ...defined('include_apps_usage_instructions', optionalBoolean(value.include_apps_usage_instructions, field('include_apps_usage_instructions'))),
    ...defined('node_repl_auto_review_required', optionalBoolean(value.node_repl_auto_review_required, field('node_repl_auto_review_required'))),
    ...defined('node_repl_disabled', optionalBoolean(value.node_repl_disabled, field('node_repl_disabled'))),
    ...defined('auto_review_model_override', optionalNullableString(value.auto_review_model_override, field('auto_review_model_override'))),
    ...defined('model_specialty', optionalNullableString(value.model_specialty, field('model_specialty'))),
    ...defined('tool_mode', optionalNullableString(value.tool_mode, field('tool_mode'))),
    ...defined('multi_agent_version', optionalNullableString(value.multi_agent_version, field('multi_agent_version'))),
    ...defined('multi_agent_reasoning_effort', optionalNullableString(value.multi_agent_reasoning_effort, field('multi_agent_reasoning_effort'))),
  };

  return {
    id: slug,
    display_name,
    context_window: contextWindow,
    input_modalities: inputModalities,
    ...(reasoningLevels !== undefined && { reasoning_efforts: reasoningLevels.map(level => level.effort) }),
    ...(defaultReasoningLevel !== undefined && { default_reasoning_effort: defaultReasoningLevel }),
    ...(useResponsesLite && { use_responses_lite: true }),
    catalog,
  };
};

const defined = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : { [key]: value } as { [P in K]: V };

// Every entry returned by the remote Codex catalog is a Responses chat model.
// Pricing is looked up from the per-slug table in pricing.ts so the dashboard
// can report a notional API-rate price even though Codex itself bills as a
// flat-fee subscription. Provider-owned models such as gpt-image-2 are added
// separately and never pass through this mapper.
//
// `enabledFlags` is the upstream-resolved flag set (provider defaults
// merged with the row's `flagOverrides`); it propagates per-model so
// downstream interceptors can read the effective set without re-resolving.
export const codexRawToProviderModel = (raw: CodexRawModel, enabledFlags: ReadonlySet<FlagId>): ProviderModel => {
  const pricing = pricingForCodexModelKey(raw.id);
  const chat: UpstreamChatModelConfig = {};
  if (raw.input_modalities && raw.input_modalities.length > 0) {
    chat.modalities = { input: raw.input_modalities, output: ['text'] };
  }
  if (raw.reasoning_efforts && raw.reasoning_efforts.length > 0) {
    if (raw.default_reasoning_effort !== undefined && !raw.reasoning_efforts.includes(raw.default_reasoning_effort)) {
      throw new Error(`Codex model ${raw.id}: default_reasoning_level not in supported_reasoning_levels`);
    }
    chat.reasoning = {
      effort: {
        supported: raw.reasoning_efforts,
        ...(raw.default_reasoning_effort !== undefined && { default: raw.default_reasoning_effort }),
      },
    };
  }
  const providerData: CodexProviderModelData = {
    ...(raw.use_responses_lite === true && { useResponsesLite: true }),
    ...(raw.catalog !== undefined && { catalog: raw.catalog }),
  };
  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'openai',
    kind: 'chat',
    limits: {
      max_context_window_tokens: raw.context_window,
      ...(raw.catalog !== undefined && {
        max_prompt_tokens: Math.floor(raw.context_window * raw.catalog.effective_context_window_percent / 100),
      }),
    },
    endpoints: { responses: {} },
    enabledFlags,
    ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    ...(pricing ? { pricing } : {}),
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
  };
};

// CLIProxyAPI exposes Codex's built-in image models for every plan, then
// rejects image dispatch only when the JWT plan is explicitly `free`; missing
// and future plan values fail open. Mirror that account-eligibility rule here
// while keeping the image model outside the remote chat-model catalog.
// https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/runtime/executor/codex_executor_request.go#L381-L449
// https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/sdk/cliproxy/auth/conductor_execution.go#L1036-L1066
export const codexPlanSupportsImages = (planType: string | undefined): boolean =>
  planType?.trim().toLowerCase() !== 'free';

export const codexImageProviderModel = (enabledFlags: ReadonlySet<FlagId>): ProviderModel => ({
  id: CODEX_IMAGE_MODEL_ID,
  display_name: 'GPT-Image-2',
  owned_by: 'openai',
  kind: 'image',
  limits: {},
  endpoints: { imagesGenerations: {}, imagesEdits: {} },
  enabledFlags,
  pricing: GPT_IMAGE_2_PRICING,
});
