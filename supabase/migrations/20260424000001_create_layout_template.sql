-- layout_template: 買取表 1 ページ分のレイアウトテンプレート
--
-- franchise × 枠数（1/2/4/6/9/15/20/40 など）の組合せで複数登録される。
-- 画像生成時に、グループの枚数から最適な枠数の組合せを動的計画法で選び、
-- 「小さい枠に高価格カードを詰める」形で割り当てる。
CREATE TABLE layout_template (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store                    TEXT NOT NULL DEFAULT 'oripark',
  franchise                TEXT NOT NULL
                           CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  name                     TEXT NOT NULL,                    -- 表示名: "20枠 (5x4)" 等
  slug                     TEXT NOT NULL,                    -- "grid_5x4", "box_8x5" 等
  grid_cols                INT NOT NULL,
  grid_rows                INT NOT NULL,
  total_slots              INT NOT NULL,                     -- grid_cols * grid_rows
  img_width                INT NOT NULL DEFAULT 1240,
  img_height               INT NOT NULL DEFAULT 1760,
  template_storage_path    TEXT NOT NULL,                    -- 'templates/pokemon/20.png' 等
  card_back_storage_path   TEXT NOT NULL,                    -- 'card-backs/pokemon.png' 等
  layout_config            JSONB NOT NULL,                   -- startX, rows[], priceBox*, rarityIcon*, rowCardAdjust, rowPriceAdjust
  skip_price_low           BOOLEAN NOT NULL DEFAULT FALSE,   -- BOX テンプレで青字を抑止するためのフラグ
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,   -- どの枠数にも合わない場合のフォールバック
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  priority                 INT NOT NULL DEFAULT 0,           -- 同枠数候補が複数ある際の優先度（降順）
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store, franchise, slug)
);
CREATE INDEX idx_layout_template_lookup
  ON layout_template (store, franchise, is_active, total_slots);
-- デフォルトは franchise ごとに 1 件を想定
CREATE UNIQUE INDEX idx_layout_template_default
  ON layout_template (store, franchise)
  WHERE is_default = TRUE;
