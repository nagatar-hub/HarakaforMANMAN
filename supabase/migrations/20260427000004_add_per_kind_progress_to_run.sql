-- run テーブルに kind 別の完了タイムスタンプと進捗カラムを追加
-- 1 Run を 2 Task で共有し、各 Task が自分の kind 分だけ書き込む
ALTER TABLE run
  ADD COLUMN IF NOT EXISTS postal_done_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS store_done_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_postal_current INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_postal_total   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_postal_message TEXT,
  ADD COLUMN IF NOT EXISTS progress_store_current  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_store_total    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_store_message  TEXT;
-- 既存 Run のバックフィル（postal のみ生成されていた時代）
UPDATE run
SET postal_done_at = generate_done_at
WHERE generate_done_at IS NOT NULL
  AND postal_done_at IS NULL;
