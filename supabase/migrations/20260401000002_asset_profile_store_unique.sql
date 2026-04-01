-- asset_profile の UNIQUE 制約を franchise 単体から (store, franchise) に変更
-- これにより oripark/manman で同一 franchise の asset_profile を保持できる

-- 既存の unique 制約を削除
ALTER TABLE asset_profile DROP CONSTRAINT IF EXISTS asset_profile_franchise_key;

-- (store, franchise) の複合 unique 制約を追加
ALTER TABLE asset_profile ADD CONSTRAINT asset_profile_store_franchise_key UNIQUE (store, franchise);

-- manman 用 asset_profile プレースホルダー（layout_config は measure-template.ts 実行後に更新）
-- template_image: PSAテンプレートの Google Drive File ID
-- layout_config.templateFileId_BOX: BOXテンプレートの Google Drive File ID
INSERT INTO asset_profile (store, franchise, template_image, card_back_image, grid_cols, grid_rows, total_slots, layout_config)
VALUES
  ('manman', 'Pokemon', '17ge8lvza4QAJFvRnGDwwxnkgG5Oh0uqn', NULL, 6, 5, 30,
   '{"templateFileId_BOX": "1ZiS1Xci3Dlc5i9SJrYoEEUUwiRuCzjZk", "startX": 0, "priceStartX": 0, "colWidth": 206, "cardWidth": 175, "cardHeight": 245, "isSmallCard": false, "rows": [], "priceBoxWidth": 175, "priceBoxHeight": 40, "dateX": 50, "dateY": 30}'
  ),
  ('manman', 'ONE PIECE', '1CCoIwtWbPU3l9A2Na5gzUzaCrllfn8Mu', NULL, 6, 5, 30,
   '{"templateFileId_BOX": "1RiAdjVUyDhpJyb8YxmZsZdSh6PxxEeHy", "startX": 0, "priceStartX": 0, "colWidth": 206, "cardWidth": 175, "cardHeight": 245, "isSmallCard": false, "rows": [], "priceBoxWidth": 175, "priceBoxHeight": 40, "dateX": 50, "dateY": 30}'
  ),
  ('manman', 'YU-GI-OH!', '1BEPSikO6dc6sXocrFQb-ZoPKZCRONGdk', NULL, 6, 5, 30,
   '{"templateFileId_BOX": "1uhJt5rFJyZgOX9wMvl4vLAckotKpmC_n", "startX": 0, "priceStartX": 0, "colWidth": 206, "cardWidth": 175, "cardHeight": 245, "isSmallCard": false, "rows": [], "priceBoxWidth": 175, "priceBoxHeight": 40, "dateX": 50, "dateY": 30}'
  )
ON CONFLICT (store, franchise) DO NOTHING;

-- NOTE: layout_config.rows は measure-template.ts を実行して取得した値で更新すること
-- 例:
-- UPDATE asset_profile
-- SET layout_config = layout_config || '{"rows": [{"cardY":300,"priceHighY":560,"priceLowY":600}, ...]}'::jsonb
-- WHERE store = 'manman' AND franchise = 'Pokemon';
