-- Conversation turn history (Mission v2 M1, BN-13 for conversations).
-- Every stored transcript is REDACTED before it reaches this table: private
-- values from pii:true spec questions live only in the vault, never here,
-- never in a client payload. Append-only history used for resume and for
-- grounding the assistant's reply prompt.

CREATE TABLE conversation_turn (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES session (id),
  role text
    NOT NULL
    CONSTRAINT conversation_turn_role_check
    CHECK (role IN ('user', 'assistant')),
  redacted_transcript text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_turn_session_id_idx ON conversation_turn (session_id);
