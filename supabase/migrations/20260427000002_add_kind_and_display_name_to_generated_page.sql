-- generated_page に kind と display_name 列を追加
ALTER TABLE generated_page
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'postal'
    CHECK (kind IN ('postal', 'store'));
ALTER TABLE generated_page
  ADD COLUMN IF NOT EXISTS display_name TEXT;
CREATE INDEX IF NOT EXISTS idx_generated_page_run_kind
  ON generated_page (run_id, kind);
