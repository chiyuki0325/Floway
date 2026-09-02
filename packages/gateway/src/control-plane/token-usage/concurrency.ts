import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamConcurrencyQuery } from '../schemas.ts';
import { readTelemetryOverviewWindow } from '../shared/telemetry-overview.ts';

type Ctx = CtxWithQuery<typeof upstreamConcurrencyQuery>;

export interface ConcurrencyOverviewResponse {
  records: Array<{
    hour: string;
    upstream_id: string;
    limit: number;
    samples: number;
    active_average: number;
    active_max: number;
    queued_average: number;
    queued_max: number;
    wait_ms_average: number;
  }>;
}

export const upstreamConcurrencyOverview = async (c: Ctx) => {
  if (!userFromContext(c).isAdmin) return c.json({ error: 'Admin privileges required' }, 403);
  const window = readTelemetryOverviewWindow(c.req.valid('query'));
  if (window.type === 'error') return c.json({ error: window.error }, 400);
  const query = c.req.valid('query');
  const rows = await getRepo().upstreamConcurrency.query({
    start: window.value.start,
    end: window.value.end,
    upstreamIds: query.filter_upstream,
  });
  return c.json({
    records: rows.map(row => ({
      hour: row.hour,
      upstream_id: row.upstreamId,
      limit: row.limit,
      samples: row.samples,
      active_average: row.samples === 0 ? 0 : row.activeSum / row.samples,
      active_max: row.activeMax,
      queued_average: row.samples === 0 ? 0 : row.queuedSum / row.samples,
      queued_max: row.queuedMax,
      wait_ms_average: row.samples === 0 ? 0 : row.waitMsSum / row.samples,
    })),
  });
};
