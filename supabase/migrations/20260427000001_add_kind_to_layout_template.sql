-- layout_template に kind 列を追加し、UNIQUE 制約と検索 index を kind 込みに更新する
ALTER TABLE layout_template
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'postal'
    CHECK (kind IN ('postal', 'store'));
-- 既存 UNIQUE (store, franchise, slug) を破棄し、kind 込みで作り直す
ALTER TABLE layout_template
  DROP CONSTRAINT IF EXISTS layout_template_store_franchise_slug_key;
ALTER TABLE layout_template
  DROP CONSTRAINT IF EXISTS layout_template_store_franchise_kind_slug_key;
ALTER TABLE layout_template
  ADD CONSTRAINT layout_template_store_franchise_kind_slug_key
    UNIQUE (store, franchise, kind, slug);
-- ルックアップ index を再作成
DROP INDEX IF EXISTS idx_layout_template_lookup;
CREATE INDEX idx_layout_template_lookup
  ON layout_template (store, franchise, kind, is_active, total_slots);
-- デフォルトは (store, franchise, kind) ごとに 1 件
DROP INDEX IF EXISTS idx_layout_template_default;
CREATE UNIQUE INDEX idx_layout_template_default
  ON layout_template (store, franchise, kind)
  WHERE is_default = TRUE;
