import {
  applyShinsokuBoxPriceOverrides,
  normalizeShinsokuBoxProductName,
  parseShinsokuBoxPriceRows,
  applyCurrentShinsokuBoxPrices,
} from '../lib/shinsoku-box-price-source';
import { normalizeStorePricingSettings } from '@haraka/shared';
import type { Database } from '@haraka/shared';

type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];

function makeRawImport(overrides: Partial<RawImportInsert> = {}): RawImportInsert {
  return {
    run_id: 'run-1',
    franchise: 'Pokemon',
    card_name: '【BOX】拡張パック「ブラックボルト」(SV11B)',
    grade: null,
    list_no: null,
    image_url: null,
    rarity: null,
    demand: null,
    kecak_price: 99999,
    raw_row: null,
    ...overrides,
  };
}

describe('parseShinsokuBoxPriceRows', () => {
  it('全商材のraw S価格を保持し、設定の7%引きを再生成でも一度だけ適用する', () => {
    const sources = [
      ['ポケモン', 'Pokemon'], ['ワンピース', 'ONE PIECE'], ['遊戯王', 'YU-GI-OH!'],
      ['DB', 'DRAGON BALL'], ['ヴァイスシュヴァルツ', 'WEISS SCHWARZ'],
    ];
    const prices = parseShinsokuBoxPriceRows([
      ['', '商品名', '画像URL', '買取価格', 'ブランド'],
      ...sources.map(([brand], i) => ['BOX', '共通商品', '', String(100000 + i * 10000), brand]),
    ]);
    const settings = normalizeStorePricingSettings({ box_discount_rates: Object.fromEntries(
      sources.map(([, franchise]) => [franchise, { shrink: 0.07, no_shrink: 0.15 }]),
    ) });
    const cards = sources.map(([, franchise]) => ({
      franchise, card_name: '[1BOX]共通商品', grade: 'BOX', price_high: 1, price_low: 1,
    }));
    const first = applyCurrentShinsokuBoxPrices(cards, prices, settings);
    expect(first.map(card => card.price_high)).toEqual([93000, 102000, 111000, 120000, 130000]);
    expect(applyCurrentShinsokuBoxPrices(first, prices, settings)).toEqual(first);
    expect(prices.get('共通商品')).toBe(100000);
    expect(first[0].price_low).toBe(85000);
    settings.box_discount_rates.Pokemon.shrink = 0.05;
    expect(applyCurrentShinsokuBoxPrices(first, prices, settings)[0].price_high).toBe(95000);
  });

  it('欠損BOXを0円の監査行にし、復帰時はrawから再計算する', () => {
    const settings = normalizeStorePricingSettings({ box_discount_rates: { Pokemon: { shrink: 0.07, no_shrink: 0.15 } } });
    const cards = [
      { franchise: 'Pokemon', card_name: '[1BOX]未登録', grade: 'BOX', price_high: 99999, price_low: 8500 },
      { franchise: 'Pokemon', card_name: 'PSA', grade: 'PSA10', price_high: 12345, price_low: 12000 },
    ];
    const missing = applyCurrentShinsokuBoxPrices(cards, new Map(), settings);
    expect(missing.map(card => card.price_high)).toEqual([0, 12345]);
    expect(missing[0].price_low).toBe(8500);
    expect(applyCurrentShinsokuBoxPrices(missing, new Map([['未登録', 20000]]), settings)[0])
      .toMatchObject({ price_high: 18000, price_low: 17000 });
  });

  it.each(['', '0', '¥0'])('空欄・0円は個別除外する: %s', (price) => {
    const prices = parseShinsokuBoxPriceRows([
      ['', '商品名', '画像URL', '買取価格'],
      ['BOX', '欠損', '', price], ['BOX', '有効', '', '20000'],
    ]);
    expect(prices.has('欠損')).toBe(false);
    expect(prices.get('有効')).toBe(20000);
  });

  it('壊れた価格は欠損扱いで公開せず取得全体を拒否する', () => {
    expect(() => parseShinsokuBoxPriceRows([
      ['', '商品名', '画像URL', '買取価格'], ['BOX', '破損', '', 'invalid1200'],
    ])).toThrow('price is invalid');
  });

  it('DBの末尾コードを正規化し、他商材の同名価格を使わない', () => {
    const prices = parseShinsokuBoxPriceRows([
      ['', '商品名', '画像URL', '買取価格', 'ブランド'],
      ['BOX', 'CROSS FORCE FB10', '', '12600', 'DB'],
    ]);
    expect(prices.get('DRAGON BALL:crossforce')).toBe(12600);
    expect(prices.has('crossforce')).toBe(false);
  });
  it('DatabaseシートのBOX行から商品名とD列の買取価格を読み取る', () => {
    const priceMap = parseShinsokuBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/box', '20,000'],
      ['パック', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/pack', '1,000'],
    ]);

    expect(priceMap.get('拡張パック「ブラックボルト」(SV11B)')).toBe(20000);
    expect(priceMap.get('ブラックボルト')).toBe(20000);
  });

  it('KECAKの[1BOX]表記とBOX価格DBの商品名を同じ照合名に正規化する', () => {
    expect(normalizeShinsokuBoxProductName('[1BOX]ホワイトフレア')).toBe('ホワイトフレア');
    expect(normalizeShinsokuBoxProductName('拡張パック「ホワイトフレア」(SV11W)')).toBe('ホワイトフレア');
    expect(normalizeShinsokuBoxProductName('拡張パックデラックス「ホワイトフレア」(SV11W)'))
      .toBe('ホワイトフレア|deluxe');
  });

  it('25th ゴールデンボックスの日英表記を年数を残して同じ照合名に正規化する', () => {
    const orderListName = normalizeShinsokuBoxProductName('[1BOX]25th ゴールデンボックス');
    expect(orderListName).toBe('25thgolden');
    expect(normalizeShinsokuBoxProductName('25th ANNIVERSARY GOLDEN BOX')).toBe(orderListName);
    expect(normalizeShinsokuBoxProductName('20th ANNIVERSARY GOLDEN BOX')).not.toBe(orderListName);

    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport({
        card_name: '[1BOX]25th ゴールデンボックス',
        grade: 'BOX',
        kecak_price: null,
        source_price: 99999,
        price_source: 'order_list',
      })],
      parseShinsokuBoxPriceRows([
        ['\\', '商品名', '画像URL', '買取価格'],
        ['BOX', '25th ANNIVERSARY GOLDEN BOX', 'https://example.com/golden', '250,000'],
      ]),
    );
    expect(result.rows[0].source_price).toBe(250_000);
    expect(result.missingNames).toEqual([]);
  });
});

