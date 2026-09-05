import type { FlagDefaults } from '@floway-dev/provider';

export const CODEX_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'messages-web-search-shim': false,
  'responses-web-search-shim': false,
  'responses-image-generation-shim': false,
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'strip-traex-image-generation-tool': true,
  'usage-exclusive-cached-tokens': false,
};
