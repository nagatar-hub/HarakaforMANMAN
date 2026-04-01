-- ============================================================
-- seed.sql
-- 初期データ: rule + asset_profile (3商材)
-- layout_config の座標値は Sheet-Layout シートから取得
-- ============================================================

-- ------------------------------------------------------------
-- rule: Pokemon
-- ------------------------------------------------------------
INSERT INTO rule (franchise, tag_pattern, match_type, behavior, priority, notes) VALUES
  ('Pokemon', 'TOP',       'exact',    'isolate', 100, 'TOPページ用'),
  ('Pokemon', 'BOX',       'exact',    'isolate',  90, 'BOXページ用'),
  ('Pokemon', 'ピカチュウ', 'contains', 'isolate',  80, 'ピカチュウ関連カード'),
  ('Pokemon', 'イーブイ',   'contains', 'isolate',  80, 'イーブイ関連カード'),
  ('Pokemon', 'リザードン', 'contains', 'isolate',  80, 'リザードン関連カード'),
  ('Pokemon', 'サポート',   'exact',    'isolate',  70, 'サポートカード');

-- ------------------------------------------------------------
-- rule: YU-GI-OH!
-- ------------------------------------------------------------
INSERT INTO rule (franchise, tag_pattern, match_type, behavior, priority, notes) VALUES
  ('YU-GI-OH!', '青眼',             'contains', 'isolate', 80, '青眼の白龍関連'),
  ('YU-GI-OH!', 'ブラックマジシャン', 'contains', 'isolate', 80, 'ブラックマジシャン関連');

-- ------------------------------------------------------------
-- asset_profile: YU-GI-OH!
-- Sheet-Layout 列順: YU-GI-OH!(B列), Pokemon(C列), ONE PIECE(D列)
--
-- YU-GI-OH! 実座標値:
--   startX=20, priceStartX=12, colWidth=154, cardWidth=115, cardHeight=170
--   isSmallCard=true
--   row1: cardY=332,  priceHighY=505,  priceLowY=530
--   row2: cardY=573,  priceHighY=747,  priceLowY=772
--   row3: cardY=824,  priceHighY=995,  priceLowY=1020
--   row4: cardY=1069, priceHighY=1240, priceLowY=1265
--   row5: cardY=1315, priceHighY=1485, priceLowY=1510
--   priceBoxWidth=140, priceBoxHeight=30
--   dateX=900, dateY=1650
--   rarityIconOffsetX=5, rarityIconOffsetY=-10, rarityIconWidth=60, rarityIconHeight=60
-- ------------------------------------------------------------
INSERT INTO asset_profile (
  franchise,
  template_image,
  card_back_image,
  grid_cols,
  grid_rows,
  total_slots,
  img_width,
  img_height,
  font_family,
  price_format,
  layout_config,
  rarity_icons
) VALUES (
  'YU-GI-OH!',
  '1oh4fBIluEXOq1Lwa-GPDAtX7-wR_py2Y',  -- templateFileId (通常)
  '1GsMUHKPhqFBsZpnLvf5Wwgu18cuC4iC6',  -- cardBackId
  8,
  5,
  40,
  1240,
  1760,
  'Special Gothic Condensed One',
  '¥{price}',
  '{
    "startX": 20,
    "priceStartX": 12,
    "colWidth": 154,
    "cardWidth": 115,
    "cardHeight": 170,
    "isSmallCard": true,
    "rows": [
      { "row": 1, "cardY": 332,  "priceHighY": 505,  "priceLowY": 530  },
      { "row": 2, "cardY": 573,  "priceHighY": 747,  "priceLowY": 772  },
      { "row": 3, "cardY": 824,  "priceHighY": 995,  "priceLowY": 1020 },
      { "row": 4, "cardY": 1069, "priceHighY": 1240, "priceLowY": 1265 },
      { "row": 5, "cardY": 1315, "priceHighY": 1485, "priceLowY": 1510 }
    ],
    "priceBoxWidth": 140,
    "priceBoxHeight": 30,
    "dateX": 900,
    "dateY": 1650,
    "rarityIconOffsetX": 5,
    "rarityIconOffsetY": -10,
    "rarityIconWidth": 60,
    "rarityIconHeight": 60,
    "templateFileId": "1oh4fBIluEXOq1Lwa-GPDAtX7-wR_py2Y",
    "templateFileId_BOX": "1HluD6-qq5NpACrBM2wUTS3QScV2rPhHY",
    "cardBackId": "1GsMUHKPhqFBsZpnLvf5Wwgu18cuC4iC6",
    "cardBackId_BOX": "1GsMUHKPhqFBsZpnLvf5Wwgu18cuC4iC6",
    "outputFolderId": "1Qvo6bKkCILHis3EpmsU6VOdm1HVl_4OU"
  }'::jsonb,
  NULL
);

