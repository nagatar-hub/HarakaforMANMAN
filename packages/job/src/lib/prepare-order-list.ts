import type { Database, Franchise, StorePricingSettings } from '@haraka/shared';
import {
  calculateBuyPriceHigh,
  calculateBuyPriceLow,
  calculateBoxPrice,
  DEFAULT_STORE_PRICING_SETTINGS,
} from '@haraka/shared';
import { isBoxRow } from './box-row.js';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type PreparedCardInsert = Database['public']['Tables']['prepared_card']['Insert'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];

/**
 * 照合済みオーダーリスト行をPreparedCardへ変換する。
 * Excel価格を入力にしつつ、MANMANの商材別・BOX別割引率を維持する。
 */
export function prepareOrderListCards(
  rawImports: RawImportRow[],
  dbCardsById: Map<string, DbCardRow>,
  businessDate: string,
  pricingSettings: StorePricingSettings = DEFAULT_STORE_PRICING_SETTINGS,
): PreparedCardInsert[] {
  return rawImports.map((rawImport) => {
    if (!rawImport.db_card_id) {
      throw new Error(`raw_import ${rawImport.id} に db_card_id がありません`);
    }
    const dbCard = dbCardsById.get(rawImport.db_card_id);
    if (!dbCard) {
      throw new Error(`raw_import ${rawImport.id} の対応先DB商品が見つかりません: ${rawImport.db_card_id}`);
    }
    if (rawImport.source_price === null) {
      const isMissingPokemonBoxPrice = rawImport.franchise === 'Pokemon'
        && isBoxRow(rawImport)
        && rawImport.raw_row?.pokemon_box_price_source === 'missing';
      if (!isMissingPokemonBoxPrice) {
        throw new Error(`raw_import ${rawImport.id} にオーダーリスト価格がありません`);
      }
    }

    // 過去に作成済みのBOX価格DB未登録行も読み出せるよう、旧null行だけは0円の監査対象として扱う。
    // 現在のオーダーリスト取込ではBOX価格DB未登録時もExcel価格がsource_priceに保持される。
    const sourcePrice = rawImport.source_price ?? 0;
    const franchise = rawImport.franchise as Franchise;
    const isBox = isBoxRow(rawImport);
    const boxRates = pricingSettings.box_discount_rates[franchise];
    const priceHigh = isBox
      ? calculateBoxPrice(sourcePrice, boxRates.shrink)
      : calculateBuyPriceHigh(sourcePrice, pricingSettings.psa10_discount_rates[franchise]);
    const priceLow = isBox
      ? calculateBoxPrice(sourcePrice, boxRates.no_shrink)
      : calculateBuyPriceLow(priceHigh, franchise);

    return {
      run_id: rawImport.run_id,
      raw_import_id: rawImport.id,
      order_list_item_id: rawImport.order_list_item_id,
      excel_product_id: rawImport.excel_product_id,
      db_card_id: dbCard.id,
      franchise: rawImport.franchise,
      card_name: rawImport.card_name,
      grade: rawImport.grade,
      list_no: rawImport.list_no,
      image_url: rawImport.image_url,
      alt_image_url: dbCard.alt_image_url ?? dbCard.image_url,
      rarity: rawImport.rarity,
      rarity_icon_url: dbCard.rarity_icon,
      tag: dbCard.tag ?? (isBox ? 'BOX' : null),
      price_high: priceHigh,
      price_low: priceLow,
      image_status: 'unchecked',
      source: 'order_list',
      price_source: 'order_list',
      price_source_date: businessDate,
    };
  });
}
