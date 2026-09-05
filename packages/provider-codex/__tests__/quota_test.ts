import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import {
  getCodexQuota,
  hasCodexQuotaReading,
  parseCodexQuotaHeaders,
  putCodexQuota,
  type CodexQuotaSnapshot,
} from '../src/quota.ts';
import type { CodexQuotaSnapshotEntryMap, CodexUpstreamState } from '../src/state.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';

const accountId = 'acc_1';
const upstreamId = 'up_a';

const parseDefaultQuota = (headers: Headers, options: Parameters<typeof parseCodexQuotaHeaders>[1]): CodexQuotaSnapshot => {
  const snapshot = parseCodexQuotaHeaders(headers, options).codex;
  if (!snapshot) throw new Error('expected default Codex quota family');
  return snapshot;
};

const putSnapshot = (targetAccountId: string | undefined, snapshot: CodexQuotaSnapshot): Promise<void> => {
  const limitId = snapshot.active_limit?.trim();
  return putCodexQuota(upstreamId, targetAccountId, { [limitId === undefined || limitId === '' ? 'unknown' : limitId]: snapshot });
};

test('hasCodexQuotaReading ignores an observation timestamp without quota data', () => {
  expect(hasCodexQuotaReading({ observed_at: '2026-01-01T00:00:00Z' })).toBe(false);
  expect(hasCodexQuotaReading({ observed_at: '2026-01-01T00:00:00Z', plan_type: 'plus' })).toBe(true);
});

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null,
  quotaSnapshot: null as CodexQuotaSnapshotEntryMap | null,
};

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as CodexUpstreamState };
  });
  initProviderRepo(() => ({ upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

describe('parseCodexQuotaHeaders', () => {
  test('parses a 200 snapshot (no ratelimited_until)', () => {
    const headers = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-used-percent': '94',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '486400',
      'x-codex-credits-has-credits': 'False',
      'x-codex-credits-balance': '0',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseDefaultQuota(headers, { now: observedAt, isRateLimited: false });
    expect(snapshot).toMatchObject({
      observed_at: '2026-06-05T00:00:00.000Z',
      active_limit: 'codex',
      plan_type: 'plus',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-06-05T05:00:00.000Z',
      secondary_used_percent: 94,
      secondary_window_minutes: 10080,
      credits_has_credits: false,
      credits_balance: '0',
    });
    expect(snapshot.ratelimited_until).toBeUndefined();
  });

  // Upstream added `-reset-at` on 2025-10-17 and kept sending the offset it
  // replaced, so the absolute instant wins and the offset is the fallback.
  test('prefers the absolute reset instant over the offset it replaced', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '1',
      'x-codex-primary-reset-at': '1780272000',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-used-percent': '1',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const snapshot = parseDefaultQuota(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.primary_reset_after_at).toBe(new Date(1780272000 * 1000).toISOString());
    // No absolute instant for the secondary, so the offset still dates it.
    expect(snapshot.secondary_reset_after_at).toBe('2026-06-05T02:00:00.000Z');
  });

  // Builds from the three days after the header landed sent RFC 3339 instead of
  // epoch seconds, which is why every client that reads it accepts both.
  test('reads an absolute reset instant sent as RFC 3339', () => {
    const headers = new Headers({ 'x-codex-primary-used-percent': '1', 'x-codex-primary-reset-at': '2026-06-05T05:00:00.000Z' });
    const snapshot = parseDefaultQuota(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.primary_reset_after_at).toBe('2026-06-05T05:00:00.000Z');
  });

  // A plan whose secondary window is zero minutes wide reports a blank instant
  // beside a zero offset. That is "no such window", not "it resets now".
  test('reports no reset for a window this plan does not have', () => {
    const headers = new Headers({
      'x-codex-secondary-window-minutes': '0',
      'x-codex-secondary-reset-at': '',
      'x-codex-secondary-reset-after-seconds': '0',
    });
    const snapshot = parseDefaultQuota(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.secondary_reset_after_at).toBeUndefined();
  });

  // `Number('')` is 0, so a blank reading would otherwise land as a confident
  // zero balance rather than as nothing observed.
  test('reads a blank numeric header as absent rather than as zero', () => {
    const headers = new Headers({ 'x-codex-credits-balance': '', 'x-codex-secondary-used-percent': '  ' });
    const snapshot = parseDefaultQuota(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });
    expect(snapshot.credits_balance).toBeUndefined();
    expect(snapshot.secondary_used_percent).toBeUndefined();
  });

  test('uses the 429 error body for the recovery instant and plan', () => {
    const headers = new Headers({
      'x-codex-plan-type': 'plus',
      'x-codex-primary-reset-at': '1780272000',
      'x-codex-secondary-reset-at': '1780358400',
    });
    const snapshot = parseDefaultQuota(headers, {
      now: new Date('2026-06-05T00:00:00.000Z'),
      isRateLimited: true,
      errorBody: JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'pro', resets_at: 1780444800 } }),
    });
    expect(snapshot.ratelimited_until).toBe(new Date(1780444800 * 1000).toISOString());
    expect(snapshot.plan_type).toBe('pro');
  });

  test('does not infer the top-level recovery instant from window headers', () => {
    const headers = new Headers({
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const snapshot = parseDefaultQuota(headers, { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: true });
    expect(snapshot.ratelimited_until).toBeUndefined();
  });

  test('discovers every named limit family and preserves credit precision', () => {
    const snapshots = parseCodexQuotaHeaders(new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-limit-name': 'Core',
      'x-codex-other-primary-used-percent': '80',
      'x-codex-other-primary-window-minutes': '1440',
      'x-codex-other-limit-name': 'Other',
      'x-codex-credits-has-credits': '1',
      'x-codex-credits-unlimited': '0',
      'x-codex-credits-balance': '9007199254740993.000000001',
    }), { now: new Date('2026-06-05T00:00:00.000Z'), isRateLimited: false });

    expect(Object.keys(snapshots)).toEqual(['codex', 'codex_other']);
    expect(snapshots.codex).toMatchObject({ active_limit: 'codex', limit_name: 'Core', primary_used_percent: 12.5 });
    expect(snapshots.codex_other).toMatchObject({
      active_limit: 'codex_other',
      limit_name: 'Other',
      primary_used_percent: 80,
      primary_window_minutes: 1440,
      credits_has_credits: true,
      credits_unlimited: false,
      credits_balance: '9007199254740993.000000001',
    });
  });

  test('selects only the active family for a 429 and retains its error metadata', () => {
    const snapshots = parseCodexQuotaHeaders(new Headers({
      'x-codex-active-limit': 'codex_other',
      'x-codex-primary-used-percent': '20',
      'x-codex-other-primary-used-percent': '100',
      'x-codex-promo-message': 'Upgrade for more usage',
      'x-codex-rate-limit-reached-type': 'workspace_member_usage_limit_reached',
    }), {
      now: new Date('2026-06-05T00:00:00.000Z'),
      isRateLimited: true,
      errorBody: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1780444800 } }),
    });

    expect(snapshots).toEqual({
      codex_other: {
        observed_at: '2026-06-05T00:00:00.000Z',
        active_limit: 'codex_other',
        primary_used_percent: 100,
        promo_message: 'Upgrade for more usage',
        rate_limit_reached_type: 'workspace_member_usage_limit_reached',
        ratelimited_until: new Date(1780444800 * 1000).toISOString(),
      },
    });
  });

  test('normalizes string headers at the provider boundary', () => {
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseDefaultQuota(new Headers({
      'x-codex-active-limit': '  premium  ',
      'x-codex-plan-type': '   ',
    }), { now: observedAt, isRateLimited: false });
    expect(snapshot).toEqual({ observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'codex' });
  });
});

