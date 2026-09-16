BEGIN;

-- Only independently verified, case-free product images belong in this table.
CREATE TABLE public.tokyo_card_image_mapping (
  source_shinsoku_id TEXT PRIMARY KEY CHECK (length(btrim(source_shinsoku_id)) BETWEEN 1 AND 200),
  franchise TEXT NOT NULL CHECK (franchise IN ('Pokemon','ONE PIECE','YU-GI-OH!','WEISS SCHWARZ','DRAGON BALL')),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  model_number TEXT NOT NULL CHECK (length(btrim(model_number)) BETWEEN 1 AND 200),
  provider TEXT NOT NULL CHECK (provider IN ('tcgmp','haraka','onphalos')),
  provider_product_id TEXT NOT NULL CHECK (length(btrim(provider_product_id)) BETWEEN 1 AND 200),
  CHECK (CASE WHEN provider = 'haraka' THEN provider_product_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ELSE provider_product_id ~ '^[0-9]{1,200}$' END),
  tcgmp_product_id TEXT CHECK (tcgmp_product_id ~ '^[0-9]{1,200}$'),
  tcgmp_sku TEXT CHECK (length(btrim(tcgmp_sku)) BETWEEN 1 AND 200),
  CHECK ((provider = 'tcgmp' AND tcgmp_product_id IS NOT NULL AND tcgmp_sku IS NOT NULL AND provider_product_id = tcgmp_product_id)
    OR (provider IN ('haraka','onphalos') AND tcgmp_product_id IS NULL AND tcgmp_sku IS NULL)),
  image_url TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  verified_at TIMESTAMPTZ NOT NULL CHECK (isfinite(verified_at)),
  evidence JSONB NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND
    evidence @> '{"no_sample":true,"no_slab":true,"variant_confirmed":true}'::jsonb AND
    evidence ? 'note' AND jsonb_typeof(evidence->'note') = 'string' AND length(btrim(evidence->>'note')) > 0
  ),
  CHECK (image_url IN (
    'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/' || provider || '/' || sha256 || '.jpg',
    'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/' || provider || '/' || sha256 || '.png',
    'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/' || provider || '/' || sha256 || '.webp'
  ))
);
ALTER TABLE public.tokyo_card_image_mapping ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokyo_card_image_mapping FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokyo_card_image_mapping TO service_role;

COMMIT;
