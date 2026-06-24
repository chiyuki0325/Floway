import { resolve } from 'node:path';

import { serve, upgradeWebSocket } from '@hono/node-server';
import { Agent, Pool, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

// Copilot data-plane hosts close their keep-alive socket right after each
// response; reusing it surfaces as UND_ERR_SOCKET or
// RequestContentLengthMismatchError. `pipelining: 0` disables keep-alive.
//
// The host list is decided by GitHub (returned in /copilot_internal/v2/token
// `endpoints.api`, never enumerated locally), so we match the
// `*.githubcopilot.com` family rather than enumerate today's three
// (individual, business, enterprise) and silently miss any new tier GitHub
// adds.
//
// Refs: https://github.com/nodejs/undici/blob/v6.21.0/docs/docs/api/Client.md#parameter-clientoptions
//       https://github.com/Menci/Floway/pull/78#issuecomment-4765475966
const isCopilotDataPlaneHost = (hostname: string): boolean =>
  hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com');
setGlobalDispatcher(new Agent({
  factory: (origin, opts) => {
    const hostname = typeof origin === 'string' ? new URL(origin).hostname : origin.hostname;
    return new Pool(origin, isCopilotDataPlaneHost(hostname) ? { ...opts, pipelining: 0 } : opts);
  },
}));

import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { applyMigrations } from './src/migrate.ts';
import { createSpaApp, isApiPath, spaBuildExists } from './src/serve-spa.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  initResponsesWebSocketUpgradeResolver,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';
import { getEnvOptional } from '@floway-dev/platform';

// In Node we don't have Workers' executionCtx.waitUntil — there's no request
// lifecycle to attach background work to — so the resolver fire-and-forgets
// the promise. Logging the rejection here is the only signal we get; without
// it a swallowed background failure would be silent.
initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});

initResponsesWebSocketUpgradeResolver((c, events) =>
  upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));

const { db } = bootstrapNodePlatform();
const port = Number(getEnvOptional('PORT', '8788'));

const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

await applyMigrations(db);
initRepo(new SqlRepo(db));

// Serve the SPA dashboard for non-API paths when the build output exists.
// The API/SPA path boundary is defined in ./src/serve-spa.ts and MUST stay
// in sync with the same list in apps/web/vite.config.ts, wrangler.jsonc,
// and docker/nginx.conf.
// FLOWAY_SPA_DIR is resolved relative to CWD; the default resolves from the
// entry file's location (apps/platform-node) to the repo-root SPA build output.
const spaDir = getEnvOptional(
  'FLOWAY_SPA_DIR',
  resolve(import.meta.dirname, '../../apps/web/dist'),
);
const spaApp = spaBuildExists(spaDir) ? createSpaApp(spaDir) : null;

if (spaApp) {
  console.log(`Serving SPA from ${spaDir}`);
}

// Run the scheduled maintenance job once after a short startup delay and
// then every hour. Without the startup run, a process that restarts more
// often than the interval (crash loop, frequent deploys) would never run
// maintenance and the responses-items expiry sweep would silently lag. The
// 30s delay keeps the very first request after boot from racing the sweep.
// unref() on both timers lets the process exit cleanly on SIGINT.
const STARTUP_DELAY_MS = 30 * 1000;
const sweep = (): void => {
  runScheduledMaintenance().catch(err => {
    console.error('[scheduled-maintenance] sweep failed:', err);
  });
};
setTimeout(sweep, STARTUP_DELAY_MS).unref();
setInterval(sweep, SCHEDULED_INTERVAL_MS).unref();

const wsServer = new WebSocketServer({ noServer: true });

serve({
  fetch: (req: Request, ...args: unknown[]) => {
    // When the SPA dist is available, divert non-API paths to the SPA
    // app. API paths (and all requests when the SPA is absent) go to
    // the gateway app. Extra args (env / execution context) are passed
    // through so @hono/node-server's WebSocket upgrade mechanism works.
    if (spaApp && !isApiPath(new URL(req.url).pathname)) {
      return spaApp.fetch(req, ...args);
    }
    return app.fetch(req, ...args);
  },
  port,
  websocket: { server: wsServer },
}, info => {
  console.log(`Floway listening on http://localhost:${info.port}`);
});
