-- raw_import: KECAK 生データ
CREATE TABLE raw_import (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES run(id),
  franchise   TEXT NOT NULL,
  card_name   TEXT NOT NULL,
  grade       TEXT,
  list_no     TEXT,
  image_url   TEXT,
  rarity      TEXT,
  demand      INT,
  kecak_price NUMERIC,
  raw_row     JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_raw_import_run ON raw_import(run_id);
