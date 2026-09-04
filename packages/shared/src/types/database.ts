import type { Franchise } from './franchise.js';

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
  layoutAdjust?: { cardYDelta: number; priceYDelta: number };
  rowPriceAdjust?: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }>;
  rowCardAdjust?: Record<number, number>;
  rowsBOX?: RowConfig[];
  templateFileId_BOX?: string | null;
  cardBackId_BOX?: string | null;
  cardFit?: 'cover' | 'contain' | 'fill';
};

export type RowConfig = {
  cardY: number;
  priceHighY: number;
  priceLowY: number;
};

export type RunStatus = 'running' | 'completed' | 'failed';
export type RuleMatchType = 'exact' | 'contains' | 'regex';
export type RuleBehavior = 'isolate' | 'merge' | 'exclude' | 'group';
export type OrderListFranchise = Franchise;
export type CustomBuybackFranchise = Extract<Franchise, 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!'>;
export type OrderListImportStatus = 'parsed' | 'confirmed' | 'processing' | 'applied' | 'failed';
export type OrderListMatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'excluded' | 'invalid';
export type OrderListMatchMethod = 'existing_mapping' | 'exact_image' | 'exact_identity' | 'manual';
export type ExcelProductMappingStatus = 'active' | 'disabled';
export type PriceSource = 'order_list' | 'kecak' | 'spectre' | 'manual';
export type CustomBuybackPriceSource = PriceSource | 'kaitori_checker';
export type CustomBuybackProductType = 'psa' | 'box';
export type CustomBuybackKind = 'postal' | 'store';
export type CustomBuybackSheetStatus = 'draft' | 'rendering' | 'ready' | 'failed';
export type CustomBuybackCatalogSource = 'prepared_card' | 'kaitori_checker';
export type KaitoriCheckerSyncTrigger = 'scheduler' | 'manual';
export type KaitoriCheckerSyncStatus = 'queued' | 'running' | 'applied' | 'failed';
export type OperatorAuditMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type OperatorAuditLogRow = {
  id: string;
  store: string;
  actor_email: string;
  http_method: OperatorAuditMethod;
  request_path: string;
  target_id: string | null;
  status_code: number;
  created_at: string;
};

export type StoreConfigRow = {
  store: string;
  settings: {
    box_discount_rates?: Partial<Record<Franchise, {
      shrink?: number;
      no_shrink?: number;
    }>>;
    psa10_discount_rates?: Partial<Record<Franchise, number>>;
    [key: string]: unknown;
  };
  updated_at: string;
};

export type RunRow = {
  id: string;
  store: string;
  triggered_by: string;
  status: RunStatus;
  order_list_import_id: string | null;
  order_list_sync_request_id: string | null;
  order_list_sync_request_fingerprint: string | null;
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
  generate_claimed_at: string | null;
  generate_claim_token: string | null;
  completed_at: string | null;
  error_message: string | null;
  postal_done_at: string | null;
  store_done_at: string | null;
  progress_postal_current: number;
  progress_postal_total: number;
  progress_postal_message: string | null;
  progress_store_current: number;
  progress_store_total: number;
  progress_store_message: string | null;
};

export type RuleRow = {
  id: string;
  store: string;
  franchise: Franchise;
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
  store: string;
  franchise: Franchise;
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
  template_storage_path: string | null;
  card_back_storage_path: string | null;
  template_box_storage_path: string | null;
  card_back_box_storage_path: string | null;
  created_at: string;
};

export type LayoutTemplateRow = {
  id: string;
  store: string;
  franchise: Franchise;
  name: string;
  slug: string;
  grid_cols: number;
  grid_rows: number;
  total_slots: number;
  img_width: number;
  img_height: number;
  template_storage_path: string;
  card_back_storage_path: string;
  layout_config: LayoutConfig;
  skip_price_low: boolean;
  is_default: boolean;
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  kind: 'postal' | 'store';
};

export type ImageStatus = 'unchecked' | 'ok' | 'fallback' | 'dead';
export type CardSource = 'order_list' | 'kecak' | 'spectre' | 'manual';

export type RawImportRow = {
  id: string;
  run_id: string;
  order_list_item_id: string | null;
  excel_product_id: string | null;
  db_card_id: string | null;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  rarity: string | null;
  demand: number | null;
  kecak_price: number | null;
  source_price: number | null;
  price_source: PriceSource;
  raw_row: Record<string, unknown> | null;
  created_at: string;
};

