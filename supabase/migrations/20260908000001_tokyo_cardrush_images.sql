BEGIN;

-- Existing reviewed providers retain their non-null model identity contract.
ALTER TABLE public.tokyo_card_image_mapping
  ALTER COLUMN model_number DROP NOT NULL,
  DROP CONSTRAINT tokyo_card_image_mapping_provider_check,
  ADD CONSTRAINT tokyo_card_image_mapping_provider_check CHECK (provider IN ('tcgmp','haraka','onphalos','cardrush')),
  ADD CONSTRAINT tokyo_card_image_mapping_model_required CHECK (model_number IS NOT NULL OR provider = 'cardrush'),
  DROP CONSTRAINT tokyo_card_image_mapping_check1,
  ADD CONSTRAINT tokyo_card_image_mapping_check1 CHECK (
    (provider = 'tcgmp' AND tcgmp_product_id IS NOT NULL AND tcgmp_sku IS NOT NULL AND provider_product_id = tcgmp_product_id)
    OR (provider IN ('haraka','onphalos','cardrush') AND tcgmp_product_id IS NULL AND tcgmp_sku IS NULL)
  );
-- The existing provider-ID, SHA-bound Storage URL, evidence and RLS checks remain unchanged.

COMMIT;
