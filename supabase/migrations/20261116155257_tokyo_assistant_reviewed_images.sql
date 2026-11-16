BEGIN;

-- A manually checked archive binds an unmodified asset to one exact source product.
-- The original supplier URL and review provenance remain in evidence. No DB-card FK
-- is inferred from another tenant's image, and existing provider contracts stay intact.
ALTER TABLE public.tokyo_card_image_mapping
  DROP CONSTRAINT tokyo_card_image_mapping_provider_check,
  ADD CONSTRAINT tokyo_card_image_mapping_provider_check
    CHECK (provider IN ('tcgmp','haraka','onphalos','cardrush','reviewed')),
  DROP CONSTRAINT tokyo_card_image_mapping_check,
  ADD CONSTRAINT tokyo_card_image_mapping_check CHECK (CASE
    WHEN provider = 'reviewed' THEN provider_product_id = source_shinsoku_id
    WHEN provider = 'haraka' THEN provider_product_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ELSE provider_product_id ~ '^[0-9]{1,200}$' END),
  DROP CONSTRAINT tokyo_card_image_mapping_check1,
  ADD CONSTRAINT tokyo_card_image_mapping_check1 CHECK (
    (provider = 'tcgmp' AND tcgmp_product_id IS NOT NULL AND tcgmp_sku IS NOT NULL AND provider_product_id = tcgmp_product_id)
    OR (provider IN ('haraka','onphalos','cardrush','reviewed') AND tcgmp_product_id IS NULL AND tcgmp_sku IS NULL)),
  DROP CONSTRAINT tokyo_card_image_mapping_provider_scope,
  ADD CONSTRAINT tokyo_card_image_mapping_provider_scope CHECK (
    provider IN ('haraka','cardrush','reviewed')
    OR (provider = 'onphalos' AND product_type = 'psa' AND franchise = 'Pokemon')
    OR (provider = 'tcgmp' AND product_type = 'psa')),
  ADD CONSTRAINT tokyo_card_image_mapping_assistant_evidence CHECK (provider <> 'reviewed' OR COALESCE(
    evidence @> '{"verified_by":"assistant","user_approved":false,"visual_identity_verified":true,"verification_method":"manual_visual"}'::jsonb
    AND evidence->>'reviewed_asset_sha256' = sha256
    AND evidence->>'review_manifest_sha256' ~ '^[0-9a-f]{64}$'
    AND evidence->>'source_url' ~ '^https://'
    AND length(btrim(evidence->>'identity_note')) > 0, false));

-- Existing exact SHA-bound Storage paths, model checks and service-role-only RLS/grants remain.
COMMIT;
