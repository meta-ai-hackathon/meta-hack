import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decryptVaultValue,
  encryptVaultValue,
  isVaultEnvelope,
} from "./vault-crypto";

// Unit suite for the vault's app-side encryption (VAL-VAULTENC-001/002):
// AES-256-GCM envelopes sealed with the key from VAULT_ENC_KEY. The DB-level
// proofs — a direct row read shows ciphertext for the full pii:true spec
// population, app reads round-trip, legacy plaintext is re-encrypted on
// read — live in vault.test.ts. This file proves the crypto contract alone:
// round-trip identity over arbitrary values, envelope structure, tamper and
// garbage rejection, and fail-closed behavior when the key is missing or
// invalid. No key material ever appears in an error message.

const TEST_KEY =
  "3eaf11c0ffee42d7ba5e6098d1c2b3a47f6e5d4c9b8a73625140f3e2d1c0b9a8";

/** Run fn with VAULT_ENC_KEY overridden (or unset), restoring it after. */
function withKey<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.VAULT_ENC_KEY;
  if (value === undefined) {
    delete process.env.VAULT_ENC_KEY;
  } else {
    process.env.VAULT_ENC_KEY = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.VAULT_ENC_KEY;
    } else {
      process.env.VAULT_ENC_KEY = previous;
    }
  }
}

function envelopeOf(plaintext: string): {
  prefix: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  envelope: string;
} {
  const envelope = withKey(TEST_KEY, () => encryptVaultValue(plaintext));
  const [prefix, ivPart, tagPart, ciphertextPart] = envelope.split(".");
  return {
    iv: Buffer.from(ivPart ?? "", "base64"),
    tag: Buffer.from(tagPart ?? "", "base64"),
    ciphertext: Buffer.from(ciphertextPart ?? "", "base64"),
    envelope,
    prefix,
  };
}

describe("round-trip identity (property)", () => {
  it("decrypts every arbitrary plaintext back to itself", () => {
    const roundTrip = fc.property(fc.string(), (plaintext) => {
      return withKey(TEST_KEY, () => decryptVaultValue(encryptVaultValue(plaintext))) === plaintext;
    });
    fc.assert(roundTrip, { numRuns: 300 });
  });

  it("round-trips values that only the vault's non-blank rule excludes", () => {
    // Whitespace-only values never reach the crypto layer (vaultPut rejects
    // them first), but the crypto itself must survive any string the caller
    // hands it — leading/trailing whitespace, control characters, unicode.
    const roundTrip = fc.property(
      fc.string({ minLength: 1 }).map((value) => `v${value}`),
      (plaintext) => {
        return withKey(TEST_KEY, () => decryptVaultValue(encryptVaultValue(plaintext))) === plaintext;
      },
    );
    fc.assert(roundTrip, { numRuns: 200 });
  });
});

describe("envelope structure", () => {
  it("every envelope is enc1.<iv>.<tag>.<ciphertext> with GCM sizes (property)", () => {
    const shaped = fc.property(fc.string(), (plaintext) => {
      const { prefix, iv, tag, envelope } = envelopeOf(plaintext);
      if (prefix !== "enc1") return false;
      if (iv.length !== 12) return false; // GCM standard nonce
      if (tag.length !== 16) return false; // GCM auth tag
      return isVaultEnvelope(envelope);
    });
    fc.assert(shaped, { numRuns: 100 });
  });

  it("seals the same plaintext under a fresh IV every time", () => {
    const fresh = fc.property(
      fc.string({ minLength: 1 }),
      (plaintext) => {
        return withKey(TEST_KEY, () => {
          const first = encryptVaultValue(plaintext);
          const second = encryptVaultValue(plaintext);
          return first !== second;
        });
      },
    );
    fc.assert(fresh, { numRuns: 50 });
  });

  it("isVaultEnvelope admits only well-formed envelopes, never free text", () => {
    const admission = fc.property(
      fc.string().filter((value) => !value.startsWith("enc1.")),
      (freeText) => !isVaultEnvelope(freeText),
    );
    fc.assert(admission, { numRuns: 300 });
    expect(isVaultEnvelope("Franklin")).toBe(false);
    expect(isVaultEnvelope("enc1.only.two")).toBe(false);
    expect(isVaultEnvelope("enc1.!!!.???..**")).toBe(false);
  });
});

