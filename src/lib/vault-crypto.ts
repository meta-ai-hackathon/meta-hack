import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./telemetry";

// App-side encryption for the PII vault (VAL-VAULTENC-001/002): every value
// is sealed with AES-256-GCM under the key in VAULT_ENC_KEY before it ever
// touches Postgres, and unsealed only inside vault.ts's read paths.
//
// Storage format (documented decision, Mission v2.1 M5): the existing
// `vault_entry.value` TEXT column holds a versioned base64 envelope —
//
//   enc1.<iv base64>.<tag base64>.<ciphertext base64>
//
// — rather than a bytea column. Rationale: no schema change is required
// (migrations stay append-only; none is needed), values remain printable
// with ordinary psql tooling, and the envelope prefix makes ciphertext
// self-identifying so the legacy handoff (see vault.ts's
// decryptedRowValues) is unambiguous. Free-text PII answers never begin
// with "enc1."; a value shaped like an envelope that fails GCM
// authentication fails closed rather than degrading to plaintext.
//
// Key discipline:
// - VAULT_ENC_KEY is exactly 64 hex characters (32 bytes = AES-256);
//   generate with `openssl rand -hex 32`.
// - A missing or invalid key FAILS CLOSED: encryption and decryption both
//   throw a taxonomy error (internal). There is no plaintext fallback,
//   ever — including reads of legacy plaintext rows, which are not served
//   without a usable key.
// - The key is never logged, echoed, or committed, and never appears in an
//   error message or cause: every failure surfaces one safe, detail-free
//   message. Corrupted ciphertext is likewise detail-free (an
//   authentication failure must not teach an attacker anything).

const ENVELOPE_PREFIX = "enc1";
const KEY_HEX_LENGTH = 64; // 32 bytes = AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// The ciphertext part alone may be empty: AES-GCM of the empty string
// produces zero ciphertext bytes (the tag alone authenticates it).
const BASE64_OR_EMPTY_PATTERN = /^(?:[A-Za-z0-9+/]+={0,2})?$/;

function loadKey(): Buffer {
  const raw = process.env.VAULT_ENC_KEY;
  if (
    typeof raw === "string" &&
    raw.length === KEY_HEX_LENGTH &&
    /^[0-9a-fA-F]+$/.test(raw)
  ) {
    return Buffer.from(raw, "hex");
  }
  throw vaultUnavailable("key");
}

/** Safe, detail-free failure for every key or ciphertext problem. */
function vaultUnavailable(reason: "key" | "ciphertext"): AppError {
  return new AppError(
    "internal",
    reason === "key"
      ? "The encrypted vault is unavailable because its encryption key is missing or invalid."
      : "The stored vault data could not be read.",
  );
}

/**
 * Validate the key up front — the fail-closed gate read paths run before
 * any stored value is decrypted or served.
 */
export function requireVaultKey(): void {
  loadKey();
}

/**
 * True when a stored value is an encrypted envelope (as opposed to a
 * legacy plaintext row written before VAL-VAULTENC-001). Envelope parts
 * must be well-formed base64; anything else is treated as legacy plaintext.
 */
export function isVaultEnvelope(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    return false;
  }
  const [, iv, tag, ciphertext] = parts;
  return (
    BASE64_PATTERN.test(iv) &&
    BASE64_PATTERN.test(tag) &&
    BASE64_OR_EMPTY_PATTERN.test(ciphertext)
  );
}

/**
 * Seal one value under a fresh random IV. Returns the versioned envelope
 * string that vault.ts stores in vault_entry.value. Throws a taxonomy
 * error when the key is missing or invalid (nothing is ever stored
 * unencrypted as a fallback).
 */
export function encryptVaultValue(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    // Unreachable with the pinned constants; guards against a silent
    // format drift if the algorithm constants ever change.
    throw vaultUnavailable("ciphertext");
  }
  return [
    ENVELOPE_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Open one stored envelope value. Throws a taxonomy error when the value
 * is not a well-formed envelope or fails GCM authentication — never
 * returns a best-effort guess, and never leaks ciphertext, plaintext, or
 * key material in the error.
 */
export function decryptVaultValue(stored: string): string {
  if (!isVaultEnvelope(stored)) {
    throw vaultUnavailable("ciphertext");
  }
  const key = loadKey();
  const [, ivPart, tagPart, ciphertextPart] = stored.split(".");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivPart, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw vaultUnavailable("ciphertext");
  }
}
