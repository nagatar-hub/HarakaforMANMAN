/**
 * prepareCards のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/prepare-cards.ts に書く
 */

import type { LookupMap, LookupResult } from '../lib/db-lookup';

// db-lookup モジュールをモック化
jest.mock('../lib/db-lookup', () => ({
  lookupCard: jest.fn(),
}));

import { lookupCard } from '../lib/db-lookup';
import { prepareCards } from '../lib/prepare-cards';
import type { Database } from '@haraka/shared';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];

const mockLookupCard = lookupCard as jest.MockedFunction<typeof lookupCard>;

/** テスト用の基本 RawImportRow を生成 */
function makeRawImport(overrides: Partial<RawImportRow> = {}): RawImportRow {
  return {
    id: 'raw-1',
    run_id: 'run-1',
    franchise: 'Pokemon',
    card_name: 'リザードン',
    grade: null,
    list_no: 'A-001',
    image_url: 'https://example.com/card.jpg',
    rarity: null,
    demand: null,
    kecak_price: 10000,
    raw_row: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** テスト用の LookupResult を生成 */
function makeLookupResult(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    tag: 'リザードン【SR】',
    imageUrl: 'https://cdn.example.com/db-image.jpg',
    rarityIcon: '1',
    ...overrides,
  };
}

describe('prepareCards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DB照合がヒットした場合', () => {
    it('lookupCard の結果から tag / alt_image_url / rarity_icon_url を設定する', () => {
      const rawImport = makeRawImport();
      const lookupResult = makeLookupResult();
      mockLookupCard.mockReturnValue(lookupResult);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result).toHaveLength(1);
      expect(result[0].tag).toBe('リザードン【SR】');
      expect(result[0].alt_image_url).toBe('https://cdn.example.com/db-image.jpg');
      expect(result[0].rarity_icon_url).toBe('1');
    });

    it('price_high = kecak_price が設定される', () => {
      const rawImport = makeRawImport({ kecak_price: 10000 });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].price_high).toBe(10000);
    });

    it('price_low = calculateBuyPriceLow(10000, Pokemon) = 8000', () => {
      // 10000 は 9999 以下ではないため rate=0.80 適用
      // 10000 * 0.80 = 8000 → niceLowerBound(8000): raw=8000 < 10000, steps=[500], v=8000 → 8000
      const rawImport = makeRawImport({ kecak_price: 10000 });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].price_low).toBe(8000);
    });

    it('price_low = calculateBuyPriceLow(15000, Pokemon) = 12000', () => {
      // 15000 * 0.80 = 12000 → niceLowerBound(12000) = 12000（1000刻み）
      const rawImport = makeRawImport({ kecak_price: 15000 });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].price_low).toBe(12000);
    });

    it('price_low = calculateBuyPriceLow(50000, YU-GI-OH!) = 42000', () => {
      // 50000 * 0.85 = 42500
      // niceLowerBound(42500): 10000 <= 42500 < 100000 → steps=[1000,2000,5000]
      //   s=1000: v=42000, diff=500
      //   s=2000: v=42000, diff=500, step大 → bestV=42000
      //   s=5000: v=40000, diff=2500 → no update
      // 結果: 42000
      const rawImport = makeRawImport({ kecak_price: 50000, franchise: 'YU-GI-OH!' });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'YU-GI-OH!');

      expect(result[0].price_low).toBe(42000);
    });
  });

  describe('DB照合がヒットしなかった場合（null）', () => {
    it('tag は null になる', () => {
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].tag).toBeNull();
    });

    it('alt_image_url は null になる', () => {
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].alt_image_url).toBeNull();
    });

    it('rarity_icon_url は null になる', () => {
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].rarity_icon_url).toBeNull();
    });

    it('rarity は rawImport.rarity がそのまま使われる', () => {
      const rawImport = makeRawImport({ rarity: 'プリズマティックシークレット' });
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].rarity).toBe('プリズマティックシークレット');
    });
  });

  describe('kecak_price が null または 0 の場合', () => {
    it('kecak_price が null のとき price_high = 0, price_low = 0', () => {
      const rawImport = makeRawImport({ kecak_price: null });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].price_high).toBe(0);
      expect(result[0].price_low).toBe(0);
    });

    it('kecak_price が 0 のとき price_high = 0, price_low = 0', () => {
      const rawImport = makeRawImport({ kecak_price: 0 });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].price_high).toBe(0);
      expect(result[0].price_low).toBe(0);
    });
  });

  describe('デフォルト値', () => {
    it('image_status = "unchecked"', () => {
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].image_status).toBe('unchecked');
    });

    it('source = "kecak"', () => {
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].source).toBe('kecak');
    });

    it('raw_import_id = rawImport.id', () => {
      const rawImport = makeRawImport({ id: 'raw-xyz' });
      mockLookupCard.mockReturnValue(makeLookupResult());

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].raw_import_id).toBe('raw-xyz');
    });
  });

  describe('rawImport の基本フィールドが引き継がれる', () => {
    it('run_id, franchise, card_name, grade, list_no, image_url が引き継がれる', () => {
      const rawImport = makeRawImport({
        run_id: 'run-abc',
        franchise: 'ONE PIECE',
        card_name: 'ルフィ',
        grade: 'PSA10',
        list_no: 'B-002',
        image_url: 'https://example.com/luffy.jpg',
      });
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards([rawImport], { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'ONE PIECE');

      expect(result[0].run_id).toBe('run-abc');
      expect(result[0].franchise).toBe('ONE PIECE');
      expect(result[0].card_name).toBe('ルフィ');
      expect(result[0].grade).toBe('PSA10');
      expect(result[0].list_no).toBe('B-002');
      expect(result[0].image_url).toBe('https://example.com/luffy.jpg');
    });
  });

  describe('複数件の変換', () => {
    it('配列の件数が保持される', () => {
      const rawImports = [
        makeRawImport({ id: 'raw-1', card_name: 'カード1', kecak_price: 5000 }),
        makeRawImport({ id: 'raw-2', card_name: 'カード2', kecak_price: 20000 }),
        makeRawImport({ id: 'raw-3', card_name: 'カード3', kecak_price: null }),
      ];
      mockLookupCard.mockReturnValue(null);

      const result = prepareCards(rawImports, { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result).toHaveLength(3);
    });

    it('各レコードが独立して変換される', () => {
      const rawImports = [
        makeRawImport({ id: 'raw-1', card_name: 'カード1', kecak_price: 5000 }),
        makeRawImport({ id: 'raw-2', card_name: 'カード2', kecak_price: 20000 }),
      ];
      mockLookupCard
        .mockReturnValueOnce(makeLookupResult({ tag: 'タグ1' }))
        .mockReturnValueOnce(null);

      const result = prepareCards(rawImports, { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap, 'Pokemon');

      expect(result[0].raw_import_id).toBe('raw-1');
      expect(result[0].tag).toBe('タグ1');
      expect(result[1].raw_import_id).toBe('raw-2');
      expect(result[1].tag).toBeNull();
    });
  });

  describe('lookupCard の呼び出し', () => {
    it('各 rawImport に対して lookupCard が呼ばれる', () => {
      const mockMap = { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap;
      const rawImports = [
        makeRawImport({ id: 'raw-1' }),
        makeRawImport({ id: 'raw-2' }),
      ];
      mockLookupCard.mockReturnValue(null);

      prepareCards(rawImports, mockMap, 'Pokemon');

      expect(mockLookupCard).toHaveBeenCalledTimes(2);
    });

    it('lookupCard に lookupMap と card 情報が渡される', () => {
      const mockMap = { exact: new Map(), nameGrade: new Map(), nameOnly: new Map() } as LookupMap;
      const rawImport = makeRawImport();
      mockLookupCard.mockReturnValue(null);

      prepareCards([rawImport], mockMap, 'Pokemon');

      expect(mockLookupCard).toHaveBeenCalledWith(mockMap, {
        card_name: rawImport.card_name,
        grade: rawImport.grade,
        list_no: rawImport.list_no,
      });
    });
  });
});
