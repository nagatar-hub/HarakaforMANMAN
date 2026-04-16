-- カードサイズ縮小: 黄色ラベルへの被りと左右トリミングを解消
--
-- テンプレート: 1240px幅, 6列, colWidth=206
--
-- YU-GI-OH!:  cardWidth 175→130, cardHeight 245→190 (黄色ラベルに被っていたため大幅縮小)
-- Pokemon:    cardWidth 175→150, cardHeight 245→210 (左右トリミング解消)
-- ONE PIECE:  cardWidth 175→150, cardHeight 245→210 (Pokemon と同一)
--
-- startX/priceStartX を列中央に配置: (206 - cardWidth) / 2
-- priceBoxWidth をカード幅に合わせて縮小

-- YU-GI-OH!: startX = (206-130)/2 = 38
UPDATE asset_profile
SET layout_config = layout_config || '{
  "cardWidth": 130,
  "cardHeight": 190,
  "startX": 38,
  "priceStartX": 38,
  "priceBoxWidth": 130
}'::jsonb
WHERE store = 'manman' AND franchise = 'YU-GI-OH!';

-- Pokemon: startX = (206-150)/2 = 28
UPDATE asset_profile
SET layout_config = layout_config || '{
  "cardWidth": 150,
  "cardHeight": 210,
  "startX": 28,
  "priceStartX": 28,
  "priceBoxWidth": 150
}'::jsonb
WHERE store = 'manman' AND franchise = 'Pokemon';

-- ONE PIECE: Pokemon と同一値
UPDATE asset_profile
SET layout_config = layout_config || '{
  "cardWidth": 150,
  "cardHeight": 210,
  "startX": 28,
  "priceStartX": 28,
  "priceBoxWidth": 150
}'::jsonb
WHERE store = 'manman' AND franchise = 'ONE PIECE';