describe('applyShinsokuBoxPriceOverrides', () => {
  it('KECAKのPokemon BOX行はBOX価格DBの価格へ差し替える', () => {
    const priceMap = parseShinsokuBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/box', '20,000'],
    ]);

    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport()],
      priceMap,
    );

    expect(result.rows[0].kecak_price).toBe(20000);
    expect(result.missingNames).toEqual([]);
  });

  it('KECAKのgrade=BOX行はBOX価格DBの価格へ差し替える', () => {
    const priceMap = parseShinsokuBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ホワイトフレア」(SV11W)', 'https://example.com/box', '19,000'],
    ]);

    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport({
        card_name: '[1BOX]ホワイトフレア',
        grade: 'BOX',
        kecak_price: 21500,
      })],
      priceMap,
    );

    expect(result.rows[0].kecak_price).toBe(19000);
    expect(result.rows[0].raw_row).toMatchObject({
      pokemon_box_price_lookup_name: 'ホワイトフレア',
      pokemon_box_original_kecak_price: 21500,
    });
    expect(result.missingNames).toEqual([]);
  });

  it('BOX価格DBにないPokemon BOX行はフォールバックせず価格なしにする', () => {
    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport({ card_name: '【BOX】未登録BOX', kecak_price: 99999 })],
      new Map(),
    );

    expect(result.rows[0].kecak_price).toBeNull();
    expect(result.missingNames).toEqual(['未登録']);
  });

  it('オーダーリストのPokemon BOX行はsource_priceをBOX価格DBの価格へ差し替える', () => {
    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport({
        card_name: '[1BOX]ホワイトフレア',
        grade: 'BOX',
        kecak_price: null,
        source_price: 21500,
        price_source: 'order_list',
        raw_row: { 商品ID: 'excel-1' },
      })],
      new Map([['ホワイトフレア', 19000]]),
    );

    expect(result.rows[0]).toMatchObject({
      kecak_price: null,
      source_price: 19000,
      price_source: 'order_list',
      raw_row: {
        商品ID: 'excel-1',
        pokemon_box_price_source: 'BOX_PRICE_DB',
        pokemon_box_price_lookup_name: 'ホワイトフレア',
        pokemon_box_original_order_list_price: 21500,
      },
    });
    expect(result.missingNames).toEqual([]);
  });

  it('BOX価格DBにないオーダーリストのBOX行はExcel価格へ戻さず監査情報だけ保持する', () => {
    const result = applyShinsokuBoxPriceOverrides(
      [makeRawImport({
        card_name: '【BOX】未登録BOX',
        kecak_price: null,
        source_price: 99999,
        price_source: 'order_list',
      })],
      new Map(),
    );

    expect(result.rows[0]).toMatchObject({
      kecak_price: null,
      source_price: null,
      price_source: 'order_list',
      raw_row: {
        pokemon_box_price_source: 'missing',
        pokemon_box_price_lookup_name: '未登録',
        pokemon_box_original_order_list_price: 99999,
      },
    });
    expect(result.missingNames).toEqual(['未登録']);
  });

  it('オーダーリストの非BOXは変更せず、別商材のBOXも生S価格を使用する', () => {
    const rows = [
      makeRawImport({ card_name: 'リザードン', kecak_price: null, source_price: 50000, price_source: 'order_list' }),
      makeRawImport({ franchise: 'ONE PIECE', card_name: '【BOX】頂上決戦', kecak_price: null, source_price: 30000, price_source: 'order_list' }),
    ];

    const result = applyShinsokuBoxPriceOverrides(rows, new Map([['ONE PIECE:頂上決戦', 20000]]));

    expect(result.rows[0]).toEqual(rows[0]);
    expect(result.rows[1].source_price).toBe(20000);
    expect(result.missingNames).toEqual([]);
  });

  it('カード名にボックスを含むPSA行はBOX価格差し替え対象にしない', () => {
    const row = makeRawImport({
      card_name: 'ピカチュウ(プレシャスコレクターボックス)',
      grade: 'PSA10',
      kecak_price: 127000,
    });

    const result = applyShinsokuBoxPriceOverrides([row], new Map([['プレシャスコレクターボックス', 1]]));

    expect(result.rows[0].kecak_price).toBe(127000);
    expect(result.missingNames).toEqual([]);
  });

  it('非BOX行は変更せず、別商材のBOXでも元価格を減額しない', () => {
    const rows = [
      makeRawImport({ card_name: 'リザードン', kecak_price: 50000 }),
      makeRawImport({ franchise: 'ONE PIECE', card_name: '【BOX】頂上決戦', kecak_price: 30000 }),
    ];

    const result = applyShinsokuBoxPriceOverrides(rows, new Map([['ONE PIECE:頂上決戦', 20000]]));

    expect(result.rows.map(row => row.kecak_price)).toEqual([50000, 20000]);
    expect(result.missingNames).toEqual([]);
  });
});
