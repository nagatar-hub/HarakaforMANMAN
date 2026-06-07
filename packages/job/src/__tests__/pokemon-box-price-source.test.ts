import {
  applyPokemonBoxPriceOverrides,
  normalizePokemonBoxProductName,
  parsePokemonBoxPriceRows,
} from '../lib/pokemon-box-price-source';
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

describe('parsePokemonBoxPriceRows', () => {
  it('DatabaseシートのBOX行から商品名とD列の買取価格を読み取る', () => {
    const priceMap = parsePokemonBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/box', '20,000'],
      ['パック', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/pack', '1,000'],
    ]);

    expect(priceMap.get('拡張パック「ブラックボルト」(SV11B)')).toBe(20000);
    expect(priceMap.get('ブラックボルト')).toBe(20000);
  });

  it('KECAKの[1BOX]表記とBOX価格DBの商品名を同じ照合名に正規化する', () => {
    expect(normalizePokemonBoxProductName('[1BOX]ホワイトフレア')).toBe('ホワイトフレア');
    expect(normalizePokemonBoxProductName('拡張パック「ホワイトフレア」(SV11W)')).toBe('ホワイトフレア');
  });
});

describe('applyPokemonBoxPriceOverrides', () => {
  it('KECAKのPokemon BOX行はBOX価格DBの価格へ差し替える', () => {
    const priceMap = parsePokemonBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ブラックボルト」(SV11B)', 'https://example.com/box', '20,000'],
    ]);

    const result = applyPokemonBoxPriceOverrides(
      [makeRawImport()],
      priceMap,
    );

    expect(result.rows[0].kecak_price).toBe(20000);
    expect(result.missingNames).toEqual([]);
  });

  it('KECAKのgrade=BOX行はBOX価格DBの価格へ差し替える', () => {
    const priceMap = parsePokemonBoxPriceRows([
      ['\\', '商品名', '画像URL', '買取価格'],
      ['BOX', '拡張パック「ホワイトフレア」(SV11W)', 'https://example.com/box', '19,000'],
    ]);

    const result = applyPokemonBoxPriceOverrides(
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
    const result = applyPokemonBoxPriceOverrides(
      [makeRawImport({ card_name: '【BOX】未登録BOX', kecak_price: 99999 })],
      new Map(),
    );

    expect(result.rows[0].kecak_price).toBeNull();
    expect(result.missingNames).toEqual(['未登録BOX']);
  });

  it('カード名にボックスを含むPSA行はBOX価格差し替え対象にしない', () => {
    const row = makeRawImport({
      card_name: 'ピカチュウ(プレシャスコレクターボックス)',
      grade: 'PSA10',
      kecak_price: 127000,
    });

    const result = applyPokemonBoxPriceOverrides([row], new Map([['プレシャスコレクターボックス', 1]]));

    expect(result.rows[0].kecak_price).toBe(127000);
    expect(result.missingNames).toEqual([]);
  });

  it('非BOX行とPokemon以外のBOX行は変更しない', () => {
    const rows = [
      makeRawImport({ card_name: 'リザードン', kecak_price: 50000 }),
      makeRawImport({ franchise: 'ONE PIECE', card_name: '【BOX】頂上決戦', kecak_price: 30000 }),
    ];

    const result = applyPokemonBoxPriceOverrides(rows, new Map());

    expect(result.rows.map(row => row.kecak_price)).toEqual([50000, 30000]);
    expect(result.missingNames).toEqual([]);
  });
});
