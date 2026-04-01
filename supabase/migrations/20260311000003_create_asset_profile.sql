CREATE TABLE asset_profile (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise       TEXT UNIQUE NOT NULL
                  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  template_image  TEXT,
  card_back_image TEXT,
  grid_cols       INT DEFAULT 8,
  grid_rows       INT DEFAULT 5,
  total_slots     INT DEFAULT 40,
  img_width       INT DEFAULT 1240,
  img_height      INT DEFAULT 1760,
  font_family     TEXT DEFAULT 'Special Gothic Condensed One',
  price_format    TEXT DEFAULT '¥{price}',
  layout_config   JSONB,
  rarity_icons    JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);
