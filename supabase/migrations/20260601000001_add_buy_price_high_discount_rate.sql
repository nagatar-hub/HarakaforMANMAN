-- store_config の旧キーから買取上限減額率キーへ値を移行
UPDATE store_config
SET
  settings = settings || jsonb_build_object(
    'buy_price_high_discount_rate',
    COALESCE(settings->'buy_price_high_discount_rate', settings->'box_shrink_discount_rate', '0.15'::jsonb)
  ),
  updated_at = NOW()
WHERE NOT settings ? 'buy_price_high_discount_rate';

UPDATE store_config
SET settings = settings - 'box_shrink_discount_rate'
WHERE settings ? 'box_shrink_discount_rate';
