-- db_card テーブル: Haraka DBシートのカード情報をSupabaseに同期
-- sync時にシート全行をupsertし、webappから編集→シート書き戻しを可能にする

CREATE TABLE db_card (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise TEXT NOT NULL,
  tag TEXT,
  card_name TEXT NOT NULL,
  grade TEXT,
  list_no TEXT,
  image_url TEXT,
  alt_image_url TEXT,
  rarity_icon TEXT,
  sheet_row_number INTEGER,  -- シートの行番号（セル更新用、ヘッダ=行1）
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- franchise + card_name + grade + list_no のユニーク制約（upsert用）
-- grade / list_no は NULL ではなく空文字でデフォルト格納（upsert対応）
ALTER TABLE db_card ALTER COLUMN grade SET DEFAULT '';
ALTER TABLE db_card ALTER COLUMN list_no SET DEFAULT '';

CREATE UNIQUE INDEX uix_db_card_identity
  ON db_card (franchise, card_name, grade, list_no);

CREATE INDEX idx_db_card_franchise ON db_card (franchise);
CREATE INDEX idx_db_card_tag ON db_card (tag);
