export interface UpstreamConcurrencySnapshot {
  upstreamId: string;
  maxConcurrentRequests: number | null;
  activeRequests: number;
  queuedRequests: number;
}

export interface UpstreamConcurrencyLease {
  readonly queued: boolean;
  release(): void;
}

type Waiter = {
  resolve: (lease: UpstreamConcurrencyLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  settled: boolean;
  onAbort?: () => void;
};

type State = {
  maxConcurrentRequests: number | null;
  activeRequests: number;
  waiters: Waiter[];
};

const states = new Map<string, State>();

const getState = (upstreamId: string, maxConcurrentRequests: number | null): State => {
  let state = states.get(upstreamId);
  if (!state) {
    state = { maxConcurrentRequests, activeRequests: 0, waiters: [] };
    states.set(upstreamId, state);
  } else {
    state.maxConcurrentRequests = maxConcurrentRequests;
  }
  return state;
};

const removeWaiter = (state: State, waiter: Waiter): void => {
  const index = state.waiters.indexOf(waiter);
  if (index >= 0) state.waiters.splice(index, 1);
};

const makeLease = (state: State, queued: boolean): UpstreamConcurrencyLease => {
  state.activeRequests++;
  let released = false;
  return {
    queued,
    release: () => {
      if (released) return;
      released = true;
      state.activeRequests--;
      pump(state);
    },
  };
};

const pump = (state: State): void => {
  while (
    state.waiters.length > 0
    && (state.maxConcurrentRequests === null || state.activeRequests < state.maxConcurrentRequests)
  ) {
    const waiter = state.waiters.shift()!;
    if (waiter.settled) continue;
    waiter.settled = true;
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort!);
    waiter.resolve(makeLease(state, true));
  }
};

export const acquireUpstreamConcurrency = ({
  upstreamId,
  maxConcurrentRequests,
  signal,
  onObservation,
}: {
  upstreamId: string;
  maxConcurrentRequests: number | null;
  signal?: AbortSignal;
  onObservation?: (active: number, queued: number) => void;
}): Promise<UpstreamConcurrencyLease> => {
  const state = getState(upstreamId, maxConcurrentRequests);
  onObservation?.(state.activeRequests, state.waiters.length);
  if (maxConcurrentRequests === null || state.activeRequests < maxConcurrentRequests) {
    return Promise.resolve(makeLease(state, false));
  }

  return new Promise<UpstreamConcurrencyLease>((resolve, reject) => {
    const waiter: Waiter & { onAbort?: () => void } = {
      resolve,
      reject,
      signal,
      settled: false,
    };
    waiter.onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      removeWaiter(state, waiter);
      reject(signal?.reason ?? new DOMException('The request was aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      waiter.onAbort();
      return;
    }
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    state.waiters.push(waiter);
  });
};

export const upstreamConcurrencySnapshots = (): UpstreamConcurrencySnapshot[] => [...states.entries()]
  .map(([upstreamId, state]) => ({
    upstreamId,
    maxConcurrentRequests: state.maxConcurrentRequests,
    activeRequests: state.activeRequests,
    queuedRequests: state.waiters.filter(waiter => !waiter.settled).length,
  }))
  .filter(snapshot => snapshot.maxConcurrentRequests !== null || snapshot.activeRequests > 0 || snapshot.queuedRequests > 0);