describe('getCodexQuota', () => {
  test('returns null when the upstream row is missing', async () => {
    current = null;
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the account has no snapshot', async () => {
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns the quota map when buckets are fresh', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: Date.now(), data: snap } } }] });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ premium: snap });
  });

  // An old reading rendered with the instant it was taken tells an operator
  // more than an empty card, so age withholds nothing -- the dashboard is the
  // only reader, and traffic on the upstream replaces what it shows.
  test('returns every bucket however long ago it was observed', async () => {
    const recent: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'recent' };
    const ancient: CodexQuotaSnapshot = { observed_at: '2026-06-01T00:00:00.000Z', active_limit: 'ancient' };
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        quotaSnapshot: {
          recent: { fetchedAt: Date.now(), data: recent },
          ancient: { fetchedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, data: ancient },
        },
      }],
    });
    expect(await getCodexQuota(upstreamId, accountId)).toEqual({ recent, ancient });
  });

  test('returns null when the account has an empty snapshot map', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: {} }] });
    expect(await getCodexQuota(upstreamId, accountId)).toBeNull();
  });

  test('returns null when the requested account is not in the pool', async () => {
    expect(await getCodexQuota(upstreamId, 'acc_other')).toBeNull();
  });
});

describe('putCodexQuota', () => {
  test('persists the snapshot under its active limit, leaving the rest of the credential alone', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 42 };
    await putSnapshot(accountId, snap);
    expect(repo.saveState).toHaveBeenCalledTimes(1);
    expect(repo.saveState.mock.calls[0][0]).toBe(upstreamId);
    const written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.premium?.data).toEqual(snap);
    expect(typeof written?.premium?.fetchedAt).toBe('number');
    expect({ ...(current!.state as CodexUpstreamState).accounts[0], quotaSnapshot: null }).toEqual({ ...baseAccount });
  });

  test('persists all parsed limit families in one state update', async () => {
    const codex: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'codex', primary_used_percent: 10 };
    const other: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'codex_other', primary_used_percent: 20 };
    await putCodexQuota(upstreamId, accountId, { codex, codex_other: other });

    const written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.codex.data).toEqual(codex);
    expect(written?.codex_other.data).toEqual(other);
    expect(written?.codex.fetchedAt).toBe(written?.codex_other.fetchedAt);
  });

  test('preserves other limit families and replaces the matching family', async () => {
    const premium: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 10 };
    current = makeRecord({ accounts: [{ ...baseAccount, quotaSnapshot: { premium: { fetchedAt: 1, data: premium } } }] });
    const bengalfox: CodexQuotaSnapshot = { observed_at: '2026-06-05T01:00:00.000Z', active_limit: 'codex_bengalfox', primary_used_percent: 20 };
    await putSnapshot(accountId, bengalfox);
    let written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.premium.data).toEqual(premium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);

    const nextPremium: CodexQuotaSnapshot = { observed_at: '2026-06-05T02:00:00.000Z', active_limit: 'premium', primary_used_percent: 30 };
    await putSnapshot(accountId, nextPremium);
    written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(Object.keys(written ?? {}).sort()).toEqual(['codex_bengalfox', 'premium']);
    expect(written?.premium.data).toEqual(nextPremium);
    expect(written?.codex_bengalfox.data).toEqual(bengalfox);
  });

  test('uses the unknown key when active_limit is absent', async () => {
    const snap: CodexQuotaSnapshot = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 42 };
    await putSnapshot(accountId, snap);
    const written = (current!.state as CodexUpstreamState).accounts[0].quotaSnapshot;
    expect(written?.unknown.data).toEqual(snap);
  });

  test('throws when the upstream disappeared mid-flight', async () => {
    current = null;
    await expect(putSnapshot(accountId, { observed_at: 'now' })).rejects.toThrow(/disappeared/);
    expect(repo.writes).toEqual([]);
  });

  test('throws when the requested account is not in the pool', async () => {
    await expect(putSnapshot('acc_other', { observed_at: 'now' })).rejects.toThrow(/not found in upstream/);
    expect(repo.writes).toEqual([]);
  });
});
