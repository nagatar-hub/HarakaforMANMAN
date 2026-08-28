-- Same persisted values as saving 7% BOX shrink discounts in store settings.
-- Leave no_shrink, PSA, other stores, and all unrelated settings untouched.
BEGIN;
UPDATE public.store_config config
SET settings = jsonb_set(COALESCE(config.settings, '{}'::jsonb), '{box_discount_rates}',
    COALESCE(config.settings->'box_discount_rates', '{}'::jsonb) || (
      SELECT jsonb_object_agg(franchise,
        COALESCE(config.settings->'box_discount_rates'->franchise, '{}'::jsonb)
          || jsonb_build_object('shrink', 0.07))
      FROM unnest(ARRAY['Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL']) AS franchise
    )),
  updated_at = now()
WHERE config.store = 'manman';
COMMIT;
