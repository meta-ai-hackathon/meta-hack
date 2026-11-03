export interface BrokerEnvelope {
  readonly v: 1;
  readonly serverPublicKey: string;
  readonly iv: string;
  readonly ciphertext: string;
}
