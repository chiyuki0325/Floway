import type { UpstreamConcurrencyObservation, UpstreamConcurrencyRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export class SqlUpstreamConcurrencyRepo implements UpstreamConcurrencyRepo {
  constructor(private readonly db: SqlDatabase) {}

  async record(observation: { upstreamId: string; limit: number; active: number; queued: number; waitMs: number; at: number }): Promise<void> {
    const hour = new Date(observation.at).toISOString().slice(0, 13);
    await this.db.prepare(`
      INSERT INTO upstream_concurrency_observations
        (hour, upstream_id, limit_value, samples, active_sum, active_max, queued_sum, queued_max, wait_ms_sum)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT (hour, upstream_id) DO UPDATE SET
        limit_value = excluded.limit_value,
        samples = samples + 1,
        active_sum = active_sum + excluded.active_sum,
        active_max = MAX(active_max, excluded.active_max),
        queued_sum = queued_sum + excluded.queued_sum,
        queued_max = MAX(queued_max, excluded.queued_max),
        wait_ms_sum = wait_ms_sum + excluded.wait_ms_sum
    `).bind(hour, observation.upstreamId, observation.limit, observation.active, observation.active, observation.queued, observation.queued, observation.waitMs).run();
  }

  async query(opts: { start: string; end: string; upstreamIds?: readonly string[] }): Promise<UpstreamConcurrencyObservation[]> {
    const conditions = ['hour >= ?', 'hour < ?'];
    const binds: unknown[] = [opts.start.slice(0, 13), opts.end.slice(0, 13)];
    if (opts.upstreamIds && opts.upstreamIds.length > 0) {
      conditions.push(`upstream_id IN (${opts.upstreamIds.map(() => '?').join(', ')})`);
      binds.push(...opts.upstreamIds);
    }
    const { results } = await this.db.prepare(`
      SELECT hour, upstream_id, limit_value, samples, active_sum, active_max, queued_sum, queued_max, wait_ms_sum
      FROM upstream_concurrency_observations
      WHERE ${conditions.join(' AND ')}
      ORDER BY hour, upstream_id
    `).bind(...binds as never[]).all<{
      hour: string;
      upstream_id: string;
      limit_value: number;
      samples: number;
      active_sum: number;
      active_max: number;
      queued_sum: number;
      queued_max: number;
      wait_ms_sum: number;
    }>();
    return results.map(row => ({
      hour: row.hour,
      upstreamId: row.upstream_id,
      limit: row.limit_value,
      samples: row.samples,
      activeSum: row.active_sum,
      activeMax: row.active_max,
      queuedSum: row.queued_sum,
      queuedMax: row.queued_max,
      waitMsSum: row.wait_ms_sum,
    }));
  }

  async deleteBefore(at: number): Promise<void> {
    await this.db.prepare('DELETE FROM upstream_concurrency_observations WHERE hour < ?').bind(new Date(at).toISOString().slice(0, 13)).run();
  }
}
