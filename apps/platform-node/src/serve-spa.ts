import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

/**
 * API path prefixes: any request whose URL pathname starts with one of these
 * strings is routed to the gateway Hono app. Everything else is served as
 * SPA static content (or falls through to the SPA's index.html).
 *
 * This list MUST stay in sync with the same concept in three other places --
 * drift is silent and only surfaces as a 404 the SPA fallback served for a
 * real gateway endpoint:
 *
 *   - `wranglerProxiedPaths` in apps/web/vite.config.ts
 *   - `assets.run_worker_first` in wrangler.jsonc (production Workers topology)
 *   - `location ~` regexes in docker/nginx.conf (docker-compose self-host)
 *
 * All four describe the same boundary: the paths the gateway owns; the rest
 * is the SPA. Bare LLM paths (without `/v1` prefix) are listed because the
 * gateway accepts both forms.
 */
const API_PATH_PREFIXES = [
  '/api/',
  '/auth/',
  '/v1/',
  '/v1beta/',
  '/azure-api.codex/',
  '/chat/',
  '/responses/',
  '/messages/',
  '/images/',
] as const;

/**
 * Exact API paths that do not belong under a prefix-based rule but must
 * still be routed to the gateway.
 */
const API_EXACT_PATHS = new Set<string>([
  '/auth',
  '/favicon.ico',
  '/responses',
  '/messages',
  '/embeddings',
  '/models',
]);

/**
 * Returns true when `path` (a URL pathname) belongs to the gateway API
 * and must be forwarded to the Hono app rather than served as SPA content.
 */
export function isApiPath(path: string): boolean {
  return API_EXACT_PATHS.has(path)
    || API_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Creates a minimal Hono app that serves static files from `spaDir` (the
 * Vite build output directory) with SPA fallback: any GET/HEAD request for
 * a non-existent file receives `index.html`.
 *
 * This app has NO auth middleware, NO CORS, NO logging -- it is a pure
 * static file server. It runs BEFORE the gateway app's middleware chain,
 * so SPA routes never hit the auth check.
 */
export function createSpaApp(spaDir: string): Hono {
  const spa = new Hono();

  // 1. Serve existing static assets (JS, CSS, images, etc.).
  //    serveStatic checks the request path against the filesystem under
  //    `root`. If the file exists, it streams it back with the correct
  //    MIME type, Last-Modified, and Content-Length. If not, it calls
  //    `next()` and the fallback handler below runs.
  spa.use('*', serveStatic({ root: spaDir }));

  // 2. SPA fallback: unmatched GET/HEAD requests serve index.html.
  //    The explicit `path` option overrides the request path so the
  //    middleware always serves the SPA entry point regardless of what
  //    route the client requested.
  spa.get('*', serveStatic({ root: spaDir, path: '/index.html' }));

  return spa;
}

/**
 * Returns true when the SPA build output exists at `spaDir`.
 * Absence means the Node target should skip static serving and behave as
 * a pure API gateway (the current behaviour).
 */
export function spaBuildExists(spaDir: string): boolean {
  return existsSync(join(spaDir, 'index.html'));
}
