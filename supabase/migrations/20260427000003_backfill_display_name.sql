-- 既存 generated_page に display_name を後付けで埋める
-- フォーマット: 【郵送買取】{franchise_ja} {page_label} ({page_index + 1}).png
--   page_label が NULL の場合は franchise_ja のみ
UPDATE generated_page
SET display_name = CONCAT(
  '【郵送買取】',
  CASE franchise
    WHEN 'Pokemon'   THEN 'ポケモン'
    WHEN 'ONE PIECE' THEN 'ワンピース'
    WHEN 'YU-GI-OH!' THEN '遊戯王'
    ELSE franchise
  END,
  CASE
    WHEN page_label IS NOT NULL AND length(page_label) > 0 THEN ' ' || page_label
    ELSE ''
  END,
  ' (', (page_index + 1)::text, ').png'
)
WHERE display_name IS NULL;
