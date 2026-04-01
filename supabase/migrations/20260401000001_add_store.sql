-- store カラムを各テーブルに追加（Oripark/Manman分離）
ALTER TABLE run ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';
ALTER TABLE asset_profile ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';
ALTER TABLE rule ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

-- インデックス
CREATE INDEX IF NOT EXISTS idx_run_store ON run(store);
CREATE INDEX IF NOT EXISTS idx_asset_profile_store ON asset_profile(store, franchise);
CREATE INDEX IF NOT EXISTS idx_rule_store ON rule(store, franchise);

-- store_config テーブル（ストアごとの設定）
CREATE TABLE IF NOT EXISTS store_config (
  store TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- manman の初期設定（BOXシュリンク無: 15% OFF）
INSERT INTO store_config(store, settings)
VALUES ('manman', '{"box_shrink_discount_rate": 0.15}')
ON CONFLICT (store) DO NOTHING;
