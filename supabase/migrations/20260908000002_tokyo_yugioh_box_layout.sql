BEGIN;
DO $$
DECLARE p public.asset_profile%ROWTYPE; cfg JSONB; width_box INT; height_box INT;
BEGIN
  SELECT * INTO STRICT p FROM public.asset_profile WHERE store='manman-akihabara' AND franchise='YU-GI-OH!';
  IF p.grid_cols <> 6 OR p.grid_rows <> 5 OR p.total_slots <> 30
    OR p.img_width <> 1240 OR p.img_height <> 1760 OR jsonb_array_length(p.layout_config->'rowsBOX') IS DISTINCT FROM 5
    OR (p.layout_config->>'cardWidth')::INT IS DISTINCT FROM 148
    OR (p.layout_config->>'cardHeight')::INT IS DISTINCT FROM 212 THEN
    RAISE EXCEPTION 'Unexpected Tokyo Yu BOX base geometry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='haraka-images' AND name='templates/manman-akihabara/box/yugioh-30.png')
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='haraka-images' AND name='card-backs/manman/yugioh.png') THEN
    RAISE EXCEPTION 'Upload and verify existing Yu BOX assets before applying this configuration';
  END IF;
  -- Same transformation as makeBoxLayout; do not reuse PSA grid geometry.
  width_box := least((p.layout_config->>'priceBoxWidth')::INT, round((p.layout_config->>'cardWidth')::NUMERIC * 0.9)::INT);
  height_box := round((p.layout_config->>'cardHeight')::NUMERIC * 0.88)::INT;
  cfg := (p.layout_config - 'rarityIconWidth' - 'rarityIconHeight') || jsonb_build_object(
    'rows',(SELECT jsonb_agg(r || jsonb_build_object('cardY',(r->>'priceHighY')::INT-height_box-14) ORDER BY n)
      FROM jsonb_array_elements(p.layout_config->'rowsBOX') WITH ORDINALITY x(r,n)),
    'startX',(p.layout_config->>'startX')::INT+round(((p.layout_config->>'cardWidth')::NUMERIC-width_box)/2)::INT,
    'cardWidth',width_box,'cardHeight',height_box,'cardFit','contain',
    'layoutAdjust',jsonb_build_object('cardYDelta',0,'priceYDelta',-16));
  IF EXISTS (SELECT 1 FROM public.layout_template WHERE store='manman-akihabara' AND franchise='YU-GI-OH!' AND kind='store' AND slug='box_30') THEN
    RAISE EXCEPTION 'Tokyo Yu box_30 already exists; inspect before retry';
  END IF;
  INSERT INTO public.layout_template (store,franchise,kind,name,slug,grid_cols,grid_rows,total_slots,img_width,img_height,
    template_storage_path,card_back_storage_path,layout_config,skip_price_low,is_default,is_active,priority)
  VALUES ('manman-akihabara','YU-GI-OH!','store','BOX 30枠 (6x5)','box_30',6,5,30,1240,1760,
    'templates/manman-akihabara/box/yugioh-30.png','card-backs/manman/yugioh.png',cfg,true,false,true,0);
END $$;
COMMIT;
