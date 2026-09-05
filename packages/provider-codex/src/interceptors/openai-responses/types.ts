import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel, OpenAIResponsesAction } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-api/src/common.rs#L181-L190
export interface CodexOpenAIResponsesStreamOptions {
  reasoning_summary_delivery?: 'sequential_cutoff' | (string & {});
}

export type CodexOpenAIResponsesPayload = CanonicalOpenAIResponsesPayload & {
  stream_options?: CodexOpenAIResponsesStreamOptions | null;
};

// Boundary ctx for Codex OpenAI Responses interceptors. The same ctx feeds both the
// streaming `/responses` (action='generate') and the non-streaming compaction
// (action='compact') chains; the terminal switches on `action` to pick the
// wire shape (see provider.ts callOpenAIResponses).
export interface OpenAIResponsesBoundaryCtx {
  payload: CodexOpenAIResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  // Mirrors the gateway-side OpenAIResponsesInvocation.action. Interceptors MAY
  // mutate it during the chain to re-route dispatch in the terminal
  // handler — the terminal reads `ctx.action`, not the parameter the
  // provider was originally called with.
  action: OpenAIResponsesAction;
}