-- ------------------------------------------------------------
-- asset_profile: Pokemon
-- Pokemon 実座標値:
--   startX=22, priceStartX=12, colWidth=154, cardWidth=118, cardHeight=170
--   isSmallCard=false
--   row1: cardY=341,  priceHighY=502,  priceLowY=530
--   row2: cardY=587,  priceHighY=747,  priceLowY=772
--   row3: cardY=833,  priceHighY=995,  priceLowY=1020
--   row4: cardY=1078, priceHighY=1237, priceLowY=1265
--   row5: cardY=1325, priceHighY=1485, priceLowY=1510
--   priceBoxWidth=140, priceBoxHeight=30
--   dateX=900, dateY=1650
--   rarityIconOffsetX=null, rarityIconOffsetY=null (Pokemon列はNULL)
-- ------------------------------------------------------------
INSERT INTO asset_profile (
  franchise,
  template_image,
  card_back_image,
  grid_cols,
  grid_rows,
  total_slots,
  img_width,
  img_height,
  font_family,
  price_format,
  layout_config,
  rarity_icons
) VALUES (
  'Pokemon',
  '15Nka2tBZbZUAN-MbU_HHaHJGdnuMsqgh',  -- templateFileId (通常)
  '1uqVpeM-tU1e0CMowCzysrRcPU7PxVOX-',  -- cardBackId
  8,
  5,
  40,
  1240,
  1760,
  'Special Gothic Condensed One',
  '¥{price}',
  '{
    "startX": 22,
    "priceStartX": 12,
    "colWidth": 154,
    "cardWidth": 118,
    "cardHeight": 170,
    "isSmallCard": false,
    "rows": [
      { "row": 1, "cardY": 341,  "priceHighY": 502,  "priceLowY": 530  },
      { "row": 2, "cardY": 587,  "priceHighY": 747,  "priceLowY": 772  },
      { "row": 3, "cardY": 833,  "priceHighY": 995,  "priceLowY": 1020 },
      { "row": 4, "cardY": 1078, "priceHighY": 1237, "priceLowY": 1265 },
      { "row": 5, "cardY": 1325, "priceHighY": 1485, "priceLowY": 1510 }
    ],
    "priceBoxWidth": 140,
    "priceBoxHeight": 30,
    "dateX": 900,
    "dateY": 1650,
    "rarityIconOffsetX": null,
    "rarityIconOffsetY": null,
    "rarityIconWidth": null,
    "rarityIconHeight": null,
    "templateFileId": "15Nka2tBZbZUAN-MbU_HHaHJGdnuMsqgh",
    "templateFileId_BOX": "1SSg0EX3l0wuXzk5ackWTvE6z1-QuiOX6",
    "cardBackId": "1uqVpeM-tU1e0CMowCzysrRcPU7PxVOX-",
    "cardBackId_BOX": "1uqVpeM-tU1e0CMowCzysrRcPU7PxVOX-",
    "outputFolderId": "1Qvo6bKkCILHis3EpmsU6VOdm1HVl_4OU"
  }'::jsonb,
  NULL
);

-- ------------------------------------------------------------
-- asset_profile: ONE PIECE
-- ONE PIECE 実座標値:
--   startX=22, priceStartX=12, colWidth=154, cardWidth=118, cardHeight=170
--   isSmallCard=false
--   row1: cardY=341,  priceHighY=502,  priceLowY=530
--   row2: cardY=587,  priceHighY=747,  priceLowY=772
--   row3: cardY=833,  priceHighY=995,  priceLowY=1020
--   row4: cardY=1078, priceHighY=1237, priceLowY=1265
--   row5: cardY=1325, priceHighY=1485, priceLowY=1510
--   priceBoxWidth=140, priceBoxHeight=30
--   dateX=900, dateY=1650
--   rarityIconOffsetX=null, rarityIconOffsetY=null (ONE PIECE列はNULL)
-- ------------------------------------------------------------
INSERT INTO asset_profile (
  franchise,
  template_image,
  card_back_image,
  grid_cols,
  grid_rows,
  total_slots,
  img_width,
  img_height,
  font_family,
  price_format,
  layout_config,
  rarity_icons
) VALUES (
  'ONE PIECE',
  '14sUuUeejGOJH3uoJdaCvZfZ2JA2bS5z9',  -- templateFileId (通常)
  '1zijQnEvCMmiXtJyKdE1aoXJ3DrDsAI1l',  -- cardBackId
  8,
  5,
  40,
  1240,
  1760,
  'Special Gothic Condensed One',
  '¥{price}',
  '{
    "startX": 22,
    "priceStartX": 12,
    "colWidth": 154,
    "cardWidth": 118,
    "cardHeight": 170,
    "isSmallCard": false,
    "rows": [
      { "row": 1, "cardY": 341,  "priceHighY": 502,  "priceLowY": 530  },
      { "row": 2, "cardY": 587,  "priceHighY": 747,  "priceLowY": 772  },
      { "row": 3, "cardY": 833,  "priceHighY": 995,  "priceLowY": 1020 },
      { "row": 4, "cardY": 1078, "priceHighY": 1237, "priceLowY": 1265 },
      { "row": 5, "cardY": 1325, "priceHighY": 1485, "priceLowY": 1510 }
    ],
    "priceBoxWidth": 140,
    "priceBoxHeight": 30,
    "dateX": 900,
    "dateY": 1650,
    "rarityIconOffsetX": null,
    "rarityIconOffsetY": null,
    "rarityIconWidth": null,
    "rarityIconHeight": null,
    "templateFileId": "14sUuUeejGOJH3uoJdaCvZfZ2JA2bS5z9",
    "templateFileId_BOX": "1moISdwZjCpJxfjR2TdLCGhG5cvIpfs2K",
    "cardBackId": "1zijQnEvCMmiXtJyKdE1aoXJ3DrDsAI1l",
    "cardBackId_BOX": "1zijQnEvCMmiXtJyKdE1aoXJ3DrDsAI1l",
    "outputFolderId": "1Qvo6bKkCILHis3EpmsU6VOdm1HVl_4OU"
  }'::jsonb,
  NULL
);
