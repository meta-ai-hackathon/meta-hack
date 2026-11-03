-- Income-capture milestone (VAL-INC-007): the tax-return confirm flow
-- writes confirmed proposals with provenance `tax_return` and
-- person-corrected values with provenance `user`. Both extend the answer
-- table's provenance vocabulary; every existing value stays valid and
-- every pre-existing write path is unchanged.

ALTER TABLE answer DROP CONSTRAINT answer_provenance_check;

ALTER TABLE answer
  ADD CONSTRAINT answer_provenance_check
  CHECK (provenance IN (
    'user_supplied',
    'ai_drafted',
    'source_verified',
    'tax_return',
    'user'
  ));
