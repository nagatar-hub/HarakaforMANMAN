-- 生成中のシートを、同じリビジョンのまま下書きへ戻す更新を無効にする。
-- 商品編集の保存と画像生成の依頼が競合すると、編集側の後処理が生成中を下書きへ上書きし、
-- レンダーJobが対象リビジョンを見失っていた（2026-09-25 オリパーク 9/25）。
-- 生成の終了（ready/failed）と新しいリビジョンの開始はそのまま通す。
CREATE OR REPLACE FUNCTION public.keep_custom_buyback_rendering()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'rendering' AND NEW.status = 'draft' AND NEW.revision = OLD.revision THEN
    NEW.status := OLD.status;
    NEW.error_message := OLD.error_message;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_keep_custom_buyback_rendering
  BEFORE UPDATE OF status ON public.custom_buyback_sheet
  FOR EACH ROW EXECUTE FUNCTION public.keep_custom_buyback_rendering();
