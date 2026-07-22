import type { PreparedCardRow } from '@haraka/shared';
import { deduplicateByListNo } from '../lib/dedup.js';

function card(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: 'card-1',
    run_id: 'run-1',
    raw_import_id: null,
    order_list_item_id: 'order-list-item-1',
    excel_product_id: 'excel-product-1',
    db_card_id: null,
    franchise: 'YU-GI-OH!',
    card_name: 'ブラック・マジシャン',
    grade: 'PSA10',
    list_no: 'QCAC-JP018',
    image_url: 'https://example.test/cards/black-magician-a.png',
    alt_image_url: null,
    rarity: 'QCSE',
    rarity_icon_url: null,
    tag: null,
    price_high: 100_000,
    price_low: null,
    image_status: 'unchecked',
    source: 'order_list',
    price_source: 'order_list',
    price_source_date: '2026-07-19',
    created_at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('deduplicateByListNo', () => {
  it('keeps different Excel products that share list number and grade but use different images', () => {
    const first = card({ id: 'first', excel_product_id: 'excel-a' });
    const alternateArt = card({
      id: 'alternate-art',
      excel_product_id: 'excel-b',
      image_url: 'https://example.test/cards/black-magician-b.png',
      price_high: 120_000,
    });

    expect(deduplicateByListNo([first, alternateArt])).toEqual([first, alternateArt]);
  });

  it('keeps metadata-identical alternate art rows', () => {
    const first = card({ id: 'first' });
    const second = card({
      id: 'second',
      excel_product_id: 'excel-b',
      image_url: 'https://example.test/cards/black-magician-b.png',
    });

    expect(deduplicateByListNo([first, second])).toHaveLength(2);
  });

  it('keeps distinct Excel products even when canonical image URLs are the same', () => {
    const lowerPrice = card({
      id: 'lower',
      order_list_item_id: 'order-list-item-lower',
      excel_product_id: 'excel-a',
      image_url: 'HTTPS://EXAMPLE.TEST/cards/black-magician-a.png/#old',
      price_high: 100_000,
    });
    const higherPrice = card({
      id: 'higher',
      order_list_item_id: 'order-list-item-higher',
      excel_product_id: 'excel-b',
      image_url: 'https://example.test/cards/black-magician-a.png#new',
      price_high: 120_000,
    });

    expect(deduplicateByListNo([lowerPrice, higherPrice])).toEqual([lowerPrice, higherPrice]);
  });

  it('uses excel_product_id when order_list_item_id is unavailable', () => {
    const first = card({
      id: 'first',
      order_list_item_id: null,
      excel_product_id: 'excel-a',
    });
    const second = card({
      id: 'second',
      order_list_item_id: null,
      excel_product_id: 'excel-b',
      price_high: 120_000,
    });
    const revisedSecond = card({
      id: 'revised-second',
      order_list_item_id: null,
      excel_product_id: 'excel-b',
      price_high: 110_000,
    });

    expect(deduplicateByListNo([first, second, revisedSecond])).toEqual([first, second]);
  });

  it('normalizes identity fields and canonical image URL variants before comparing sources', () => {
    const spectre = card({
      id: 'spectre-normalized',
      source: 'spectre',
      price_source: 'spectre',
      franchise: 'YU GI OH',
      card_name: '  ブラック・マジシャン  ',
      list_no: 'ｑｃａｃ－ｊｐ０１８',
      grade: ' psa-10 ',
      image_url: 'HTTPS://EXAMPLE.TEST/cards/black-magician-a.png/#old',
      price_high: 200_000,
    });
    const orderList = card({
      id: 'order-list-normalized',
      franchise: 'yu_gi_oh!',
      grade: 'PSA10',
      image_url: 'https://example.test/cards/black-magician-a.png#new',
      price_high: 100_000,
    });

    expect(deduplicateByListNo([spectre, orderList])).toEqual([orderList]);
  });

  it('keeps different KECAK and Spectre products that share a common image and grade', () => {
    const placeholderImage = 'https://example.test/cards/image-coming-soon.png';
    const kecak = card({
      id: 'kecak-blue-eyes',
      source: 'kecak',
      price_source: 'kecak',
      card_name: '青眼の白龍',
      list_no: 'QCCP-JP001',
      image_url: placeholderImage,
    });
    const spectre = card({
      id: 'spectre-dark-magician',
      source: 'spectre',
      price_source: 'spectre',
      card_name: 'ブラック・マジシャン',
      list_no: 'QCCU-JP001',
      image_url: placeholderImage,
    });

    expect(deduplicateByListNo([kecak, spectre])).toEqual([kecak, spectre]);
  });

  it('keeps products with the same list number and image when their names differ', () => {
    const kecak = card({
      id: 'kecak-first-product',
      source: 'kecak',
      price_source: 'kecak',
      card_name: 'プロモカード A',
      list_no: 'PROMO-001',
    });
    const spectre = card({
      id: 'spectre-second-product',
      source: 'spectre',
      price_source: 'spectre',
      card_name: 'プロモカード B',
      list_no: 'PROMO-001',
    });

    expect(deduplicateByListNo([kecak, spectre])).toEqual([kecak, spectre]);
  });

  it('keeps product punctuation as part of the identity', () => {
    const withVariantMarker = card({
      id: 'with-variant-marker',
      source: 'kecak',
      price_source: 'kecak',
      card_name: 'プロモカード-A',
    });
    const withoutVariantMarker = card({
      id: 'without-variant-marker',
      source: 'spectre',
      price_source: 'spectre',
      card_name: 'プロモカードA',
    });

    expect(deduplicateByListNo([withVariantMarker, withoutVariantMarker])).toEqual([
      withVariantMarker,
      withoutVariantMarker,
    ]);
  });

  it('keeps URL variants whose query parameters identify different images', () => {
    const first = card({
      id: 'first-query',
      image_url: 'https://example.test/image?id=first',
    });
    const second = card({
      id: 'second-query',
      excel_product_id: 'excel-b',
      image_url: 'https://example.test/image?id=second',
    });

    expect(deduplicateByListNo([first, second])).toEqual([first, second]);
  });

  it('keeps cards without an image URL', () => {
    const first = card({ id: 'first', image_url: null });
    const second = card({ id: 'second', image_url: null, excel_product_id: 'excel-b' });

    expect(deduplicateByListNo([first, second])).toEqual([first, second]);
  });

  it('keeps cards with invalid image URLs instead of merging them', () => {
    const first = card({ id: 'first-invalid', image_url: 'not a valid URL' });
    const second = card({ id: 'second-invalid', image_url: 'not a valid URL' });

    expect(deduplicateByListNo([first, second])).toEqual([first, second]);
  });

  it('keeps the higher-priority source for an exact duplicate', () => {
    const spectre = card({
      id: 'spectre',
      source: 'spectre',
      price_source: 'spectre',
      price_high: 200_000,
    });
    const orderList = card({
      id: 'order-list',
      source: 'order_list',
      price_source: 'order_list',
      price_high: 100_000,
    });

    expect(deduplicateByListNo([spectre, orderList])).toEqual([orderList]);
  });

  it('deduplicates repeated rows for the exact same order-list item', () => {
    const earlier = card({
      id: 'order-list-earlier',
      order_list_item_id: 'same-order-list-item',
      price_high: 100_000,
    });
    const revised = card({
      id: 'order-list-revised',
      order_list_item_id: 'same-order-list-item',
      price_high: 120_000,
    });

    expect(deduplicateByListNo([earlier, revised])).toEqual([revised]);
  });

  it('keeps the higher price when exact duplicates have the same source priority', () => {
    const lowerPrice = card({
      id: 'lower-spectre',
      source: 'spectre',
      price_source: 'spectre',
      price_high: 100_000,
    });
    const higherPrice = card({
      id: 'higher-spectre',
      source: 'spectre',
      price_source: 'spectre',
      price_high: 120_000,
    });

    expect(deduplicateByListNo([lowerPrice, higherPrice])).toEqual([higherPrice]);
  });

  it('does not merge the same image across different grades or franchises', () => {
    const psa10 = card({ id: 'psa10' });
    const psa9 = card({ id: 'psa9', grade: 'PSA9' });
    const pokemon = card({ id: 'pokemon', franchise: 'POKEMON' });

    expect(deduplicateByListNo([psa10, psa9, pokemon])).toEqual([psa10, psa9, pokemon]);
  });
});