export type PreparedCardRow = {
  id: string;
  run_id: string;
  raw_import_id: string | null;
  order_list_item_id: string | null;
  excel_product_id: string | null;
  db_card_id: string | null;
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
  price_source: PriceSource;
  price_source_date: string | null;
  created_at: string;
};

export type PageStatus = 'pending' | 'generated' | 'failed';

export type CustomBuybackSheetRow = {
  id: string;
  store: string;
  name: string;
  franchise: CustomBuybackFranchise;
  product_type: CustomBuybackProductType;
  kind: CustomBuybackKind;
  catalog_source: CustomBuybackCatalogSource;
  price_snapshot_run_id: string | null;
  kaitori_checker_run_id: string | null;
  kaitori_checker_source_store: string | null;
  price_business_date: string;
  display_date: string;
  status: CustomBuybackSheetStatus;
  revision: number;
  last_rendered_revision: number | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RarityIconRow = {
  id: string;
  franchise: Franchise | null;
  name: string;
  storage_path: string;
  drive_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomBuybackItemRow = {
  id: string;
  sheet_id: string;
  source_prepared_card_id: string | null;
  source_kaitori_product_id: number | null;
  source_kaitori_condition_id: number | null;
  source_kaitori_shop_id: number | null;
  source_kaitori_edition_id: number | null;
  source_shop_name: string | null;
  source_db_card_id: string | null;
  excel_product_id: string | null;
  position: number;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  rarity: string | null;
  rarity_icon_url: string | null;
  tag: string | null;
  image_url: string | null;
  alt_image_url: string | null;
  image_status: ImageStatus;
  source_price_high: number | null;
  source_price_low: number | null;
  final_price_high: number | null;
  final_price_low: number | null;
  demand: number;
  price_source: CustomBuybackPriceSource;
  price_source_date: string;
  override_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomBuybackPageRow = {
  id: string;
  sheet_id: string;
  page_index: number;
  layout_template_id: string;
  item_ids: string[];
  status: PageStatus;
  rendered_revision: number;
  image_key: string | null;
  image_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

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
  store: string;
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
  store: string;
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
  store: string;
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
  store: string;
  franchise: string | null;
  name: string;
  image_url: string;
  position_type: BannerPositionType;
  is_default: boolean;
  created_at: string;
};

export type PostPlanRow = {
  id: string;
  store: string;
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
  error_message: string | null;
  layout_template_id: string | null;
  kind: 'postal' | 'store';
  display_name: string | null;
  created_at: string;
};

export type DbCardRow = {
  id: string;
  store: string;
  franchise: string;
  source_product_id: string;
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

export type OrderListImportRow = {
  id: string;
  store: string;
  business_date: string;
  status: OrderListImportStatus;
  original_filename: string;
  original_mime_type: string | null;
  original_size_bytes: number;
  sha256: string;
  storage_bucket: string;
  storage_path: string;
  parser_version: string;
  structural_valid: boolean;
  persistence_complete: boolean;
  sheet_counts: Record<string, unknown>;
  applied_summary: Record<string, unknown> | null;
  total_rows: number;
  valid_rows: number;
  matched_rows: number;
  unmatched_rows: number;
  ambiguous_rows: number;
  excluded_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  error_summary: unknown;
  confirmation_allow_unresolved: boolean | null;
  order_list_sync_request_id: string | null;
  order_list_sync_request_fingerprint: string | null;
  uploaded_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  processing_started_at: string | null;
  heartbeat_at: string | null;
  activated_at: string | null;
  failed_at: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ExcelProductMappingRow = {
  id: string;
  store: string;
  franchise: OrderListFranchise;
  excel_product_id: string;
  excel_product_key: string;
  db_card_id: string | null;
  status: ExcelProductMappingStatus;
  match_method: OrderListMatchMethod | null;
  first_seen_import_id: string | null;
  last_seen_import_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderListItemRow = {
  id: string;
  import_id: string;
  franchise: OrderListFranchise;
  excel_product_id: string;
  sheet_name: string;
  sheet_row_number: number;
  row_hash: string;
  card_name: string;
  grade: string | null;
  expansion: string | null;
  list_no: string | null;
  rarity: string | null;
  image_url: string | null;
  demand: number | null;
  source_price: number | null;
  raw_row: Record<string, unknown>;
  validation_issues: unknown[];
  mapping_id: string | null;
  db_card_id: string | null;
  match_status: OrderListMatchStatus;
  match_method: OrderListMatchMethod | null;
  match_candidates: unknown[];
  match_note: string | null;
  selection_fingerprint: string | null;
  matched_at: string | null;
  created_at: string;
  updated_at: string;
};

export type KaitoriCheckerSyncRunRow = {
  id: string;
  store: string;
  request_key: string;
  trigger: KaitoriCheckerSyncTrigger;
  claim_token: string;
  status: KaitoriCheckerSyncStatus;
  progress_page: number;
  product_count: number;
  offer_count: number;
  ranking_count: number;
  content_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  sheet_published_at: string | null;
  sheet_error: string | null;
  created_at: string;
  updated_at: string;
};

export type KaitoriCheckerCustomBuybackCatalogRow = {
  run_id: string;
  store: string;
  source_product_id: number;
  category: string;
  condition_id: number;
  condition_name: string | null;
  shop_id: number;
  shop_name: string;
  edition_id: number;
  edition_name: string | null;
  buy_price: number;
  name: string;
  full_name: string | null;
  model_number: string | null;
  rarity: string | null;
  image_url: string | null;
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
      order_list_import: {
        Row: OrderListImportRow;
        Insert: Pick<OrderListImportRow, 'store' | 'business_date' | 'original_filename' | 'original_size_bytes' | 'sha256' | 'storage_path'> &
          Partial<Omit<OrderListImportRow, 'id' | 'created_at' | 'store' | 'business_date' | 'original_filename' | 'original_size_bytes' | 'sha256' | 'storage_path'>> & {
            id?: string;
            created_at?: string;
          };
        Update: Partial<Omit<OrderListImportRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      excel_product_mapping: {
        Row: ExcelProductMappingRow;
        Insert: Pick<ExcelProductMappingRow, 'store' | 'franchise' | 'excel_product_id'> &
          Partial<Omit<ExcelProductMappingRow, 'id' | 'created_at' | 'store' | 'franchise' | 'excel_product_id' | 'excel_product_key'>> & {
            id?: string;
            created_at?: string;
          };
        Update: Partial<Omit<ExcelProductMappingRow, 'id' | 'created_at' | 'excel_product_key'>>;
        Relationships: [];
      };
      order_list_item: {
        Row: OrderListItemRow;
        Insert: Pick<OrderListItemRow, 'import_id' | 'franchise' | 'excel_product_id' | 'sheet_name' | 'sheet_row_number' | 'row_hash' | 'card_name'> &
          Partial<Omit<OrderListItemRow, 'id' | 'created_at' | 'import_id' | 'franchise' | 'excel_product_id' | 'sheet_name' | 'sheet_row_number' | 'row_hash' | 'card_name'>> & {
            id?: string;
            created_at?: string;
          };
        Update: Partial<Omit<OrderListItemRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      kaitori_checker_sync_run: {
        Row: KaitoriCheckerSyncRunRow;
        Insert: Pick<KaitoriCheckerSyncRunRow, 'store' | 'request_key' | 'trigger' | 'claim_token'> &
          Partial<Omit<KaitoriCheckerSyncRunRow, 'id' | 'store' | 'request_key' | 'trigger' | 'claim_token' | 'created_at' | 'updated_at'>> & {
            id?: string;
            created_at?: string;
            updated_at?: string;
          };
        Update: Partial<Omit<KaitoriCheckerSyncRunRow, 'id' | 'store' | 'request_key' | 'claim_token' | 'created_at'>>;
        Relationships: [];
      };
      raw_import: {
        Row: RawImportRow;
        Insert: Omit<RawImportRow, 'id' | 'created_at' | 'order_list_item_id' | 'excel_product_id' | 'db_card_id' | 'source_price' | 'price_source'> & {
          id?: string;
          created_at?: string;
          order_list_item_id?: string | null;
          excel_product_id?: string | null;
          db_card_id?: string | null;
          source_price?: number | null;
          price_source?: PriceSource;
        };
        Update: Partial<Omit<RawImportRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      prepared_card: {
        Row: PreparedCardRow;
        Insert: Omit<PreparedCardRow, 'id' | 'created_at' | 'order_list_item_id' | 'excel_product_id' | 'db_card_id' | 'price_source' | 'price_source_date'> & {
          id?: string;
          created_at?: string;
          order_list_item_id?: string | null;
          excel_product_id?: string | null;
          db_card_id?: string | null;
          price_source?: PriceSource;
          price_source_date?: string | null;
        };
        Update: Partial<Omit<PreparedCardRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      generated_page: {
        Row: GeneratedPageRow;
        Insert: Omit<GeneratedPageRow, 'id' | 'created_at' | 'image_key' | 'image_url' | 'status' | 'error_message' | 'layout_template_id' | 'kind' | 'display_name'> & {
          id?: string; created_at?: string;
          image_key?: string | null; image_url?: string | null; status?: PageStatus;
          error_message?: string | null;
          layout_template_id?: string | null;
          kind?: 'postal' | 'store';
          display_name?: string | null;
        };
        Update: Partial<Omit<GeneratedPageRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      layout_template: {
        Row: LayoutTemplateRow;
        Insert: Omit<LayoutTemplateRow, 'id' | 'created_at' | 'updated_at' | 'store' | 'img_width' | 'img_height' | 'skip_price_low' | 'is_default' | 'is_active' | 'priority' | 'kind'> & {
          id?: string; created_at?: string; updated_at?: string;
          store?: string; img_width?: number; img_height?: number;
          skip_price_low?: boolean; is_default?: boolean; is_active?: boolean; priority?: number;
          kind?: 'postal' | 'store';
        };
        Update: Partial<Omit<LayoutTemplateRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      custom_buyback_sheet: {
        Row: CustomBuybackSheetRow;
        Insert: Omit<CustomBuybackSheetRow, 'id' | 'created_at' | 'updated_at' | 'status' | 'revision' | 'last_rendered_revision' | 'error_message'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          status?: CustomBuybackSheetStatus;
          revision?: number;
          last_rendered_revision?: number | null;
          error_message?: string | null;
        };
        Update: Partial<Omit<CustomBuybackSheetRow, 'id' | 'store' | 'created_at'>>;
        Relationships: [];
      };
      rarity_icon: {
        Row: RarityIconRow;
        Insert: Omit<RarityIconRow, 'id' | 'created_at' | 'updated_at' | 'drive_id' | 'franchise'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          drive_id?: string | null;
          franchise?: Franchise | null;
        };
        Update: Partial<Omit<RarityIconRow, 'id' | 'created_at'>>;
        Relationships: [];
      };
      custom_buyback_item: {
        Row: CustomBuybackItemRow;
        Insert: Omit<CustomBuybackItemRow, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<CustomBuybackItemRow, 'id' | 'sheet_id' | 'created_at'>>;
        Relationships: [];
      };
      custom_buyback_page: {
        Row: CustomBuybackPageRow;
        Insert: Omit<CustomBuybackPageRow, 'id' | 'created_at' | 'updated_at' | 'status' | 'image_key' | 'image_url' | 'error_message'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          status?: PageStatus;
          image_key?: string | null;
          image_url?: string | null;
          error_message?: string | null;
        };
        Update: Partial<Omit<CustomBuybackPageRow, 'id' | 'sheet_id' | 'created_at'>>;
        Relationships: [];
      };
      operator_audit_log: {
        Row: OperatorAuditLogRow;
        Insert: Omit<OperatorAuditLogRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: never;
        Relationships: [];
      };
      store_config: {
        Row: StoreConfigRow;
        Insert: Omit<StoreConfigRow, 'updated_at'> & { updated_at?: string };
        Update: Partial<StoreConfigRow>;
        Relationships: [];
      };
      db_card: {
        Row: DbCardRow;
        Insert: Omit<DbCardRow, 'id' | 'created_at' | 'updated_at' | 'source_product_id'> & {
          id?: string; created_at?: string; updated_at?: string; source_product_id?: string;
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
    Views: {
      kaitori_checker_custom_buyback_catalog: {
        Row: KaitoriCheckerCustomBuybackCatalogRow;
        Relationships: [];
      };
    };
    Functions: {
      reorder_custom_buyback_items: {
        Args: { p_sheet_id: string; p_store: string; p_item_ids: string[] };
        Returns: undefined;
      };
      bulk_update_custom_buyback_prices: {
        Args: {
          p_sheet_id: string;
          p_store: string;
          p_item_ids: string[];
          p_operation: 'add' | 'percent' | 'round' | 'reset';
          p_value: number;
        };
        Returns: undefined;
      };
      clone_custom_buyback_sheet: {
        Args: { p_sheet_id: string; p_store: string; p_name: string; p_created_by: string | null };
        Returns: string;
      };
      refresh_custom_buyback_prices: {
        Args: {
          p_sheet_id: string;
          p_store: string;
          p_run_id: string;
          p_business_date: string;
          p_item_ids: string[];
          p_prepared_card_ids: string[];
          p_preserve_overrides: boolean;
        };
        Returns: undefined;
      };
      add_custom_buyback_items: {
        Args: { p_sheet_id: string; p_store: string; p_prepared_card_ids: string[] };
        Returns: undefined;
      };
      add_custom_buyback_kaitori_items: {
        Args: { p_sheet_id: string; p_store: string; p_source_product_ids: number[] };
        Returns: undefined;
      };
      refresh_custom_buyback_kaitori_prices: {
        Args: {
          p_sheet_id: string;
          p_store: string;
          p_run_id: string;
          p_business_date: string;
          p_preserve_overrides: boolean;
        };
        Returns: undefined;
      };
      delete_custom_buyback_item: {
        Args: { p_sheet_id: string; p_store: string; p_item_id: string };
        Returns: undefined;
      };
      resolve_order_list_item_mapping: {
        Args: {
          p_import_id: string;
          p_item_id: string;
          p_db_card_id: string;
        };
        Returns: Record<string, unknown>;
      };
      resolve_order_list_item_mappings: {
        Args: {
          p_import_id: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };
      resolve_order_list_item_selections: {
        Args: {
          p_import_id: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_new_cards: Array<{
            item_id: string;
            card_name: string;
            grade: string;
            list_no: string;
            tag: string;
            alt_image_url: string | null;
          }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };
      confirm_order_list_import_selections: {
        Args: {
          p_import_id: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_new_cards: Array<{
            item_id: string;
            card_name: string;
            grade: string;
            list_no: string;
            tag: string;
            alt_image_url: string | null;
          }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };
      renew_order_list_sync_lease: {
        Args: {
          p_import_id: string;
          p_run_id: string;
          p_heartbeat_at: string;
        };
        Returns: boolean;
      };
      resolve_order_list_item_exclusions: {
        Args: {
          p_import_id: string;
          p_exclusions: Array<{ item_id: string }>;
        };
        Returns: Record<string, unknown>;
      };
      resolve_order_list_review_changes: {
        Args: {
          p_import_id: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_new_cards: Array<{
            item_id: string;
            card_name: string;
            grade: string;
            list_no: string;
            tag: string;
            alt_image_url: string | null;
          }>;
          p_exclusions: Array<{ item_id: string }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };
      confirm_order_list_import_review: {
        Args: {
          p_import_id: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_new_cards: Array<{
            item_id: string;
            card_name: string;
            grade: string;
            list_no: string;
            tag: string;
            alt_image_url: string | null;
          }>;
          p_exclusions: Array<{ item_id: string }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };
      queue_order_list_import_resync: {
        Args: {
          p_import_id: string;
          p_request_id: string;
          p_request_fingerprint: string;
          p_mappings: Array<{ item_id: string; db_card_id: string }>;
          p_new_cards: Array<{
            item_id: string;
            card_name: string;
            grade: string;
            list_no: string;
            tag: string;
            alt_image_url: string | null;
          }>;
          p_exclusions: Array<{ item_id: string }>;
          p_allow_unresolved: boolean;
        };
        Returns: Record<string, unknown>;
      };      finalize_order_list_sync: {
        Args: {
          p_import_id: string;
          p_run_id: string;
          p_total_prepared: number;
          p_total_pages: number;
          p_completed_at: string;
        };
        Returns: undefined;
      };
      fail_order_list_sync: {
        Args: {
          p_import_id: string;
          p_run_id: string;
          p_failure_message: string;
          p_failed_at: string;
        };
        Returns: undefined;
      };
      recover_stale_order_list_imports: {
        Args: {
          p_stale_before: string;
        };
        Returns: number;
      };
      recover_stale_order_list_imports_for_store: {
        Args: {
          p_store: string;
          p_stale_before: string;
        };
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
