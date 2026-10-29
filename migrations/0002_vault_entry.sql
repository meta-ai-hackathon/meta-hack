-- PII vault (BN-03 / HACK-31). Identity details and other pii:true answers
-- live here, structurally separate from answer/person: nothing in the prompt
-- pipeline may touch this table. src/lib/vault.ts is the ONLY module allowed
-- to read or write it (enforced by src/lib/vault-boundary.test.ts).

CREATE TABLE vault_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES session (id),
  field text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_entry_session_field_unique UNIQUE (session_id, field)
);

CREATE INDEX vault_entry_session_id_idx ON vault_entry (session_id);
