-- Form-driven answers (Mission v2 M4 / HACK-74): answers to application-form
-- questions that do NOT map to a question-spec id. Fields mapped to the spec
-- live in the ordinary `answer` table (and the vault for pii:true values);
-- this table holds only the form-specific extras, keyed by the form-registry
-- entry they belong to. Values are sensitive-by-default: never logged, never
-- echoed into prompts, and omitted from client payloads whenever the
-- registry marks the field piiLikely.

CREATE TABLE form_answer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES session (id),
  form_id text NOT NULL,
  field_name text NOT NULL,
  value text NOT NULL,
  provenance text
    NOT NULL
    DEFAULT 'user_supplied'
    CONSTRAINT form_answer_provenance_check
    CHECK (provenance IN ('user_supplied', 'ai_drafted', 'source_verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_answer_unique UNIQUE (session_id, form_id, field_name)
);

CREATE INDEX form_answer_session_id_idx ON form_answer (session_id);
