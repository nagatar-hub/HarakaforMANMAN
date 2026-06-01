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

-- manman の初期価格設定
INSERT INTO store_config(store, settings)
VALUES (
  'manman',
  '{
    "buy_price_high_discount_rate": 0.15,
    "box_discount_rates": { "shrink": 0, "no_shrink": 0.15 },
    "psa10_discount_rates": { "Pokemon": 0.12, "ONE PIECE": 0.12, "YU-GI-OH!": 0.15 }
  }'
)
ON CONFLICT (store) DO NOTHING;
