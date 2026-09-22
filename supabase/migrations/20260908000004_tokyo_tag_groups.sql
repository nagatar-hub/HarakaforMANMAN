BEGIN;
DO $$
DECLARE changed INT;
BEGIN
  -- Preserve raw tag patterns and match types used by the tag management UI.
  -- Tokyo main-tag matching is handled by the planner; only order changes here.
  WITH settings(franchise,tag_pattern,group_key,priority) AS (VALUES
    ('Pokemon','TOP','TOP',1000),
    ('Pokemon','ピカチュウ','ピカチュウ',900),
    ('Pokemon','イーブイ','イーブイ',800),
    ('Pokemon','リザードン','リザードン',700),
    ('Pokemon','サポート','サポート',600),
    ('Pokemon','AR','AR/SAR',510),('Pokemon','SAR','AR/SAR',500),
    ('Pokemon','GX','GX/TAG/V/VMAX/VSTAR',440),('Pokemon','TAG','GX/TAG/V/VMAX/VSTAR',430),
    ('Pokemon','V','GX/TAG/V/VMAX/VSTAR',420),('Pokemon','VMAX','GX/TAG/V/VMAX/VSTAR',410),
    ('Pokemon','VSTAR','GX/TAG/V/VMAX/VSTAR',400),
    ('Pokemon','メガシンカex','メガシンカex/プロモ',310),('Pokemon','プロモ','メガシンカex/プロモ',300),
    ('Pokemon','XY','その他',270),('Pokemon','M進化EX','その他',260),
    ('Pokemon','25th','その他',250),('Pokemon','CHR','その他',240),
    ('Pokemon','SSR','その他',230),('Pokemon','マスボ','その他',220),
    ('Pokemon','BWR','その他',210),('Pokemon','BOX','BOX',100),
    ('ONE PIECE','リーパラ','リーパラ/コミパラ',1010),('ONE PIECE','コミパラ','リーパラ/コミパラ',1000),
    ('ONE PIECE','プロモ','プロモ/イベント',910),('ONE PIECE','イベント','プロモ/イベント',900),
    ('ONE PIECE','パラレル','その他',840),('ONE PIECE','キャラ','その他',830),
    ('ONE PIECE','フラシ','その他',820),('ONE PIECE','ヒロイン','その他',810),
    ('ONE PIECE','タロット','その他',800)
  )
  UPDATE public.rule r SET priority=s.priority
  FROM settings s WHERE r.store='manman-akihabara' AND r.franchise=s.franchise
    AND r.tag_pattern=s.tag_pattern AND r.group_key=s.group_key
    AND r.match_type='contains' AND r.behavior='group' AND r.priority=50;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 31 THEN RAISE EXCEPTION 'Tokyo tag rule baseline changed: expected 31, found %',changed; END IF;
END $$;
COMMIT;
