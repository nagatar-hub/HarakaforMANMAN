-- Add Weiss Schwarz and Dragon Ball to the normal order-list/generation path.
-- Custom buyback remains a separate three-franchise feature.

ALTER TABLE public.rule
  DROP CONSTRAINT IF EXISTS rule_franchise_check;
ALTER TABLE public.rule
  ADD CONSTRAINT rule_franchise_check
  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

ALTER TABLE public.asset_profile
  DROP CONSTRAINT IF EXISTS asset_profile_franchise_check;
ALTER TABLE public.asset_profile
  ADD CONSTRAINT asset_profile_franchise_check
  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

ALTER TABLE public.layout_template
  DROP CONSTRAINT IF EXISTS layout_template_franchise_check;
ALTER TABLE public.layout_template
  ADD CONSTRAINT layout_template_franchise_check
  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

ALTER TABLE public.rarity_icon
  DROP CONSTRAINT IF EXISTS rarity_icon_franchise_check;
ALTER TABLE public.rarity_icon
  ADD CONSTRAINT rarity_icon_franchise_check
  CHECK (franchise IS NULL OR franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS excel_product_mapping_franchise_check;
ALTER TABLE public.excel_product_mapping
  ADD CONSTRAINT excel_product_mapping_franchise_check
  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

ALTER TABLE public.order_list_item
  DROP CONSTRAINT IF EXISTS order_list_item_franchise_check;
ALTER TABLE public.order_list_item
  ADD CONSTRAINT order_list_item_franchise_check
  CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL'));

-- Start the new Oripark rates from its current Pokemon discount rate.
-- Existing explicit values win so reruns never overwrite an operator choice.
UPDATE public.store_config AS target
SET settings = jsonb_set(
      target.settings,
      '{buy_price_high_discount_rates}',
      jsonb_build_object(
        'WEISS SCHWARZ', coalesce(
          target.settings #> '{buy_price_high_discount_rates,Pokemon}',
          '0.04'::JSONB
        ),
        'DRAGON BALL', coalesce(
          target.settings #> '{buy_price_high_discount_rates,Pokemon}',
          '0.04'::JSONB
        )
      ) || coalesce(
        target.settings -> 'buy_price_high_discount_rates',
        '{}'::JSONB
      ),
      TRUE
    ),
    updated_at = now()
WHERE target.store = 'oripark';

-- MANMAN keeps separate PSA10 and BOX condition rates. Copy its current
-- Pokemon objects instead of inventing another default for the new products.
UPDATE public.store_config AS target
SET settings = jsonb_set(
      jsonb_set(
        target.settings,
        '{psa10_discount_rates}',
        jsonb_build_object(
          'WEISS SCHWARZ', coalesce(
            target.settings #> '{psa10_discount_rates,Pokemon}',
            '0.12'::JSONB
          ),
          'DRAGON BALL', coalesce(
            target.settings #> '{psa10_discount_rates,Pokemon}',
            '0.12'::JSONB
          )
        ) || coalesce(target.settings -> 'psa10_discount_rates', '{}'::JSONB),
        TRUE
      ),
      '{box_discount_rates}',
      jsonb_build_object(
        'WEISS SCHWARZ', coalesce(
          target.settings #> '{box_discount_rates,Pokemon}',
          jsonb_build_object(
            'shrink', coalesce(target.settings #> '{box_discount_rates,shrink}', '0'::JSONB),
            'no_shrink', coalesce(target.settings #> '{box_discount_rates,no_shrink}', '0.15'::JSONB)
          )
        ),
        'DRAGON BALL', coalesce(
          target.settings #> '{box_discount_rates,Pokemon}',
          jsonb_build_object(
            'shrink', coalesce(target.settings #> '{box_discount_rates,shrink}', '0'::JSONB),
            'no_shrink', coalesce(target.settings #> '{box_discount_rates,no_shrink}', '0.15'::JSONB)
          )
        )
      ) || coalesce(target.settings -> 'box_discount_rates', '{}'::JSONB),
      TRUE
    ),
    updated_at = now()
WHERE target.store = 'manman';

-- BOX rows use the existing BOX-isolation path. Keep these rows idempotent so
-- applying the same forward migration to the shared Oripark/MANMAN DB is safe.
INSERT INTO public.rule (
  store, franchise, tag_pattern, match_type, behavior, priority, notes
)
SELECT
  store, franchise, 'BOX', 'exact', 'isolate', 90,
  '新商材のBOXページ分離'
FROM (VALUES
  ('oripark', 'WEISS SCHWARZ'),
  ('oripark', 'DRAGON BALL'),
  ('manman', 'WEISS SCHWARZ'),
  ('manman', 'DRAGON BALL')
) AS source(store, franchise)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.rule AS existing
  WHERE existing.store = source.store
    AND existing.franchise = source.franchise
    AND existing.tag_pattern = 'BOX'
    AND existing.match_type = 'exact'
    AND existing.behavior = 'isolate'
);

CREATE OR REPLACE FUNCTION public.refresh_order_list_import_review_counts(
  p_import_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.order_list_import WHERE id = p_import_id
  ) THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;

  WITH per_franchise AS (
    SELECT
      franchise,
      count(*)::INT AS total,
      count(*) FILTER (WHERE match_status = 'matched')::INT AS matched,
      count(*) FILTER (WHERE match_status = 'ambiguous')::INT AS ambiguous,
      count(*) FILTER (WHERE match_status = 'unmatched')::INT AS unmatched,
      count(*) FILTER (WHERE match_status = 'excluded')::INT AS excluded,
      count(*) FILTER (WHERE match_status = 'invalid')::INT AS invalid
    FROM public.order_list_item
    WHERE import_id = p_import_id
    GROUP BY franchise
  ), aggregate_counts AS (
    SELECT
      coalesce(sum(total), 0)::INT AS total,
      coalesce(sum(matched), 0)::INT AS matched,
      coalesce(sum(ambiguous), 0)::INT AS ambiguous,
      coalesce(sum(unmatched), 0)::INT AS unmatched,
      coalesce(sum(excluded), 0)::INT AS excluded,
      coalesce(sum(invalid), 0)::INT AS invalid,
      jsonb_build_object(
        'Pokemon', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'ONE PIECE', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'YU-GI-OH!', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'WEISS SCHWARZ', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'DRAGON BALL', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0)
      ) || coalesce(jsonb_object_agg(
        franchise,
        jsonb_build_object(
          'total', total, 'matched', matched, 'ambiguous', ambiguous,
          'unmatched', unmatched, 'excluded', excluded, 'invalid', invalid
        )
      ), '{}'::JSONB) AS sheet_counts
    FROM per_franchise
  ), updated AS (
    UPDATE public.order_list_import AS target
    SET sheet_counts = counts.sheet_counts,
        total_rows = counts.total,
        matched_rows = counts.matched,
        ambiguous_rows = counts.ambiguous,
        unmatched_rows = counts.unmatched,
        excluded_rows = counts.excluded,
        invalid_rows = counts.invalid,
        valid_rows = counts.matched + counts.ambiguous + counts.unmatched + counts.excluded,
        updated_at = v_now
    FROM aggregate_counts AS counts
    WHERE target.id = p_import_id
    RETURNING counts.*
  )
  SELECT jsonb_build_object(
    'total', total, 'matched', matched, 'ambiguous', ambiguous,
    'unmatched', unmatched, 'excluded', excluded, 'invalid', invalid
  )
  INTO v_result
  FROM updated;

  RETURN coalesce(v_result, jsonb_build_object(
    'total', 0, 'matched', 0, 'ambiguous', 0,
    'unmatched', 0, 'excluded', 0, 'invalid', 0
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_order_list_import_review_counts(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_order_list_import_review_counts(UUID)
  TO service_role;

WITH defaults AS (
  SELECT jsonb_build_object(
    'Pokemon', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
    'ONE PIECE', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
    'YU-GI-OH!', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
    'WEISS SCHWARZ', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
    'DRAGON BALL', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0)
  ) AS value
)
UPDATE public.order_list_import AS target
SET sheet_counts = defaults.value || coalesce(target.sheet_counts, '{}'::JSONB),
    updated_at = target.updated_at
FROM defaults;
