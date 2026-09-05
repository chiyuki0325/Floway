import { findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount } from './state.ts';
import { getProviderRepo } from '@floway-dev/provider';

export type CodexRateLimitReachedType =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached';

export interface CodexQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  limit_name?: string;
  plan_type?: string;

  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;

  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;

  credits_has_credits?: boolean;
  credits_unlimited?: boolean;
  credits_balance?: string;
  promo_message?: string;
  rate_limit_reached_type?: CodexRateLimitReachedType;

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string;
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>;

const isUnsafeLimitKey = (key: string): boolean => key === '' || key === '__proto__' || key === 'constructor' || key === 'prototype';

interface ParseCodexQuotaOptions {
  now: Date;
  isRateLimited: boolean;
  errorBody?: string;
}

const RATE_LIMIT_REACHED_TYPES = new Set<CodexRateLimitReachedType>([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

const normalizeLimitId = (value: string): string => value.trim().toLowerCase().replaceAll('-', '_');
const safeLimitId = (value: string): string | undefined => {
  const normalized = normalizeLimitId(value);
  return isUnsafeLimitKey(normalized) ? undefined : normalized;
};
const headerPrefixForLimit = (limitId: string): string => `x-${limitId.replaceAll('_', '-')}`;

export const parseCodexQuotaHeaders = (headers: Headers, options: ParseCodexQuotaOptions): CodexQuotaSnapshotMap => {
  const observedAt = options.now.toISOString();
  const activeLimit = safeLimitId(headers.get('x-codex-active-limit') ?? '') ?? 'codex';
  const limitIds = new Set<string>(['codex']);
  headers.forEach((_value, name) => {
    const match = /^x-(.+)-primary-used-percent$/i.exec(name);
    const limitId = match?.[1] ? safeLimitId(match[1]) : undefined;
    if (limitId !== undefined) limitIds.add(limitId);
  });
  if (options.isRateLimited) limitIds.add(activeLimit);

  const stringHeader = (name: string): string | undefined => {
    const value = headers.get(name)?.trim();
    if (value === undefined || value === '') return undefined;
    return value;
  };
  const numberHeader = (name: string): number | undefined => {
    const value = stringHeader(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const boolHeader = (name: string): boolean | undefined => {
    const value = stringHeader(name)?.toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return undefined;
  };
  const resetInstant = (prefix: string): string | undefined => {
    const at = stringHeader(`${prefix}-reset-at`);
    if (at !== undefined) {
      const epochSeconds = Number(at);
      const instant = Number.isFinite(epochSeconds) ? epochSeconds * 1000 : Date.parse(at);
      if (Number.isFinite(instant) && instant > 0) return new Date(instant).toISOString();
    }
    const seconds = numberHeader(`${prefix}-reset-after-seconds`);
    return seconds !== undefined && seconds > 0
      ? new Date(options.now.getTime() + seconds * 1000).toISOString()
      : undefined;
  };
  const windowFields = (prefix: string, kind: 'primary' | 'secondary'): Partial<CodexQuotaSnapshot> => {
    const usedPercent = numberHeader(`${prefix}-used-percent`);
    if (usedPercent === undefined) return {};
    const windowMinutes = numberHeader(`${prefix}-window-minutes`);
    const resetAt = resetInstant(prefix);
    if (usedPercent === 0 && (windowMinutes === undefined || windowMinutes === 0) && resetAt === undefined) return {};
    return kind === 'primary'
      ? {
          primary_used_percent: usedPercent,
          ...(windowMinutes !== undefined && { primary_window_minutes: windowMinutes }),
          ...(resetAt !== undefined && { primary_reset_after_at: resetAt }),
        }
      : {
          secondary_used_percent: usedPercent,
          ...(windowMinutes !== undefined && { secondary_window_minutes: windowMinutes }),
          ...(resetAt !== undefined && { secondary_reset_after_at: resetAt }),
        };
  };

  let errorPlanType: string | undefined;
  let errorResetAt: string | undefined;
  if (options.isRateLimited && options.errorBody !== undefined) {
    try {
      const parsed = JSON.parse(options.errorBody) as { error?: unknown };
      if (typeof parsed.error === 'object' && parsed.error !== null && !Array.isArray(parsed.error)) {
        const error = parsed.error as Record<string, unknown>;
        if (error.type === 'usage_limit_reached') {
          if (typeof error.plan_type === 'string' && error.plan_type.trim() !== '') errorPlanType = error.plan_type.trim();
          if (typeof error.resets_at === 'number' && Number.isSafeInteger(error.resets_at) && error.resets_at > 0) {
            errorResetAt = new Date(error.resets_at * 1000).toISOString();
          }
        }
      }
    } catch {
      // The upstream response remains authoritative and is returned unchanged.
    }
  }

  const planType = errorPlanType ?? stringHeader('x-codex-plan-type');
  const creditsHasCredits = boolHeader('x-codex-credits-has-credits');
  const creditsUnlimited = boolHeader('x-codex-credits-unlimited');
  const creditsBalance = stringHeader('x-codex-credits-balance');
  const promoMessage = stringHeader('x-codex-promo-message');
  const reachedTypeHeader = stringHeader('x-codex-rate-limit-reached-type');
  const rateLimitReachedType = reachedTypeHeader !== undefined && RATE_LIMIT_REACHED_TYPES.has(reachedTypeHeader as CodexRateLimitReachedType)
    ? reachedTypeHeader as CodexRateLimitReachedType
    : undefined;

  const snapshots: CodexQuotaSnapshotMap = {};
  for (const limitId of [...limitIds].sort()) {
    if (options.isRateLimited && limitId !== activeLimit) continue;
    const prefix = headerPrefixForLimit(limitId);
    const limitName = stringHeader(`${prefix}-limit-name`);
    const snapshot: CodexQuotaSnapshot = {
      observed_at: observedAt,
      active_limit: limitId,
      ...(limitName !== undefined && { limit_name: limitName }),
      ...(planType !== undefined && { plan_type: planType }),
      ...windowFields(`${prefix}-primary`, 'primary'),
      ...windowFields(`${prefix}-secondary`, 'secondary'),
      ...(creditsHasCredits !== undefined && { credits_has_credits: creditsHasCredits }),
      ...(creditsUnlimited !== undefined && { credits_unlimited: creditsUnlimited }),
      ...(creditsBalance !== undefined && { credits_balance: creditsBalance }),
      ...(promoMessage !== undefined && { promo_message: promoMessage }),
      ...(rateLimitReachedType !== undefined && { rate_limit_reached_type: rateLimitReachedType }),
      ...(options.isRateLimited && errorResetAt !== undefined && { ratelimited_until: errorResetAt }),
    };
    if (limitId === 'codex' || options.isRateLimited || hasCodexQuotaReading(snapshot)) snapshots[limitId] = snapshot;
  }
  return snapshots;
};

export const hasCodexQuotaReading = (snapshot: CodexQuotaSnapshot): boolean => {
  const { observed_at: _observationTime, active_limit: _limitId, ...reading } = snapshot;
  return Object.keys(reading).length > 0;
};

// Every quota snapshot this account has observed, keyed by normalized limit family.
//
// No TTL, which is the rule the other three providers state at their own slots:
// a reading rendered with the instant it was taken tells an operator more than
// an empty card does, and any traffic on the upstream replaces it. Only the
// dashboard reads this -- the data plane routes without consulting it -- so
// withholding a reading buys nothing and costs the page the only answer it has.
export const getCodexQuota = async (
  upstreamId: string,
  accountId: string | undefined,
): Promise<CodexQuotaSnapshotMap | null> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return null;
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  const snapshots = account?.quotaSnapshot;
  if (!snapshots || Object.keys(snapshots).length === 0) return null;
  return Object.fromEntries(Object.entries(snapshots).map(([key, entry]) => [key, entry.data]));
};

export const putCodexQuota = async (
  upstreamId: string,
  accountId: string | undefined,
  snapshots: CodexQuotaSnapshotMap,
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later `fetchedAt`.
  const fetchedAt = Date.now();
  const entries = Object.entries(snapshots);
  const unsafeKey = entries.find(([key]) => isUnsafeLimitKey(key))?.[0];
  if (unsafeKey !== undefined) throw new TypeError(`putCodexQuota: invalid limit family key '${unsafeKey}'`);
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`putCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return replaceCodexAccount(state, idx, account => ({
      ...account,
      quotaSnapshot: {
        ...account.quotaSnapshot ?? {},
        ...Object.fromEntries(entries.map(([key, data]) => [key, { fetchedAt, data }])),
      },
    }));
  });
};
