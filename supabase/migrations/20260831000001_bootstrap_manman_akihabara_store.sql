-- Copy Manman's current layout and price settings once; later changes stay store-specific.
DO $$
DECLARE
  source_profiles integer;
  source_layouts integer;
  source_configs integer;
BEGIN
  SELECT count(*) INTO source_profiles
  FROM public.asset_profile
  WHERE store = 'manman';

  SELECT count(*) INTO source_layouts
  FROM public.layout_template
  WHERE store = 'manman';

  SELECT count(*) INTO source_configs
  FROM public.store_config
  WHERE store = 'manman';

  IF source_profiles = 0 OR source_layouts = 0 OR source_configs <> 1 THEN
    RAISE EXCEPTION 'Manman layout and store config are required before bootstrapping Manman Akihabara';
  END IF;

  INSERT INTO public.asset_profile (
    store, franchise, template_image, card_back_image, grid_cols, grid_rows,
    total_slots, img_width, img_height, font_family, price_format, layout_config,
    rarity_icons, template_storage_path, card_back_storage_path,
    template_box_storage_path, card_back_box_storage_path
  )
  SELECT
    'manman-akihabara', franchise, template_image, card_back_image, grid_cols, grid_rows,
    total_slots, img_width, img_height, font_family, price_format, layout_config,
    rarity_icons, template_storage_path, card_back_storage_path,
    template_box_storage_path, card_back_box_storage_path
  FROM public.asset_profile
  WHERE store = 'manman'
  ON CONFLICT (store, franchise) DO NOTHING;

  INSERT INTO public.layout_template (
    store, franchise, name, slug, grid_cols, grid_rows, total_slots, img_width,
    img_height, template_storage_path, card_back_storage_path, layout_config,
    skip_price_low, is_default, is_active, priority, kind
  )
  SELECT
    'manman-akihabara', franchise, name, slug, grid_cols, grid_rows, total_slots,
    img_width, img_height, template_storage_path, card_back_storage_path,
    layout_config, skip_price_low, is_default, is_active, priority, kind
  FROM public.layout_template
  WHERE store = 'manman'
  ON CONFLICT (store, franchise, kind, slug) DO NOTHING;

  INSERT INTO public.store_config (store, settings)
  SELECT 'manman-akihabara', settings
  FROM public.store_config
  WHERE store = 'manman'
  ON CONFLICT (store) DO NOTHING;

  IF (SELECT count(*) FROM public.asset_profile WHERE store = 'manman-akihabara') < source_profiles
    OR (SELECT count(*) FROM public.layout_template WHERE store = 'manman-akihabara') < source_layouts
    OR NOT EXISTS (SELECT 1 FROM public.store_config WHERE store = 'manman-akihabara') THEN
    RAISE EXCEPTION 'Manman Akihabara layout bootstrap is incomplete';
  END IF;
END $$;
