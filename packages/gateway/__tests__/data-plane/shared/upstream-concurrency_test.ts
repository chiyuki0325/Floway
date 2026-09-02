import { describe, expect, it } from 'vitest';

import { acquireUpstreamConcurrency, upstreamConcurrencySnapshots } from '../../../src/data-plane/shared/upstream-concurrency.ts';

describe('upstream concurrency', () => {
  it('queues requests and reports active and queued counts', async () => {
    const upstreamId = `test-${Math.random()}`;
    const first = await acquireUpstreamConcurrency({ upstreamId, maxConcurrentRequests: 1 });
    const secondPromise = acquireUpstreamConcurrency({ upstreamId, maxConcurrentRequests: 1 });

    expect(upstreamConcurrencySnapshots()).toContainEqual({
      upstreamId,
      maxConcurrentRequests: 1,
      activeRequests: 1,
      queuedRequests: 1,
    });

    let settled = false;
    void secondPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(second.queued).toBe(true);
    second.release();
  });

  it('removes aborted waiters', async () => {
    const upstreamId = `test-${Math.random()}`;
    const first = await acquireUpstreamConcurrency({ upstreamId, maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const waiting = acquireUpstreamConcurrency({ upstreamId, maxConcurrentRequests: 1, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamConcurrencySnapshots()).toContainEqual({
      upstreamId,
      maxConcurrentRequests: 1,
      activeRequests: 1,
      queuedRequests: 0,
    });
    first.release();
  });
});
