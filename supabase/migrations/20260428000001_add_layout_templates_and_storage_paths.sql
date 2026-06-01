-- Supabase Storage based layout templates for MANMAN buylist images.
-- Keeps existing asset_profile rows usable while allowing page generation to
-- choose 1/2/4/6/8/9/15/20/40-slot templates from Storage.

CREATE TABLE IF NOT EXISTS layout_template (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store                    TEXT NOT NULL DEFAULT 'manman',
  franchise                TEXT NOT NULL
                           CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  kind                     TEXT NOT NULL DEFAULT 'store'
                           CHECK (kind IN ('postal', 'store')),
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  grid_cols                INT NOT NULL,
  grid_rows                INT NOT NULL,
  total_slots              INT NOT NULL,
  img_width                INT NOT NULL DEFAULT 1240,
  img_height               INT NOT NULL DEFAULT 1760,
  template_storage_path    TEXT NOT NULL,
  card_back_storage_path   TEXT NOT NULL,
  layout_config            JSONB NOT NULL,
  skip_price_low           BOOLEAN NOT NULL DEFAULT FALSE,
  is_default               BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  priority                 INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store, franchise, kind, slug)
);

CREATE INDEX IF NOT EXISTS idx_layout_template_lookup
  ON layout_template (store, franchise, kind, is_active, total_slots);

CREATE UNIQUE INDEX IF NOT EXISTS idx_layout_template_default
  ON layout_template (store, franchise, kind)
  WHERE is_default = TRUE;

ALTER TABLE asset_profile ADD COLUMN IF NOT EXISTS template_storage_path        TEXT;
ALTER TABLE asset_profile ADD COLUMN IF NOT EXISTS card_back_storage_path       TEXT;
ALTER TABLE asset_profile ADD COLUMN IF NOT EXISTS template_box_storage_path    TEXT;
ALTER TABLE asset_profile ADD COLUMN IF NOT EXISTS card_back_box_storage_path   TEXT;

ALTER TABLE generated_page ADD COLUMN IF NOT EXISTS layout_template_id UUID REFERENCES layout_template(id);
ALTER TABLE generated_page ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'store'
  CHECK (kind IN ('postal', 'store'));
ALTER TABLE generated_page ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_generated_page_layout_template
  ON generated_page(layout_template_id);
CREATE INDEX IF NOT EXISTS idx_generated_page_run_kind
  ON generated_page(run_id, kind);
