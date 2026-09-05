import { v4, v5, v7 } from 'uuid';

import { sha256Json } from '@floway-dev/provider';

// Format SHA-256 digests as UUIDv4-shaped opaque identifiers for Floway-owned
// stable ids where we intentionally do not mimic Codex's random persisted device id.
const digestUuid = (digest: Uint8Array): string => v4({ random: digest });

export const sha256JsonUuid = (value: unknown, prefix: string): string =>
  digestUuid(sha256Json(value, prefix));

export const uuidV5 = (value: string | Uint8Array, namespace: string): string => v5(value, namespace);

// https://www.rfc-editor.org/rfc/rfc9562.html#name-namespace-id-usage-and-allo
export const UUID_V5_OID_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

export const uuidV7 = (): string => v7();
