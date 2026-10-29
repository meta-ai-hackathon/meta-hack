-- Benefits Navigator data model v1 (BN-02 / HACK-27).
-- Migrations are numbered and append-only: never edit an applied file,
-- add a new numbered file instead.

-- Applied-migration tracking; the runner (src/lib/migrate.ts) creates this
-- table before applying files, so the CREATE must be IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person (id),
  caseworker_assisted boolean NOT NULL DEFAULT false,
  status text
    NOT NULL
    DEFAULT 'draft'
    CONSTRAINT session_status_check
    CHECK (status IN (
      'draft',
      'prepared',
      'handed_off',
      'user_reported_submitted',
      'user_reported_decided'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Who did what whenever a caseworker assists a session (BN-10).
CREATE TABLE session_audit_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES session (id),
  actor_role text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per question per session; status is the tri-state honesty spine
-- (known / unknown / unverified), provenance says where the value came from.
CREATE TABLE answer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES session (id),
  question_id text NOT NULL,
  value jsonb,
  status text
    NOT NULL
    CONSTRAINT answer_status_check
    CHECK (status IN ('known', 'unknown', 'unverified')),
  provenance text
    NOT NULL
    CONSTRAINT answer_provenance_check
    CHECK (provenance IN ('user_supplied', 'ai_drafted', 'source_verified')),
  answered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answer_session_question_unique UNIQUE (session_id, question_id)
);

CREATE INDEX session_person_id_idx ON session (person_id);
CREATE INDEX answer_session_id_idx ON answer (session_id);
CREATE INDEX session_audit_note_session_id_idx ON session_audit_note (session_id);
