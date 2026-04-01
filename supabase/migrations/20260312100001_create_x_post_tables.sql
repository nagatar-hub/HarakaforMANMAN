-- X投稿機能: 7テーブル + seed データ

-- 1. x_credential: X API認証情報（Secret Manager参照）
CREATE TABLE x_credential (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name                TEXT NOT NULL,
  x_user_id                   TEXT,
  x_username                  TEXT,
  secret_name_api_key         TEXT NOT NULL,
  secret_name_api_secret      TEXT NOT NULL,
  secret_name_access_token    TEXT NOT NULL,
  secret_name_access_secret   TEXT NOT NULL,
  status                      TEXT DEFAULT 'active',
  last_verified_at            TIMESTAMPTZ,
  is_default                  BOOLEAN DEFAULT TRUE,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);

-- 2. variable_registry: テンプレート変数定義
CREATE TABLE variable_registry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT UNIQUE NOT NULL,
  label           TEXT NOT NULL,
  source          TEXT NOT NULL,        -- 'system' / 'custom'
  resolve_type    TEXT NOT NULL,        -- 'auto' / 'static'
  default_value   TEXT,
  description     TEXT,
  is_deletable    BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- system変数 seed（削除不可）
INSERT INTO variable_registry (key, label, source, resolve_type, description, is_deletable) VALUES
  ('date',         '日付',           'system', 'auto', '投稿日（YYYY/MM/DD）',       FALSE),
  ('date_short',   '日付（短）',     'system', 'auto', '投稿日（MM/DD）',             FALSE),
  ('franchise',    '商材名',         'system', 'auto', 'ポケモン / ワンピース / 遊戯王', FALSE),
  ('franchise_en', '商材名（英語）', 'system', 'auto', 'Pokemon / ONE PIECE / YU-GI-OH!', FALSE),
  ('page_count',   '総ページ数',     'system', 'auto', 'その商材の総ページ数',         FALSE),
  ('page_no',      'ページ番号',     'system', 'auto', '現在のページ番号',             FALSE),
  ('page_title',   'ページタイトル', 'system', 'auto', 'TOP① / サポート② 等',        FALSE),
  ('card_count',   'カード枚数',     'system', 'auto', 'そのページのカード枚数',       FALSE),
  ('weekday',      '曜日',           'system', 'auto', '月・火・水...',                FALSE);

-- 3. post_template: 投稿テンプレート
CREATE TABLE post_template (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  franchise         TEXT,                -- null = 全商材共通
  header_template   TEXT NOT NULL,
  item_template     TEXT,
  is_default        BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- デフォルトテンプレート seed
INSERT INTO post_template (name, franchise, header_template, item_template, is_default) VALUES
(
  '通常買取表（ポケモン）',
  'Pokemon',
  E'🚩{{date_short}} #ポケカ　PSA10 買取表🚩\n⚡本日もポケカPSA10高額買い取り対応中⚡\n\n買取詳細\n☑買取受付:12：00〜18：00\n※本日は買取上限が達し次第、終日受付終了となります。予めご了承ください。\n☑振込対応のみ\n※金融機関の営業時間や状況によっては、振込反映までにお時間をいただく場合がございます。予めご了承ください。\n\n※買取表に記載していないカードの募集は行っておりません。\n予めご了承ください。\n\n※買取に出される物に関しては、予め買取表の記載順にソート分けして頂きますようご協力お願いいたします。\n\n本日もご来店お待ちしております！\n#秋葉原\n#ポケモンカード\n#PSA10\n#オリパーク',
  NULL,
  TRUE
),
(
  '通常買取表（遊戯王）',
  'YU-GI-OH!',
  E'🚩{{date_short}} #遊戯王　PSA10 買取表🚩\n⚡遊戯王PSA10高額買い取り対応中⚡\n\n買取詳細\n☑買取受付:12:00〜18：00\n☑即日振込対応\n☑振込対応のみ\n※金融機関の営業時間や状況によっては、振込反映までにお時間をいただく場合がございます。予めご了承くださいませ。\n\nご来店お待ちしております！\n\n⚠担当者がいない場合買取が出来ない可能性があります🙇\n\n#秋葉原\n#遊戯王\n#PSA10\n#オリパーク',
  NULL,
  TRUE
),
(
  '通常買取表（ワンピース）',
  'ONE PIECE',
  E'🚩{{date_short}} #ワンピース　PSA10 買取表🚩\n⚡本日もワンピのPSA10高額買い取り対応中⚡\n\n買取詳細\n☑買取受付:12:00〜18：00\n※本日は買取上限が達し次第、終日受付終了となります。\n☑即日振込対応\n☑振込対応のみ\n※金融機関の営業時間や状況によっては、振込反映までにお時間をいただく場合がございます。予めご了承くださいませ。\n\nご来店お待ちしております！\n\n#秋葉原\n#ワンピースカード\n#PSA10\n#オリパーク',
  NULL,
  TRUE
);

-- 4. post_banner: バナー画像管理
CREATE TABLE post_banner (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise       TEXT,                  -- null = 全商材共通
  name            TEXT NOT NULL,
  image_url       TEXT NOT NULL,
  position_type   TEXT DEFAULT 'last',   -- 'first' / 'last' / 'none'
  is_default      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 5. post_plan: 投稿計画（商材ごと）
CREATE TABLE post_plan (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID REFERENCES run(id),
  franchise               TEXT NOT NULL,
  template_id             UUID REFERENCES post_template(id),
  banner_id               UUID REFERENCES post_banner(id),
  banner_position         TEXT DEFAULT 'last',
  x_credential_id         UUID REFERENCES x_credential(id),
  header_text             TEXT,
  status                  TEXT DEFAULT 'draft',
  thread_head_tweet_id    TEXT,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_post_plan_run ON post_plan(run_id);

-- 6. post_item: ツイート単位
CREATE TABLE post_item (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_plan_id    UUID NOT NULL REFERENCES post_plan(id) ON DELETE CASCADE,
  position        INT NOT NULL,
  tweet_text      TEXT,
  is_header       BOOLEAN DEFAULT FALSE,
  tweet_id        TEXT,
  status          TEXT DEFAULT 'pending',
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_post_item_plan ON post_item(post_plan_id);

-- 7. post_item_asset: 画像スロット管理
CREATE TABLE post_item_asset (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_item_id      UUID NOT NULL REFERENCES post_item(id) ON DELETE CASCADE,
  slot_index        INT NOT NULL,
  generated_page_id UUID REFERENCES generated_page(id),
  image_url         TEXT NOT NULL,
  media_id          TEXT,
  asset_type        TEXT DEFAULT 'buylist',  -- 'buylist' / 'banner'
  UNIQUE(post_item_id, slot_index)
);

CREATE INDEX idx_post_item_asset_item ON post_item_asset(post_item_id);
