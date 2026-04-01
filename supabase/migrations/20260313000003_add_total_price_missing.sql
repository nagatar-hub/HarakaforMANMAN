-- run テーブルに価格未記入カウントを追加
ALTER TABLE run
  ADD COLUMN total_price_missing INT DEFAULT 0;
