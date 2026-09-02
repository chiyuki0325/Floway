import type { UpstreamConcurrencyObservation, UpstreamConcurrencyRepo } from './types.ts';

export class MemoryUpstreamConcurrencyRepo implements UpstreamConcurrencyRepo {
  private readonly rows = new Map<string, UpstreamConcurrencyObservation>();

  async record(observation: { upstreamId: string; limit: number; active: number; queued: number; waitMs: number; at: number }): Promise<void> {
    const hour = new Date(observation.at).toISOString().slice(0, 13);
    const key = `${hour}\0${observation.upstreamId}`;
    const current = this.rows.get(key);
    this.rows.set(key, current === undefined ? {
      hour,
      upstreamId: observation.upstreamId,
      limit: observation.limit,
      samples: 1,
      activeSum: observation.active,
      activeMax: observation.active,
      queuedSum: observation.queued,
      queuedMax: observation.queued,
      waitMsSum: observation.waitMs,
    } : {
      ...current,
      limit: observation.limit,
      samples: current.samples + 1,
      activeSum: current.activeSum + observation.active,
      activeMax: Math.max(current.activeMax, observation.active),
      queuedSum: current.queuedSum + observation.queued,
      queuedMax: Math.max(current.queuedMax, observation.queued),
      waitMsSum: current.waitMsSum + observation.waitMs,
    });
  }

  async query(opts: { start: string; end: string; upstreamIds?: readonly string[] }): Promise<UpstreamConcurrencyObservation[]> {
    return [...this.rows.values()].filter(row => row.hour >= opts.start.slice(0, 13) && row.hour < opts.end.slice(0, 13)
      && (opts.upstreamIds === undefined || opts.upstreamIds.length === 0 || opts.upstreamIds.includes(row.upstreamId)));
  }

  async deleteBefore(at: number): Promise<void> {
    const cutoff = new Date(at).toISOString().slice(0, 13);
    for (const [key, row] of this.rows) if (row.hour < cutoff) this.rows.delete(key);
  }
}
