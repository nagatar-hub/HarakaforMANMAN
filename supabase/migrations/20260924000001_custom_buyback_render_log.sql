BEGIN;

-- 画像生成を依頼したオペレーター。レンダーJobが記録へ写す。
ALTER TABLE public.custom_buyback_sheet ADD COLUMN render_requested_by TEXT;

-- カスタム買取表の画像生成ごとの掲載記録（追記のみ）。
-- シート削除後も残すため sheet への外部キーは張らず、表示に必要な値を写しておく。
CREATE TABLE public.custom_buyback_render_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store TEXT NOT NULL,
  sheet_id UUID NOT NULL,
  revision INT NOT NULL,
  sheet_name TEXT NOT NULL,
  franchise TEXT NOT NULL,
  product_type TEXT NOT NULL,
  display_date DATE NOT NULL,
  sheet_created_by TEXT,
  rendered_by TEXT,
  rendered_at TIMESTAMPTZ NOT NULL,
  item_id UUID NOT NULL,
  card_name TEXT NOT NULL,
  grade TEXT,
  list_no TEXT,
  tag TEXT,
  final_price_high NUMERIC,
  final_price_low NUMERIC,
  source_price_high NUMERIC,
  source_shop_name TEXT,
  override_reason TEXT,
  backfilled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, revision, item_id)
);

CREATE INDEX idx_custom_buyback_render_log_store_rendered
  ON public.custom_buyback_render_log (store, rendered_at DESC);

ALTER TABLE public.custom_buyback_render_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_buyback_render_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.custom_buyback_render_log TO service_role;

-- 記録開始前に生成済みの表は、生成後に未編集のものだけ、画像に載っている内容を作成者不明として残す。
INSERT INTO public.custom_buyback_render_log (
  store, sheet_id, revision, sheet_name, franchise, product_type, display_date, sheet_created_by,
  rendered_by, rendered_at, item_id, card_name, grade, list_no, tag, final_price_high, final_price_low,
  source_price_high, source_shop_name, override_reason, backfilled
)
SELECT s.store, s.id, s.last_rendered_revision, s.name, s.franchise, s.product_type, s.display_date, s.created_by,
  NULL, p.rendered_at, i.id, i.card_name, i.grade, i.list_no, i.tag, i.final_price_high, i.final_price_low,
  i.source_price_high, i.source_shop_name, i.override_reason, TRUE
FROM public.custom_buyback_sheet s
JOIN LATERAL (
  SELECT item_id, max(pg.updated_at) AS rendered_at
  FROM public.custom_buyback_page pg CROSS JOIN LATERAL unnest(pg.item_ids) AS item_id
  WHERE pg.sheet_id = s.id AND pg.status = 'generated' AND pg.rendered_revision = s.last_rendered_revision
  GROUP BY item_id
) p ON TRUE
JOIN public.custom_buyback_item i ON i.id = p.item_id AND i.sheet_id = s.id
WHERE s.last_rendered_revision IS NOT NULL
  -- 生成後に編集された表（draft/failed）は画像と価格が一致しない可能性があるため移さない
  AND s.status = 'ready'
ON CONFLICT (sheet_id, revision, item_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
