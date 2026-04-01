/**
 * page-planner のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/page-planner.ts に書く
 */

import { planPages } from '../lib/page-planner';
import type { PreparedCardRow, RuleRow } from '@haraka/shared';

/** テスト用 PreparedCard を生成 */
function makeCard(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: `card-${Math.random().toString(36).slice(2, 8)}`,
    run_id: 'run-1',
    raw_import_id: null,
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
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** テスト用 Rule を生成 */
function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 8)}`,
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

const TOTAL_SLOTS = 40; // 8cols × 5rows

describe('planPages - 基本動作', () => {
  it('カードが 0 件のとき空配列を返す', () => {
    const result = planPages([], [], TOTAL_SLOTS);
    expect(result).toHaveLength(0);
  });

  it('ルールなし: カードを price_high 降順で 40 件ずつ一般ページにまとめる', () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      makeCard({ id: `card-${i}`, price_high: (5 - i) * 1000 })
    );
    const result = planPages(cards, [], TOTAL_SLOTS);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('general-1');
    // price_high 降順: 5000, 4000, 3000, 2000, 1000
    expect(result[0].cardIds[0]).toBe('card-0'); // price_high=5000
    expect(result[0].cardIds[4]).toBe('card-4'); // price_high=1000
  });

  it('40 件を超えるカードは複数ページに分割される', () => {
    const cards = Array.from({ length: 45 }, (_, i) =>
      makeCard({ id: `card-${i}`, price_high: 100000 - i })
    );
    const result = planPages(cards, [], TOTAL_SLOTS);
    expect(result).toHaveLength(2);
    expect(result[0].cardIds).toHaveLength(40);
    expect(result[1].cardIds).toHaveLength(5);
    expect(result[0].label).toBe('general-1');
    expect(result[1].label).toBe('general-2');
  });
});

describe('planPages - isolate ルール', () => {
  it('exact マッチ: tag が完全一致するカードを専用ページに分離する', () => {
    const topCards = [
      makeCard({ id: 'top-1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'top-2', tag: 'TOP', price_high: 30000 }),
    ];
    const generalCards = [
      makeCard({ id: 'gen-1', tag: 'OTHER', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate', priority: 100 })];

    const result = planPages([...topCards, ...generalCards], rules, TOTAL_SLOTS);

    // TOP ページが先（priority が高い）
    const topPage = result.find(p => p.label === 'TOP');
    const generalPage = result.find(p => p.label.startsWith('general'));
    expect(topPage).toBeDefined();
    expect(topPage!.cardIds).toHaveLength(2);
    expect(generalPage).toBeDefined();
    expect(generalPage!.cardIds).toHaveLength(1);
  });

  it('contains マッチ: tag に部分一致するカードを分離する', () => {
    const cards = [
      makeCard({ id: 'c1', tag: 'リザードンex', price_high: 50000 }),
      makeCard({ id: 'c2', tag: 'リザードンV', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'ピカチュウ', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'リザードン', match_type: 'contains', behavior: 'isolate' })];

    const result = planPages(cards, rules, TOTAL_SLOTS);

    const charizardPage = result.find(p => p.label === 'リザードン');
    expect(charizardPage).toBeDefined();
    expect(charizardPage!.cardIds).toHaveLength(2);
  });

  it('isolate ページ内のカードは price_high 降順', () => {
    const cards = [
      makeCard({ id: 'low', tag: 'TOP', price_high: 5000 }),
      makeCard({ id: 'high', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'mid', tag: 'TOP', price_high: 20000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate' })];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    const topPage = result.find(p => p.label === 'TOP')!;
    expect(topPage.cardIds[0]).toBe('high');
    expect(topPage.cardIds[1]).toBe('mid');
    expect(topPage.cardIds[2]).toBe('low');
  });

  it('isolate で 40 件超えは複数ページに分割される', () => {
    const cards = Array.from({ length: 45 }, (_, i) =>
      makeCard({ id: `top-${i}`, tag: 'TOP', price_high: 100000 - i })
    );
    const rules = [makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate' })];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    const topPages = result.filter(p => p.label.startsWith('TOP'));
    expect(topPages).toHaveLength(2);
    expect(topPages[0].cardIds).toHaveLength(40);
    expect(topPages[1].cardIds).toHaveLength(5);
  });
});

describe('planPages - exclude ルール', () => {
  it('exclude: マッチしたカードをページから除外する', () => {
    const cards = [
      makeCard({ id: 'keep-1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'exclude-1', tag: 'サンプル', price_high: 100 }),
      makeCard({ id: 'keep-2', tag: 'OTHER', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'サンプル', match_type: 'exact', behavior: 'exclude', priority: 100 })];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    const allCardIds = result.flatMap(p => p.cardIds);
    expect(allCardIds).not.toContain('exclude-1');
    expect(allCardIds).toHaveLength(2);
  });
});

describe('planPages - priority 順序', () => {
  it('priority が高いルールが先に処理される', () => {
    const cards = [
      makeCard({ id: 'c1', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'c2', tag: 'BOX', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'OTHER', price_high: 10000 }),
    ];
    const rules = [
      makeRule({ tag_pattern: 'BOX', match_type: 'exact', behavior: 'isolate', priority: 90 }),
      makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate', priority: 100 }),
    ];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    // TOP (priority 100) が先に処理 → ページ順も TOP → BOX → general
    expect(result[0].label).toBe('TOP');
    expect(result[1].label).toBe('BOX');
    expect(result[2].label).toBe('general-1');
  });
});

describe('planPages - tag が null のカード', () => {
  it('tag が null のカードはルールにマッチせず一般ページに入る', () => {
    const cards = [
      makeCard({ id: 'tagged', tag: 'TOP', price_high: 50000 }),
      makeCard({ id: 'untagged', tag: null, price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: 'TOP', match_type: 'exact', behavior: 'isolate' })];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    const generalPage = result.find(p => p.label.startsWith('general'));
    expect(generalPage).toBeDefined();
    expect(generalPage!.cardIds).toContain('untagged');
  });
});

describe('planPages - regex マッチ', () => {
  it('regex: 正規表現でマッチするカードを分離する', () => {
    const cards = [
      makeCard({ id: 'c1', tag: '青眼の白龍', price_high: 50000 }),
      makeCard({ id: 'c2', tag: '青眼の究極竜', price_high: 30000 }),
      makeCard({ id: 'c3', tag: 'ブラマジ', price_high: 10000 }),
    ];
    const rules = [makeRule({ tag_pattern: '^青眼', match_type: 'regex', behavior: 'isolate' })];

    const result = planPages(cards, rules, TOTAL_SLOTS);
    const blueEyesPage = result.find(p => p.label === '^青眼');
    expect(blueEyesPage).toBeDefined();
    expect(blueEyesPage!.cardIds).toHaveLength(2);
  });
});
