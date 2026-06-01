-- rarity_icon: レアリティアイコン（Supabase Storage 参照）
--
-- 従来は Google Sheets "RarityIcons" タブで Drive ID を管理していたが、
-- Drive 非依存化のため Supabase Storage に移行する。
-- franchise が NULL のレコードは全 franchise で参照される共通アイコン。
CREATE TABLE rarity_icon (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise     TEXT
                CHECK (franchise IS NULL OR franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  name          TEXT NOT NULL,                    -- "SAR", "SR", "UR", "25thゴールド" など
  storage_path  TEXT NOT NULL,                    -- 'rarity-icons/SAR.png'
  drive_id      TEXT,                             -- 互換用フォールバック
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
-- (franchise, name) の一意性。NULL 同士も重複扱いしたいため式インデックス。
CREATE UNIQUE INDEX idx_rarity_icon_franchise_name
  ON rarity_icon (COALESCE(franchise, ''), name);
CREATE INDEX idx_rarity_icon_name ON rarity_icon (name);
