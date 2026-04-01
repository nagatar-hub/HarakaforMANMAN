export type LayoutConfig = {
  startX: number;
  priceStartX: number;
  colWidth: number;
  cardWidth: number;
  cardHeight: number;
  isSmallCard: boolean;
  rows: RowConfig[];
  priceBoxWidth: number;
  priceBoxHeight: number;
  dateX: number;
  dateY: number;
  rarityIconOffsetX?: number;
  rarityIconOffsetY?: number;
  rarityIconWidth?: number;
  rarityIconHeight?: number;
};

export type RowConfig = {
  cardY: number;
  priceHighY: number;
  priceLowY: number;
};

export type RunStatus = 'running' | 'completed' | 'failed';
export type RuleMatchType = 'exact' | 'contains' | 'regex';
export type RuleBehavior = 'isolate' | 'merge' | 'exclude' | 'group';

export type RunRow = {
  id: string;
  triggered_by: string;
  status: RunStatus;
  total_imported: number;
  total_prepared: number;
  total_image_ng: number;
  total_untagged: number;
  total_price_missing: number;
  total_pages: number;
  progress_current: number;
  progress_total: number;
  progress_message: string | null;
  started_at: string;
  import_done_at: string | null;
  prepare_done_at: string | null;
  spectre_done_at: string | null;
  health_check_done_at: string | null;
  plan_done_at: string | null;
  generate_done_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

export type RuleRow = {
  id: string;
  franchise: 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
  tag_pattern: string;
  match_type: RuleMatchType;
  behavior: RuleBehavior;
  priority: number;
  notes: string | null;
  group_key: string | null;
  created_at: string;
};

export type AssetProfileRow = {
  id: string;
  franchise: 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
  template_image: string | null;
  card_back_image: string | null;
  grid_cols: number;
  grid_rows: number;
  total_slots: number;
  img_width: number;
  img_height: number;
  font_family: string;
  price_format: string;
  layout_config: LayoutConfig | null;
  rarity_icons: Record<string, string> | null;
  created_at: string;
};

export type ImageStatus = 'unchecked' | 'ok' | 'fallback' | 'dead';
export type CardSource = 'kecak' | 'spectre' | 'manual';

export type RawImportRow = {
  id: string;
  run_id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  rarity: string | null;
  demand: number | null;
  kecak_price: number | null;
  raw_row: Record<string, unknown> | null;
  created_at: string;
};

export type PreparedCardRow = {
  id: string;
  run_id: string;
  raw_import_id: string | null;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  rarity: string | null;
  rarity_icon_url: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
  image_status: ImageStatus;
  source: CardSource;
  created_at: string;
};

export type PageStatus = 'pending' | 'generated' | 'failed';

// --- X投稿機能 ---
export type PostPlanStatus = 'draft' | 'posting' | 'completed' | 'partial' | 'failed';
export type PostItemStatus = 'pending' | 'posting' | 'posted' | 'unknown' | 'failed';
export type XCredentialStatus = 'active' | 'expired' | 'revoked';
export type VariableSource = 'system' | 'custom';
export type VariableResolveType = 'auto' | 'static';
export type BannerPositionType = 'first' | 'last' | 'none';
export type AssetType = 'buylist' | 'banner';

export type XCredentialRow = {
  id: string;
  account_name: string;
  x_user_id: string | null;
  x_username: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  status: XCredentialStatus;
  last_verified_at: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type VariableRegistryRow = {
  id: string;
  key: string;
  label: string;
  source: VariableSource;
  resolve_type: VariableResolveType;
  default_value: string | null;
  description: string | null;
  is_deletable: boolean;
  created_at: string;
};

export type PostTemplateRow = {
  id: string;
  name: string;
  franchise: string | null;
  header_template: string;
  item_template: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type PostBannerRow = {
  id: string;
  franchise: string | null;
  name: string;
  image_url: string;
  position_type: BannerPositionType;
  is_default: boolean;
  created_at: string;
};

export type PostPlanRow = {
  id: string;
  run_id: string | null;
  franchise: string;
  template_id: string | null;
  banner_id: string | null;
  banner_position: BannerPositionType;
  x_credential_id: string | null;
  header_text: string | null;
  status: PostPlanStatus;
  thread_head_tweet_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PostItemRow = {
  id: string;
  post_plan_id: string;
  position: number;
  tweet_text: string | null;
  is_header: boolean;
  tweet_id: string | null;
  status: PostItemStatus;
  error_message: string | null;
  created_at: string;
};

export type PostItemAssetRow = {
  id: string;
  post_item_id: string;
  slot_index: number;
  generated_page_id: string | null;
  image_url: string;
  media_id: string | null;
  asset_type: AssetType;
};

export type GeneratedPageRow = {
  id: string;
  run_id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  card_ids: string[];
  image_key: string | null;
  image_url: string | null;
  status: PageStatus;
  created_at: string;
};

export type DbCardRow = {
  id: string;
  franchise: string;
  tag: string | null;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  rarity_icon: string | null;
  sheet_row_number: number | null;
  image_status: ImageStatus | null;
  created_at: string;
  updated_at: string;
};

export type Database = {
  public: {
    Tables: {
      run: {
        Row: RunRow;
        Insert: Partial<RunRow> & Pick<RunRow, 'triggered_by'>;
        Update: Partial<RunRow>;
        Relationships: [];
      };
      rule: {
        Row: RuleRow;
        Insert: Omit<RuleRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<RuleRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      asset_profile: {
        Row: AssetProfileRow;
        Insert: Omit<AssetProfileRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<AssetProfileRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      raw_import: {
        Row: RawImportRow;
        Insert: Omit<RawImportRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<RawImportRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      prepared_card: {
        Row: PreparedCardRow;
        Insert: Omit<PreparedCardRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<PreparedCardRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      generated_page: {
        Row: GeneratedPageRow;
        Insert: Omit<GeneratedPageRow, 'id' | 'created_at' | 'image_key' | 'image_url' | 'status'> & {
          id?: string; created_at?: string;
          image_key?: string | null; image_url?: string | null; status?: PageStatus;
        };
        Update: Partial<Omit<GeneratedPageRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      db_card: {
        Row: DbCardRow;
        Insert: Omit<DbCardRow, 'id' | 'created_at' | 'updated_at'> & {
          id?: string; created_at?: string; updated_at?: string;
        };
        Update: Partial<Omit<DbCardRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      // --- X投稿機能 ---
      x_credential: {
        Row: XCredentialRow;
        Insert: Omit<XCredentialRow, 'id' | 'created_at' | 'updated_at' | 'status' | 'last_verified_at' | 'is_default' | 'x_user_id' | 'x_username' | 'access_token' | 'refresh_token' | 'token_expires_at'> & {
          id?: string; created_at?: string; updated_at?: string;
          status?: XCredentialStatus; last_verified_at?: string | null; is_default?: boolean;
          x_user_id?: string | null; x_username?: string | null;
          access_token?: string | null; refresh_token?: string | null; token_expires_at?: string | null;
        };
        Update: Partial<Omit<XCredentialRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      variable_registry: {
        Row: VariableRegistryRow;
        Insert: Omit<VariableRegistryRow, 'id' | 'created_at' | 'is_deletable'> & {
          id?: string; created_at?: string; is_deletable?: boolean;
        };
        Update: Partial<Omit<VariableRegistryRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      post_template: {
        Row: PostTemplateRow;
        Insert: Omit<PostTemplateRow, 'id' | 'created_at' | 'updated_at' | 'is_default'> & {
          id?: string; created_at?: string; updated_at?: string; is_default?: boolean;
        };
        Update: Partial<Omit<PostTemplateRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      post_banner: {
        Row: PostBannerRow;
        Insert: Omit<PostBannerRow, 'id' | 'created_at' | 'is_default' | 'position_type'> & {
          id?: string; created_at?: string; is_default?: boolean; position_type?: BannerPositionType;
        };
        Update: Partial<Omit<PostBannerRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      post_plan: {
        Row: PostPlanRow;
        Insert: Omit<PostPlanRow, 'id' | 'created_at' | 'updated_at' | 'status' | 'banner_position' | 'thread_head_tweet_id'> & {
          id?: string; created_at?: string; updated_at?: string;
          status?: PostPlanStatus; banner_position?: BannerPositionType; thread_head_tweet_id?: string | null;
        };
        Update: Partial<Omit<PostPlanRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      post_item: {
        Row: PostItemRow;
        Insert: Omit<PostItemRow, 'id' | 'created_at' | 'status' | 'is_header' | 'tweet_id' | 'error_message'> & {
          id?: string; created_at?: string;
          status?: PostItemStatus; is_header?: boolean; tweet_id?: string | null; error_message?: string | null;
        };
        Update: Partial<Omit<PostItemRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      post_item_asset: {
        Row: PostItemAssetRow;
        Insert: Omit<PostItemAssetRow, 'id' | 'media_id' | 'asset_type' | 'generated_page_id'> & {
          id?: string; media_id?: string | null; asset_type?: AssetType; generated_page_id?: string | null;
        };
        Update: Partial<Omit<PostItemAssetRow, 'id'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
