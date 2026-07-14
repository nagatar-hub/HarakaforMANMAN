/**
 * page-planner のユニットテスト
 *
 * layout_template[] を引数に取る新仕様版。
 */

import { planPages } from '../lib/page-planner';
import type {
  PreparedCardRow,
  RuleRow,
  LayoutTemplateRow,
  LayoutConfig,
} from '@haraka/shared';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: `card-${Math.random().toString(36).slice(2, 10)}`,
    run_id: 'run-1',
    raw_import_id: null,
    order_list_item_id: null,
    excel_product_id: null,
    db_card_id: null,
    franchise: 'Pokemon',
    card_name: 'テストカード',
    grade: 'PSA10',
    list_no: 'A-001',
    image_url: 'https://example.com/card.jpg',
    alt_image_url: null,
    rarity: null,
    rarity_icon_url: null,
    tag: null,
    price_high: 10000,
    price_low: 8000,
    image_status: 'unchecked',
    source: 'kecak',
    price_source: 'kecak',
    price_source_date: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 8)}`,
    store: 'manman',
    franchise: 'Pokemon',
    tag_pattern: 'TOP',
    match_type: 'exact',
    behavior: 'isolate',
    priority: 100,
    notes: null,
    group_key: null,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLayout(slots: number, overrides: Partial<LayoutTemplateRow> = {}): LayoutTemplateRow {
  const minimal: LayoutConfig = {
    startX: 0, priceStartX: 0, colWidth: 0, cardWidth: 0, cardHeight: 0,
    isSmallCard: false, rows: [], priceBoxWidth: 0, priceBoxHeight: 0,
    dateX: 0, dateY: 0,
  };
  return {
    id: `layout-${slots}`,
    store: 'oripark',
    kind: 'postal',
    franchise: 'Pokemon',
    name: `${slots}枠`,
    slug: `grid_${slots}`,
    grid_cols: 1,
    grid_rows: slots,
    total_slots: slots,
    img_width: 1240,
    img_height: 1760,
    template_storage_path: `templates/pokemon/${slots}.png`,
    card_back_storage_path: 'card-backs/pokemon.png',
    layout_config: minimal,
    skip_price_low: false,
    is_default: slots === 40,
    is_active: true,
    priority: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const LAYOUTS = [1, 2, 4, 6, 9, 15, 20, 40].map(n => makeLayout(n));

// ---------------------------------------------------------------------------

describe('planPages - 基本動作', () => {
  it('カード 0 件なら空配列', () => {
    expect(planPages([], [], LAYOUTS)).toHaveLength(0);
  });

  it('レイアウト 0 件なら空配列', () => {
    const cards = [makeCard({ id: 'c1', tag: 'A' })];
    expect(planPages(cards, [], [])).toHaveLength(0);
  });

  it('ルールなし: メインタグごとに単ページ最小レイアウトが選ばれる', () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      makeCard({ id: `card-${i}`, tag: 'A', price_high: (5 - i) * 1000 }),
    );
    const result = planPages(cards, [], LAYOUTS);
    // 5 枚 → [6] で単ページ（残り 1 枠は呼び出し側でカード裏面で埋める）
    expect(result).toHaveLength(1);
    expect(result[0].cardIds).toHaveLength(5);
    expect(result[0].cardIds[0]).toBe('card-0'); // price_high=5000 が先頭
    expect(result[0].layoutTemplateId).toBe('layout-6');
  });

  it('40 枚超のタグはページ数最小で複数ページに分割される', () => {
    // 62 枚 → [40, 40]（pc=2 最優先、余剰 18 はカード裏面で埋める）
    const cards = Array.from({ length: 62 }, (_, i) =>
      makeCard({ id: `p-${i}`, tag: 'ピカチュウ', price_high: 100000 - i }),
    );
    const result = planPages(cards, [], LAYOUTS);
    expect(result).toHaveLength(2);
    const sizes = result.map(p => p.cardIds.length);
    expect(sizes).toEqual([40, 22]);
    // 最高額 p-0 は最初の 40 枠ページ先頭
    expect(result[0].cardIds[0]).toBe('p-0');
    expect(result[0].layoutTemplateId).toBe('layout-40');
    expect(result[1].layoutTemplateId).toBe('layout-40');
  });
});

describe('planPages - isolate ルール', () => {
  it('tag exact マッチで専用ページ群に分離される', () => {
    const topCards = [
      makeCard({ id: 'top-1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'top-2', tag: 'TOP', price_high: 30000 }),
    ];
    const other = [makeCard({ id: 'gen-1', tag: 'OTHER', price_high: 10000 })];
    const rules = [makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate', priority: 100 })];

    const result = planPages([...topCards, ...other], rules, LAYOUTS);

    const top = result.find(p => p.label === 'TOP');
    const otherPage = result.find(p => p.label === 'OTHER');
    expect(top).toBeDefined();
    expect(top!.cardIds).toHaveLength(2);
    // 2 枚 → layout 2 が選ばれる
    expect(top!.layoutTemplateId).toBe('layout-2');

    expect(otherPage).toBeDefined();
    expect(otherPage!.cardIds).toHaveLength(1);
    expect(otherPage!.layoutTemplateId).toBe('layout-1');
  });

  it('isolate ページ内のカードは price_high 降順', () => {
    const cards = [
      makeCard({ id: 'low', tag: 'TOP', price_high: 5000 }),
      makeCard({ id: 'high', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'mid', tag: 'TOP', price_high: 20000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'TOP', behavior: 'isolate' })];

    const result = planPages(cards, rules, LAYOUTS);
    // 3 枚 → [4]（単ページ、余剰 1 はカード裏面）
    const pages = result.filter(p => p.label.startsWith('TOP'));
    expect(pages).toHaveLength(1);
    expect(pages[0].layoutTemplateId).toBe('layout-4');
    expect(pages[0].cardIds).toEqual(['high', 'mid', 'low']);
  });

  it('contains マッチで tag 部分一致のカードを分離する', () => {
    const cards = [
      makeCard({ id: 'c1', tag: 'リザードンex', price_high: 50000 }),
      makeCard({ id: 'c2', tag: 'リザードンV', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'ピカチュウ', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'リザードン', match_type: 'contains', behavior: 'isolate' })];

    const result = planPages(cards, rules, LAYOUTS);
    const page = result.find(p => p.label === 'リザードン')!;
    expect(page.cardIds).toHaveLength(2);
  });
});

describe('planPages - exclude ルール', () => {
  it('exclude でマッチしたカードはページに含まれない', () => {
    const cards = [
      makeCard({ id: 'keep-1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'drop-1', tag: 'サンプル', price_high: 100 }),
      makeCard({ id: 'keep-2', tag: 'OTHER', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'サンプル', behavior: 'exclude', priority: 100 })];

    const result = planPages(cards, rules, LAYOUTS);
    const ids = result.flatMap(p => p.cardIds);
    expect(ids).not.toContain('drop-1');
    expect(ids).toHaveLength(2);
  });
});

describe('planPages - group ルール（タグ跨ぎ集約）', () => {
  it('group_key が同じ rule 群のカードを 1 グループとして扱う', () => {
    const cards = [
      makeCard({ id: 'a', tag: '25th', price_high: 100000 }),
      makeCard({ id: 'b', tag: 'XY', price_high: 80000 }),
      makeCard({ id: 'c', tag: 'BWR', price_high: 60000 }),
    ];
    const rules = [
      makeRule({ tag_pattern: '25th', behavior: 'group', group_key: '25th_XY_BWR', priority: 80 }),
      makeRule({ tag_pattern: 'XY', behavior: 'group', group_key: '25th_XY_BWR', priority: 80 }),
      makeRule({ tag_pattern: 'BWR', behavior: 'group', group_key: '25th_XY_BWR', priority: 80 }),
    ];

    const result = planPages(cards, rules, LAYOUTS);
    const group = result.filter(p => p.label.startsWith('25th_XY_BWR'));
    expect(group.length).toBeGreaterThanOrEqual(1);
    // 3 枚 → [4]（単ページ、余剰 1）
    expect(group).toHaveLength(1);
    expect(group[0].layoutTemplateId).toBe('layout-4');
    // rule 順 (25th, XY, BWR) かつ各タグ内で価格降順 → a, b, c
    expect(group[0].cardIds).toEqual(['a', 'b', 'c']);
  });
});

describe('planPages - priority 順序', () => {
  it('priority が高いルールが先に適用される', () => {
    const cards = [
      makeCard({ id: 'c1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'c2', tag: 'BOX', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'OTHER', price_high: 10000 }),
    ];
    const rules = [
      makeRule({ tag_pattern: 'BOX', behavior: 'isolate', priority: 90 }),
      makeRule({ tag_pattern: 'TOP', behavior: 'isolate', priority: 100 }),
    ];

    const result = planPages(cards, rules, LAYOUTS);
    expect(result[0].label).toBe('TOP');
    expect(result[1].label).toBe('BOX');
    expect(result[2].label).toBe('OTHER');
  });
});

describe('planPages - タグなしカード', () => {
  it('tag null のカードは「その他」ラベルでページ化される', () => {
    const cards = [
      makeCard({ id: 'tagged', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'untagged', tag: null, price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'TOP', behavior: 'isolate' })];

    const result = planPages(cards, rules, LAYOUTS);
    const other = result.find(p => p.label === 'その他');
    expect(other).toBeDefined();
    expect(other!.cardIds).toContain('untagged');
  });
});

describe('planPages - regex マッチ', () => {
  it('regex マッチのカードを isolate', () => {
    const cards = [
      makeCard({ id: 'c1', tag: '青眼の白龍', price_high: 50000 }),
      makeCard({ id: 'c2', tag: '青眼の究極竜', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'ブラマジ', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: '^青眼', match_type: 'regex', behavior: 'isolate' })];

    const result = planPages(cards, rules, LAYOUTS);
    const page = result.find(p => p.label === '^青眼')!;
    expect(page.cardIds).toHaveLength(2);
  });
});
