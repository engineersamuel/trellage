// Plain HTTP on a tailnet IP is not a secure context, so browsers omit crypto.randomUUID.
// agent-interface's readFlags (patched, see patches/) needs it; getRandomValues still works there.
// Imported first in main.ts: ES imports run in order, before any module that reads the session id.
// NOTE: a browser global, not app state; it runs once at load, outside every update.
/* oxlint-disable foldkit/no-impure-call-at-decision-time */
type Uuid = `${string}-${string}-${string}-${string}-${string}`;

const isUuid = (value: string): value is Uuid => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const randomUuidV4 = (): Uuid => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!isUuid(uuid)) throw new Error(`bad uuid ${uuid}`);
  return uuid;
};

if (typeof globalThis.crypto.randomUUID !== "function") globalThis.crypto.randomUUID = randomUuidV4;
