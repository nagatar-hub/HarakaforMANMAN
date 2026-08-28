import {
  DEFAULT_STORE_PRICING_SETTINGS,
  type Database,
  type Franchise,
} from '@haraka/shared';
import { prepareOrderListCards } from '../lib/prepare-order-list';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];

function makeRawImport(overrides: Partial<RawImportRow> = {}): RawImportRow {
  return {
    id: 'raw-1',
    run_id: 'run-1',
    order_list_item_id: 'item-1',
    excel_product_id: 'excel-1',
    db_card_id: 'db-1',
    franchise: 'Pokemon',
    card_name: 'リザードン',
    grade: 'PSA10',
    list_no: '001',
    image_url: 'https://excel.example/card.jpg',
    rarity: 'SAR',
    demand: 2,
    kecak_price: null,
    source_price: 50_000,
    price_source: 'order_list',
    raw_row: {},
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeDbCard(overrides: Partial<DbCardRow> = {}): DbCardRow {
  return {
    id: 'db-1',
    store: 'manman',
    franchise: 'Pokemon',
    source_product_id: '',
    tag: 'TOP',
    card_name: 'リザードン',
    grade: 'PSA10',
    list_no: '001',
    image_url: 'https://db.example/card.jpg',
    alt_image_url: 'https://db.example/alternative.jpg',
    rarity_icon: 'https://db.example/rarity.png',
    sheet_row_number: 2,
    image_status: 'ok',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('prepareOrderListCards', () => {
  it('OP08-106は最新Excelの78,540円と5%設定から74,000円を生成する', () => {
    const pricingSettings = {
      ...DEFAULT_STORE_PRICING_SETTINGS,
      psa10_discount_rates: {
        ...DEFAULT_STORE_PRICING_SETTINGS.psa10_discount_rates,
        'ONE PIECE': 0.05,
      },
    };
    const result = prepareOrderListCards(
      [makeRawImport({
        franchise: 'ONE PIECE',
        card_name: 'ナミ',
        list_no: 'OP08-106',
        source_price: 78_540,
      })],
      new Map([['db-1', makeDbCard({
        franchise: 'ONE PIECE',
        card_name: 'ナミ',
        list_no: 'OP08-106',
      })]]),
      '2026-07-20',
      pricingSettings,
    );

    expect(result[0]).toMatchObject({
      price_high: 74_000,
      price_source: 'order_list',
      price_source_date: '2026-07-20',
    });
  });

  it('アイリスの闘志は10,098円と5%設定から9,500円を生成する', () => {
    const pricingSettings = {
      ...DEFAULT_STORE_PRICING_SETTINGS,
      psa10_discount_rates: {
        ...DEFAULT_STORE_PRICING_SETTINGS.psa10_discount_rates,
        Pokemon: 0.05,
      },
    };
    const result = prepareOrderListCards(
      [makeRawImport({
        card_name: 'アイリスの闘志',
        source_price: 10_098,
      })],
      new Map([['db-1', makeDbCard({ card_name: 'アイリスの闘志' })]]),
      '2026-07-23',
      pricingSettings,
    );

    expect(result[0].price_high).toBe(9_500);
  });

  it.each<[Franchise, number, number]>([
    ['Pokemon', 44_000, 38_000],
    ['ONE PIECE', 44_000, 38_000],
    ['YU-GI-OH!', 42_000, 35_000],
    ['WEISS SCHWARZ', 47_000, 43_500],
    ['DRAGON BALL', 47_000, 43_500],
  ])('%s はMANMAN既定の商材別率で価格を計算する', (franchise, expectedHigh, expectedLow) => {
    const raw = makeRawImport({ franchise });
    const result = prepareOrderListCards(
      [raw],
      new Map([['db-1', makeDbCard({ franchise })]]),
      '2026-07-14',
    );

    expect(result[0].price_high).toBe(expectedHigh);
    expect(result[0].price_low).toBe(expectedLow);
  });

  it('ドラゴンボールのシングルはPSAと同じ非BOX率を使い、種別を保持する', () => {
    const result = prepareOrderListCards(
      [makeRawImport({ franchise: 'DRAGON BALL', grade: 'シングル' })],
      new Map([['db-1', makeDbCard({ franchise: 'DRAGON BALL', grade: 'シングル' })]]),
      '2026-08-19',
    );

    expect(result[0]).toMatchObject({
      franchise: 'DRAGON BALL',
      grade: 'シングル',
      price_high: 47_000,
      price_low: 43_500,
    });
  });

  it('新2商材のBOX上限も設定の7%引きを使い、既存下限の計算は維持する', () => {
    const pricingSettings = {
      ...DEFAULT_STORE_PRICING_SETTINGS,
      box_discount_rates: {
        ...DEFAULT_STORE_PRICING_SETTINGS.box_discount_rates,
        'WEISS SCHWARZ': { shrink: 0.07, no_shrink: 0.13 },
      },
    };
    const result = prepareOrderListCards(
      [makeRawImport({
        franchise: 'WEISS SCHWARZ',
        grade: 'BOX',
        source_price: 78_540,
      })],
      new Map([['db-1', makeDbCard({ franchise: 'WEISS SCHWARZ', grade: 'BOX' })]]),
      '2026-08-19',
      pricingSettings,
    );

    expect(result[0]).toMatchObject({
      price_high: 73_000,
      price_low: 68_000,
    });
  });

  it('Excel画像をprimary、DBの代替画像をfallbackとして保持する', () => {
    const result = prepareOrderListCards(
      [makeRawImport()],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    );

    expect(result[0]).toMatchObject({
      run_id: 'run-1',
      raw_import_id: 'raw-1',
      order_list_item_id: 'item-1',
      excel_product_id: 'excel-1',
      db_card_id: 'db-1',
      image_url: 'https://excel.example/card.jpg',
      alt_image_url: 'https://db.example/alternative.jpg',
      rarity_icon_url: 'https://db.example/rarity.png',
      tag: 'TOP',
      source: 'order_list',
      price_source: 'order_list',
      price_source_date: '2026-07-14',
    });
  });

  it('DBの代替画像がなければDBの通常画像へfallbackする', () => {
    const result = prepareOrderListCards(
      [makeRawImport()],
      new Map([['db-1', makeDbCard({ alt_image_url: null })]]),
      '2026-07-14',
    );

    expect(result[0].alt_image_url).toBe('https://db.example/card.jpg');
  });

  it('order_list の source_price がなければ旧KECAK価格を使用しない', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ source_price: null, kecak_price: 100_000 })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('オーダーリスト価格がありません');
  });

  it('BOX価格DB未登録のPokemon BOXは0円で監査対象に残す', () => {
    const result = prepareOrderListCards(
      [makeRawImport({
        card_name: '【BOX】未登録BOX',
        grade: 'BOX',
        source_price: null,
        raw_row: { pokemon_box_price_source: 'missing' },
      })],
      new Map([['db-1', makeDbCard({ card_name: '未登録BOX', grade: 'BOX', tag: 'BOX' })]]),
      '2026-07-14',
    );

    expect(result[0]).toMatchObject({
      price_high: 0,
      price_low: 0,
      tag: 'BOX',
    });
  });

  it('BOX価格DB未登録でもExcel価格があればPokemon BOX価格を計算する', () => {
    const result = prepareOrderListCards(
      [makeRawImport({
        card_name: '【BOX】未登録BOX',
        grade: 'BOX',
        source_price: 100_000,
        raw_row: { pokemon_box_price_source: 'ORDER_LIST_FALLBACK' },
      })],
      new Map([['db-1', makeDbCard({ card_name: '未登録BOX', grade: 'BOX', tag: 'BOX' })]]),
      '2026-07-14',
    );

    expect(result[0]).toMatchObject({
      price_high: 100_000,
      price_low: 85_000,
      tag: 'BOX',
    });
  });

  it('db_card_id がない行を名前照合で補完せず失敗させる', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ db_card_id: null })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('db_card_id がありません');
  });

  it('永続対応先が消えている行を名前照合で補完せず失敗させる', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ db_card_id: 'missing-db' })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('対応先DB商品が見つかりません');
  });
});
