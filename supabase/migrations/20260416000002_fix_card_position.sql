-- カード位置修正: 右寄りすぎ問題の解消 + YU-GI-OH! サイズ微調整
--
-- ポケモン/ワンピース: サイズはそのまま、startX を左にシフト
-- YU-GI-OH!: 小さすぎたので少し拡大 + startX を左にシフト

-- YU-GI-OH!: cardWidth 130→148, cardHeight 190→212, startX 38→15
UPDATE asset_profile
SET layout_config = layout_config || '{
  "cardWidth": 148,
  "cardHeight": 212,
  "startX": 15,
  "priceStartX": 8,
  "priceBoxWidth": 155
}'::jsonb
WHERE store = 'manman' AND franchise = 'YU-GI-OH!';

-- Pokemon: startX 28→15
UPDATE asset_profile
SET layout_config = layout_config || '{
  "startX": 15,
  "priceStartX": 8
}'::jsonb
WHERE store = 'manman' AND franchise = 'Pokemon';

-- ONE PIECE: Pokemon と同一
UPDATE asset_profile
SET layout_config = layout_config || '{
  "startX": 15,
  "priceStartX": 8
}'::jsonb
WHERE store = 'manman' AND franchise = 'ONE PIECE';
