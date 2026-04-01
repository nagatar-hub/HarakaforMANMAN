-- run テーブルに進捗トラッキング + sync 統合用カラムを追加
ALTER TABLE run
  ADD COLUMN progress_current INT DEFAULT 0,
  ADD COLUMN progress_total INT DEFAULT 0,
  ADD COLUMN progress_message TEXT,
  ADD COLUMN total_untagged INT DEFAULT 0,
  ADD COLUMN spectre_done_at TIMESTAMPTZ,
  ADD COLUMN health_check_done_at TIMESTAMPTZ;
