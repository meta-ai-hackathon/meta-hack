// HACK-107: encrypted on-device persistence for the Rampart session table.
//
// The Rampart session table maps placeholders (e.g. [GIVEN_NAME_1]) to raw
// PII values, so its serialized form is itself raw PII. It is therefore
// never stored in plaintext, never logged, and never sent anywhere: it is
// sealed with the same AES-256-GCM "sealed1." envelope and the same
// non-extractable device key as the intake answers (device-answer-store.ts),
// under DEVICE_SESSION_ENVELOPE_KEY in the same IndexedDB store. The key and
// the sealed session are always read in one transaction and written in one
// transaction so the pair always matches. Purge is handled by
// purgeDeviceAnswers, which already deletes this envelope together with the
// answers envelope and the key, and verifies all three are gone.
//
// This module treats the serialized session as an opaque non-empty string.
// Shape validation belongs to Rampart's fail-closed deserialize(); this
// layer only guarantees confidentiality at rest and purge/CAS semantics
// mirroring recordDeviceAnswer.

import { openSealed, sealForStorage } from "./client-store";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_SAVE_ATTEMPTS,
  DEVICE_SESSION_ENVELOPE_KEY,
  generateSealingKey,
  isSealingKey,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";

export type RampartSessionLoad =
  | { status: "none" }
  | { status: "ok"; serialized: string }
  | { status: "unreadable" };

export type RampartSessionSave = "saved" | "purged" | "busy";

export interface SaveRampartSessionOptions {
  expectStored?: boolean;
}

function envelopeIdentity(raw: unknown): string {
  if (raw === undefined) return "none";
  if (typeof raw === "string") return `sealed:${raw}`;
  return "other";
}

interface SessionRead {
  identity: string;
  key: CryptoKey | null;
  serialized: string | null;
}

async function readStored(deps: DeviceAnswerStoreDeps): Promise<SessionRead> {
  const [rawEnvelope, rawKey] = await deps.kv.getMany([
    DEVICE_SESSION_ENVELOPE_KEY,
    DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  ]);
  const identity = envelopeIdentity(rawEnvelope);
  const key = isSealingKey(rawKey) ? rawKey : null;
  if (rawEnvelope === undefined) {
    return { identity, key, serialized: null };
  }
  if (typeof rawEnvelope !== "string" || key === null) {
    return { identity, key, serialized: null };
  }
  const serialized = await openSealed(rawEnvelope, key, deps.subtle);
  return { identity, key, serialized };
}

export async function loadRampartSession(
  deps: DeviceAnswerStoreDeps,
): Promise<RampartSessionLoad> {
  const [rawEnvelope, rawKey] = await deps.kv.getMany([
    DEVICE_SESSION_ENVELOPE_KEY,
    DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  ]);
  if (rawEnvelope === undefined) return { status: "none" };
  if (typeof rawEnvelope !== "string" || !isSealingKey(rawKey)) {
    return { status: "unreadable" };
  }
  const serialized = await openSealed(rawEnvelope, rawKey, deps.subtle);
  if (serialized === null) return { status: "unreadable" };
  return { status: "ok", serialized };
}

export async function saveRampartSession(
  deps: DeviceAnswerStoreDeps,
  serialized: string,
  options: SaveRampartSessionOptions = {},
): Promise<RampartSessionSave> {
  if (typeof serialized !== "string" || serialized.trim() === "") {
    throw new Error("Cannot store an empty Rampart session.");
  }
  let expectStored = options.expectStored === true;
  for (let attempt = 0; attempt < DEVICE_SAVE_ATTEMPTS; attempt += 1) {
    const read = await readStored(deps);
    if (expectStored && read.identity === "none") {
      return "purged";
    }
    const key = read.key ?? (await generateSealingKey(deps.subtle));
    const sealed = await sealForStorage(serialized, key, deps.subtle);
    const written = await deps.kv.setMany(
      [
        [DEVICE_ANSWERS_CRYPTO_KEY_KEY, key],
        [DEVICE_SESSION_ENVELOPE_KEY, sealed],
      ],
      {
        key: DEVICE_SESSION_ENVELOPE_KEY,
        keep: (current) => envelopeIdentity(current) !== read.identity,
      },
    );
    if (written) return "saved";
    expectStored = expectStored || read.identity !== "none";
  }
  return "busy";
}
