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
  envelopeIdentity,
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

interface SessionRead {
  identity: string;
  key: CryptoKey | null;
  /** True when the key slot holds nothing at all (a fresh device). */
  keySlotEmpty: boolean;
  /** The plaintext serialized session, or null when none/unreadable. */
  serialized: string | null;
}

async function readStored(deps: DeviceAnswerStoreDeps): Promise<SessionRead> {
  const [rawEnvelope, rawKey] = await deps.kv.getMany([
    DEVICE_SESSION_ENVELOPE_KEY,
    DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  ]);
  const identity = envelopeIdentity(rawEnvelope);
  const key = isSealingKey(rawKey) ? rawKey : null;
  const keySlotEmpty = rawKey === undefined || rawKey === null;
  if (identity === "none") {
    return { identity, key, keySlotEmpty, serialized: null };
  }
  if (typeof rawEnvelope !== "string" || key === null) {
    return { identity, key, keySlotEmpty, serialized: null };
  }
  const serialized = await openSealed(rawEnvelope, key, deps.subtle);
  return { identity, key, keySlotEmpty, serialized };
}

export async function loadRampartSession(
  deps: DeviceAnswerStoreDeps,
): Promise<RampartSessionLoad> {
  const read = await readStored(deps);
  if (read.identity === "none") return { status: "none" };
  if (read.serialized === null) return { status: "unreadable" };
  return { status: "ok", serialized: read.serialized };
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
    // A usable stored key is reused and never rewritten: a concurrent first
    // save of the answers envelope must not be orphaned by this writer. A
    // generated key write is two anchored writes (review P2), mirroring
    // recordDeviceAnswer: first the key slot is CLAIMED while it holds
    // nothing usable — empty, or garbage that seals nothing, which is
    // replaced like an empty slot so a damaged slot cannot orphan this save
    // behind a key that is never stored (review P3) — so only one
    // overlapping first save lands a key and the loser retries under the
    // winner's key. Then the session envelope LANDS anchored on the
    // envelope read: a purge between this save's read and its write has
    // deleted the envelope, its identity no longer matches, and the write
    // aborts — the retry reports "purged" (the map is raw PII; HACK-80) —
    // and a concurrent save that replaced it aborts the same way, the
    // retry merging on top. When nothing was read (a fresh device) a purge
    // removed nothing, so landing is that save, not a resurrection.
    const freshKey = read.key === null;
    const key = read.key ?? (await generateSealingKey(deps.subtle));
    const sealed = await sealForStorage(serialized, key, deps.subtle);
    let written: boolean;
    if (freshKey) {
      written = await deps.kv.setMany([[DEVICE_ANSWERS_CRYPTO_KEY_KEY, key]], {
        key: DEVICE_ANSWERS_CRYPTO_KEY_KEY,
        // Claim only an unusable slot (empty or garbage): a concurrent
        // writer's usable key is kept, never replaced.
        keep: (current) => isSealingKey(current),
      });
      if (written) {
        // Land only on the session that was read: the envelope is the
        // anchor, so a purge or a newer save since the read aborts this
        // write (see the comment above).
        written = await deps.kv.setMany([[DEVICE_SESSION_ENVELOPE_KEY, sealed]], {
          key: DEVICE_SESSION_ENVELOPE_KEY,
          keep: (current) => envelopeIdentity(current) !== read.identity,
        });
      }
    } else {
      written = await deps.kv.setMany([[DEVICE_SESSION_ENVELOPE_KEY, sealed]], {
        key: DEVICE_SESSION_ENVELOPE_KEY,
        keep: (current) => envelopeIdentity(current) !== read.identity,
      });
    }
    if (written) return "saved";
    expectStored = expectStored || read.identity !== "none";
  }
  return "busy";
}
