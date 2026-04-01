-- prepared_card: 加工済みカードデータ
CREATE TABLE prepared_card (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES run(id),
  raw_import_id   UUID REFERENCES raw_import(id),
  franchise       TEXT NOT NULL,
  card_name       TEXT NOT NULL,
  grade           TEXT,
  list_no         TEXT,
  image_url       TEXT,
  alt_image_url   TEXT,
  rarity          TEXT,
  rarity_icon_url TEXT,
  tag             TEXT,
  price_high      NUMERIC,
  price_low       NUMERIC,
  image_status    TEXT DEFAULT 'unchecked',
  source          TEXT DEFAULT 'kecak',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_prepared_card_run ON prepared_card(run_id);
CREATE INDEX idx_prepared_card_franchise ON prepared_card(franchise);
