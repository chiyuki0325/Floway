import type { ResponsesBoundaryCtx } from './types.ts';

// The current Codex request builder does not send these fields. That does not
// prove the backend rejects them, so keep the compatibility filter scoped to
// fields whose support has not been established on the subscription path.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L1014-L1031
const CODEX_UNSUPPORTED_BODY_FIELDS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
] as const;

export const stripUnsupportedFields = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const next: Record<string, unknown> = { ...(ctx.payload as unknown as Record<string, unknown>) };
  for (const key of CODEX_UNSUPPORTED_BODY_FIELDS) delete next[key];

  const streamOptions = next.stream_options;
  if (typeof streamOptions === 'object' && streamOptions !== null && !Array.isArray(streamOptions)) {
    const reasoningSummaryDelivery = (streamOptions as Record<string, unknown>).reasoning_summary_delivery;
    if (typeof reasoningSummaryDelivery === 'string') {
      next.stream_options = { reasoning_summary_delivery: reasoningSummaryDelivery };
    } else {
      delete next.stream_options;
    }
  } else {
    delete next.stream_options;
  }

  ctx.payload = next as unknown as typeof ctx.payload;
  return await run();
};
