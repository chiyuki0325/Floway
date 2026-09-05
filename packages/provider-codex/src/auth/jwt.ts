// Decode-only id_token claim extraction. Signature verification is intentionally
// skipped: the token reached us over TLS from auth.openai.com itself; spending
// effort on signature-validating a token we just fetched would be theatre.

import { decodeCanonicalBase64url } from '@floway-dev/protocols/common';

export interface CodexIdTokenIdentity {
  email?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  planType?: string;
  isFedRampAccount: boolean;
}

export const parseCodexIdTokenClaims = (idToken: string): CodexIdTokenIdentity => {
  const payload = parseCodexJwtPayload(idToken, 'id_token');
  const profile = pickObjectOptional(payload, 'https://api.openai.com/profile');
  const auth = pickObjectOptional(payload, 'https://api.openai.com/auth');

  const email = pickStringOptional(payload, 'email') ?? (profile ? pickStringOptional(profile, 'email') : undefined);
  const chatgptAccountId = auth ? pickStringOptional(auth, 'chatgpt_account_id') : undefined;
  const chatgptUserId = auth
    ? pickStringOptional(auth, 'chatgpt_user_id') ?? pickStringOptional(auth, 'user_id')
    : undefined;
  const planType = auth ? pickStringOptional(auth, 'chatgpt_plan_type') : undefined;
  return {
    ...(email === undefined ? {} : { email }),
    ...(chatgptAccountId === undefined ? {} : { chatgptAccountId }),
    ...(chatgptUserId === undefined ? {} : { chatgptUserId }),
    ...(planType === undefined ? {} : { planType }),
    isFedRampAccount: auth ? pickBooleanOptional(auth, 'chatgpt_account_is_fedramp') ?? false : false,
  };
};

// Refresh responses need only update the capability-relevant plan claim. The
// account identity was validated at import, and OpenAI may omit unrelated
// profile claims from a later id_token. Missing plan returns `undefined` so
// callers can preserve the latest observation or use the import-time identity;
// malformed present claims still surface.
export const parseCodexIdTokenPlanType = (idToken: string): string | undefined => {
  const payload = parseCodexJwtPayload(idToken, 'id_token');
  const auth = payload['https://api.openai.com/auth'];
  if (auth === undefined) return undefined;
  if (!isObject(auth)) throw new Error('id_token https://api.openai.com/auth claim is not an object');
  const planType = auth.chatgpt_plan_type;
  if (planType === undefined) return undefined;
  if (typeof planType !== 'string' || planType === '') throw new Error('id_token has malformed chatgpt_plan_type claim');
  return planType;
};

export const parseCodexAccessTokenExpiresAt = (accessToken: string): number | undefined => {
  let payload: Record<string, unknown>;
  try {
    payload = parseCodexJwtPayload(accessToken, 'access_token');
  } catch {
    return undefined;
  }
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) return undefined;
  const expiresAt = exp * 1000;
  return Number.isSafeInteger(expiresAt) ? expiresAt : undefined;
};

const parseCodexJwtPayload = (jwt: string, tokenName: 'access_token' | 'id_token'): Record<string, unknown> => {
  const segments = jwt.split('.');
  if (segments.length !== 3) throw new Error(`${tokenName} must have 3 segments, got ${segments.length}`);

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlToUtf8(segments[1]));
  } catch (cause) {
    throw new Error(`${tokenName} payload is not base64url-encoded JSON`, { cause: cause as Error });
  }

  if (!isObject(payload)) throw new Error(`${tokenName} payload is not an object`);
  return payload;
};

const decodeBase64UrlToUtf8 = (value: string): string => {
  // JOSE compact serialization uses canonical unpadded Base64URL.
  // https://www.rfc-editor.org/rfc/rfc7515.html#section-2
  const bytes = decodeCanonicalBase64url(value);
  if (bytes === null) throw new TypeError('Invalid canonical Base64URL JWT segment');
  return new TextDecoder().decode(bytes);
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const pickObjectOptional = (record: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error(`id_token ${key} claim is not an object`);
  return value;
};

const pickStringOptional = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`id_token has malformed ${key} claim`);
  return value === '' ? undefined : value;
};

const pickBooleanOptional = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`id_token has malformed ${key} claim`);
  return value;
};