describe("fail-closed key handling", () => {
  it("a missing key rejects both directions with a taxonomy error", () => {
    expect(() =>
      withKey(undefined, () => encryptVaultValue("Franklin")),
    ).toThrowError(expect.objectContaining({ code: "internal" }));
    const sealed = withKey(TEST_KEY, () => encryptVaultValue("Franklin"));
    expect(() =>
      withKey(undefined, () => decryptVaultValue(sealed)),
    ).toThrowError(expect.objectContaining({ code: "internal" }));
  });

  it("an invalid key (wrong length, non-hex) rejects with a taxonomy error", () => {
    for (const bad of ["", "short", "g".repeat(64), `${TEST_KEY}0`]) {
      expect(() =>
        withKey(bad, () => encryptVaultValue("Franklin")),
      ).toThrowError(expect.objectContaining({ code: "internal" }));
    }
  });

  it("no error message ever carries the key or the plaintext", () => {
    const probe = (fn: () => unknown): string => {
      try {
        fn();
      } catch (caught) {
        return caught instanceof Error ? `${caught.message}` : "";
      }
      return "";
    };
    const messages = [
      probe(() => withKey(undefined, () => encryptVaultValue("Franklin"))),
      probe(() => withKey("g".repeat(64), () => encryptVaultValue("Franklin"))),
      probe(() =>
        withKey(TEST_KEY, () => decryptVaultValue("enc1.bogus.bogus.bogus")),
      ),
    ];
    for (const message of messages) {
      expect(message).not.toContain(TEST_KEY);
      expect(message).not.toContain("Franklin");
      expect(message).not.toContain("bogus");
    }
  });
});

describe("tamper and garbage rejection", () => {
  it("flipping any ciphertext byte fails the GCM auth check (property)", () => {
    const tampered = fc.property(
      fc.string({ minLength: 1 }),
      fc.nat(15),
      (plaintext, byteIndex) => {
        const { iv, tag, ciphertext } = envelopeOf(plaintext);
        const flipped = Buffer.from(ciphertext);
        flipped[byteIndex % flipped.length] ^= 0xff;
        const broken = `enc1.${iv.toString("base64")}.${tag.toString("base64")}.${flipped.toString("base64")}`;
        try {
          withKey(TEST_KEY, () => decryptVaultValue(broken));
          return false; // decryption of tampered data must never succeed
        } catch (caught) {
          return (
            caught instanceof Error &&
            (caught as { code?: string }).code === "internal"
          );
        }
      },
    );
    fc.assert(tampered, { numRuns: 100 });
  });

  it("a tampered envelope is rejected, never decrypted (explicit cases)", () => {
    const sealed = withKey(TEST_KEY, () => encryptVaultValue("1990-01-01"));
    const [, iv, tag, ciphertextPart] = sealed.split(".");
    const flip = (part: string): string => {
      const bytes = Buffer.from(part, "base64");
      bytes[0] ^= 0xff;
      return bytes.toString("base64");
    };
    for (const broken of [
      `enc1.${flip(iv as string)}.${tag}.${ciphertextPart}`,
      `enc1.${iv}.${flip(tag as string)}.${ciphertextPart}`,
      `enc1.${iv}.${tag}.${flip(ciphertextPart as string)}`,
    ]) {
      const attempt = () =>
        withKey(TEST_KEY, () => decryptVaultValue(broken));
      expect(attempt).toThrowError(
        expect.objectContaining({ code: "internal" }),
      );
    }
  });

  it("garbage input is rejected, never returned as plaintext (property)", () => {
    const rejection = fc.property(fc.string(), (garbage) => {
      if (isVaultEnvelope(garbage)) return true; // covered by round-trip
      try {
        withKey(TEST_KEY, () => decryptVaultValue(garbage));
        return false; // must have thrown
      } catch (caught) {
        return (
          caught instanceof Error &&
          (caught as { code?: string }).code === "internal"
        );
      }
    });
    fc.assert(rejection, { numRuns: 300 });
  });
});
