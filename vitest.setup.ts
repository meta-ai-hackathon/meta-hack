// Test-only vault key (a throwaway fixture value, NOT a secret — the real
// VAULT_ENC_KEY lives only in env/Vercel and is never committed). The vault
// is fail-closed: without a key in the environment every put/read throws, so
// suites that exercise vault paths (vaultPut, saveAnswer's pii routing, the
// forms fill) need one set before they run. The fail-closed behavior itself
// is proven in vault.test.ts, which overrides or unsets this variable
// in-process and restores it afterwards.
process.env.VAULT_ENC_KEY ||= String(process.env.VITEST_VAULT_TEST_KEY ?? "");
if (!process.env.VAULT_ENC_KEY) {
  process.env.VAULT_ENC_KEY =
    "3eaf11c0ffee42d7ba5e6098d1c2b3a47f6e5d4c9b8a73625140f3e2d1c0b9a8";
}
