// Browser half of the blind-broker envelope (HACK-140). The ephemeral
// private key is generated per pull, kept only in page memory, and never
// sent anywhere; only its SPKI public key goes to the broker.
import type { BrokerEnvelope } from "./envelope-shared";
export type { BrokerEnvelope } from "./envelope-shared";
function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = ""; for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out as Uint8Array<ArrayBuffer>;
}
export interface EphemeralBrowserKey {
  readonly privateKey: CryptoKey;
  readonly publicKeySpki: string;
}
export async function generateEphemeralBrowserKey(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<EphemeralBrowserKey> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const spki = await subtle.exportKey("spki", pair.publicKey);
  return { privateKey: pair.privateKey, publicKeySpki: b64urlEncode(spki) };
}
export async function decryptEnvelope(envelope: BrokerEnvelope, privateKey: CryptoKey, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<unknown> {
  const serverKey = await subtle.importKey("spki", b64urlDecode(envelope.serverPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, privateKey, 256);
  const keyMaterial = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("hack140-blind-broker-v1") }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(envelope.iv) }, key, b64urlDecode(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}
