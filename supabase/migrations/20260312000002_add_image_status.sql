-- image_url のヘルスチェック結果を保持するカラム
-- ok: 画像URL有効, dead: リンク切れ, null: 未チェック
ALTER TABLE db_card ADD COLUMN image_status TEXT;

CREATE INDEX idx_db_card_image_status ON db_card (image_status);
