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
function b64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
export function encryptForBrowser(clientPublicKeySpkiB64Url: string, plaintext: string): BrokerEnvelope {
  const clientKey = Buffer.from(clientPublicKeySpkiB64Url, "base64url");
  if (clientKey.length < 80 || clientKey.length > 200) throw new Error("Invalid browser key.");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // Node's ECDH expects the peer public point, while browsers export SPKI.
  // The SPKI P-256 prefix is fixed; its final 65 bytes are the raw point.
  const peerPoint = clientKey.subarray(clientKey.length - 65);
  if (peerPoint.length !== 65 || peerPoint[0] !== 4) throw new Error("Invalid browser key.");
  const shared = ecdh.computeSecret(peerPoint);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("hack140-blind-broker-v1"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Server public key as SPKI: fixed P-256 SPKI prefix + raw point.
  const rawPoint = ecdh.getPublicKey(null, "uncompressed");
  const spkiPrefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return { v: 1, serverPublicKey: b64url(Buffer.concat([spkiPrefix, rawPoint])), iv: b64url(iv), ciphertext: b64url(Buffer.concat([encrypted, tag])) };
}




