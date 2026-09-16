BEGIN;

ALTER TABLE public.tokyo_card_image_mapping
  ADD COLUMN product_type TEXT NOT NULL DEFAULT 'psa'
    CHECK (product_type IN ('psa','box'));

ALTER TABLE public.tokyo_card_image_mapping
  DROP CONSTRAINT tokyo_card_image_mapping_model_required,
  ADD CONSTRAINT tokyo_card_image_mapping_model_required CHECK (
    (product_type = 'box' AND model_number IS NULL)
    OR (product_type = 'psa' AND (model_number IS NOT NULL
      OR (provider = 'cardrush' AND franchise = 'YU-GI-OH!')
      OR (provider = 'cardrush'
        AND evidence @> '{"source_sha256_equal":true}'::jsonb
        AND evidence->>'source_image_sha256' = sha256)
      OR (provider = 'onphalos' AND franchise = 'Pokemon'
        AND evidence @> '{"pixel_exact":true}'::jsonb
        AND evidence->>'source_image_sha256' = sha256)))
  ),
  ADD CONSTRAINT tokyo_card_image_mapping_provider_scope CHECK (
    provider = 'haraka'
    OR provider = 'cardrush'
    OR (provider = 'onphalos' AND product_type = 'psa' AND franchise = 'Pokemon')
    OR (provider = 'tcgmp' AND product_type = 'psa')
  ),
  ALTER COLUMN product_type DROP DEFAULT;

COMMIT;
