BEGIN;

-- WEISS SCHWARZ / DRAGON BALL use Peleka trekaman's fixed Pokemon range:
-- upper 94%, lower 87%, both floored to JPY 500. Keep the stored settings in
-- sync with that runtime contract without changing the existing franchises.
DO $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.store_config AS target
  SET settings = jsonb_set(
        jsonb_set(
          target.settings,
          '{psa10_discount_rates}',
          coalesce(target.settings -> 'psa10_discount_rates', '{}'::JSONB)
            || jsonb_build_object(
              'WEISS SCHWARZ', 0.06,
              'DRAGON BALL', 0.06
            ),
          TRUE
        ),
        '{box_discount_rates}',
        coalesce(target.settings -> 'box_discount_rates', '{}'::JSONB)
          || jsonb_build_object(
            'WEISS SCHWARZ', jsonb_build_object('shrink', 0.06, 'no_shrink', 0.13),
            'DRAGON BALL', jsonb_build_object('shrink', 0.06, 'no_shrink', 0.13)
          ),
        TRUE
      ),
      updated_at = now()
  WHERE target.store = 'manman';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Expected one MANMAN store_config row, updated %', v_updated;
  END IF;
END;
$$;

COMMIT;
