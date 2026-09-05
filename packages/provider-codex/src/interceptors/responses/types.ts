import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderModel, ResponsesAction } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/codex-api/src/common.rs#L181-L190
export interface CodexResponsesStreamOptions {
  reasoning_summary_delivery?: 'sequential_cutoff' | (string & {});
}

export type CodexResponsesPayload = CanonicalResponsesPayload & {
  stream_options?: CodexResponsesStreamOptions | null;
};

// Boundary ctx for Codex Responses interceptors. The same ctx feeds both the
// streaming `/responses` (action='generate') and the non-streaming compaction
// (action='compact') chains; the terminal switches on `action` to pick the
// wire shape (see provider.ts callResponses).
export interface ResponsesBoundaryCtx {
  payload: CodexResponsesPayload;
  headers: Headers;
  readonly model: ProviderModel;
  // Mirrors the gateway-side ResponsesInvocation.action. Interceptors MAY
  // mutate it during the chain to re-route dispatch in the terminal
  // handler — the terminal reads `ctx.action`, not the parameter the
  // provider was originally called with.
  action: ResponsesAction;
}
