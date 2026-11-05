import {
  createECDH, createCipheriv, hkdfSync, randomBytes,
} from "node:crypto";
// Server half of the blind-broker envelope (HACK-140). The browser sends
// an ephemeral ECDH P-256 public key; this module derives a one-time
// AES-256-GCM key and encrypts the minimized Plaid payload. Honesty note:
// the broker still sees plaintext in memory while calling Plaid -- the
// claim is no storage, no logs, encrypted return transit, and a discarded
// provider token, NOT end-to-end encryption against our own server.
import type { BrokerEnvelope } from "./envelope-shared";
export type { BrokerEnvelope } from "./envelope-shared";

const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex",
);

/**
 * The raw P-256 point from a browser's SPKI export, or a throw. This checks
 * the exact SPKI prefix, the uncompressed-point tag, and the length; a
 * caller that needs the point ON the curve must also derive once (see
 * assertBrowserPublicKey).
 */
function browserPublicPoint(clientPublicKeySpkiB64Url: string): Buffer {
  const clientKey = Buffer.from(clientPublicKeySpkiB64Url, "base64url");
  if (clientKey.length !== P256_SPKI_PREFIX.length + 65) {
    throw new Error("Invalid browser key.");
  }
  if (!clientKey.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) {
    throw new Error("Invalid browser key.");
  }
  const peerPoint = clientKey.subarray(P256_SPKI_PREFIX.length);
  if (peerPoint[0] !== 4) throw new Error("Invalid browser key.");
  return peerPoint;
}

/**
 * Validate a browser key WITHOUT calling Plaid (review P3 on PR #172). The
 * pull route checks this before the one Bank Income fetch, so a malformed
 * key is a 400 instead of a wasted pull (and Plaid user) followed by a
 * generic 500 in encryptForBrowser.
 */
export function assertBrowserPublicKey(clientPublicKeySpkiB64Url: string): void {
  const peerPoint = browserPublicPoint(clientPublicKeySpkiB64Url);
  const probe = createECDH("prime256v1");
  probe.generateKeys();
  // Throws when the point is not on P-256.
  probe.computeSecret(peerPoint);
}

function b64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
export function encryptForBrowser(clientPublicKeySpkiB64Url: string, plaintext: string): BrokerEnvelope {
  const peerPoint = browserPublicPoint(clientPublicKeySpkiB64Url);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(peerPoint);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("hack140-blind-broker-v1"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Server public key as SPKI: fixed P-256 SPKI prefix + raw point.
  const rawPoint = ecdh.getPublicKey(null, "uncompressed");
  return { v: 1, serverPublicKey: b64url(Buffer.concat([P256_SPKI_PREFIX, rawPoint])), iv: b64url(iv), ciphertext: b64url(Buffer.concat([encrypted, tag])) };
}
