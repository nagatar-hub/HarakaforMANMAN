-- generated_page: ページ割付 + 画像生成結果
CREATE TABLE generated_page (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES run(id),
  franchise     TEXT NOT NULL,
  page_index    INT NOT NULL,
  page_label    TEXT,
  card_ids      UUID[] NOT NULL,
  image_key     TEXT,
  image_url     TEXT,
  status        TEXT DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_generated_page_run ON generated_page(run_id);
