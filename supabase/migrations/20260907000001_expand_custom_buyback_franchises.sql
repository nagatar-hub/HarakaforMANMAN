ALTER TABLE public.custom_buyback_sheet
  DROP CONSTRAINT custom_buyback_sheet_franchise_check,
  ADD CONSTRAINT custom_buyback_sheet_franchise_check
    CHECK (
      franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')
      OR (
        store = 'manman-akihabara'
        AND franchise IN ('WEISS SCHWARZ', 'DRAGON BALL')
      )
    );
