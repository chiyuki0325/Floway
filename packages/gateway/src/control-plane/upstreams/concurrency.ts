import { upstreamConcurrencySnapshots } from '../../data-plane/shared/upstream-concurrency.ts';
import { getRepo } from '../../repo/index.ts';

export const upstreamConcurrencyStatus = async () => {
  const configured = await getRepo().upstreams.list();
  const snapshots = new Map(upstreamConcurrencySnapshots().map(snapshot => [snapshot.upstreamId, snapshot]));
  return configured.map(upstream => {
    const snapshot = snapshots.get(upstream.id);
    return {
      upstream_id: upstream.id,
      max_concurrent_requests: upstream.maxConcurrentRequests ?? null,
      active_requests: snapshot?.activeRequests ?? 0,
      queued_requests: snapshot?.queuedRequests ?? 0,
    };
  });
};
