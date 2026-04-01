CREATE TABLE run (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by      TEXT NOT NULL,
  status            TEXT DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
  total_imported    INT DEFAULT 0,
  total_prepared    INT DEFAULT 0,
  total_image_ng    INT DEFAULT 0,
  total_pages       INT DEFAULT 0,
  started_at        TIMESTAMPTZ DEFAULT now(),
  import_done_at    TIMESTAMPTZ,
  prepare_done_at   TIMESTAMPTZ,
  plan_done_at      TIMESTAMPTZ,
  generate_done_at  TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT
);

CREATE INDEX idx_run_status ON run(status);
CREATE INDEX idx_run_started_at ON run(started_at DESC);
