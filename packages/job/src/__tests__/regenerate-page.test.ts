import { resolveRegenerateAdjustments } from '../jobs/regenerate-page';
import type { LayoutConfig } from '@haraka/shared';

const baseLayout: LayoutConfig = {
  startX: 0,
  priceStartX: 0,
  colWidth: 0,
  cardWidth: 0,
  cardHeight: 0,
  isSmallCard: false,
  rows: [],
  priceBoxWidth: 0,
  priceBoxHeight: 0,
  dateX: 0,
  dateY: 0,
};

describe('resolveRegenerateAdjustments', () => {
  const fallbackLayoutAdjust = { cardYDelta: -2, priceYDelta: 3 };
  const fallbackRowPriceAdjust = {
    1: { priceHighYDelta: 4, priceLowYDelta: 5 },
  };
  const fallbackRowCardAdjust = { 1: 8 };

  it('BOXページには通常ページ用の行別補正をフォールバックしない', () => {
    const result = resolveRegenerateAdjustments({
      layout: {
        ...baseLayout,
        layoutAdjust: { cardYDelta: 0, priceYDelta: -16 },
      },
      isBOX: true,
      fallbackLayoutAdjust,
      fallbackRowPriceAdjust,
      fallbackRowCardAdjust,
    });

    expect(result).toEqual({
      layoutAdjust: { cardYDelta: 0, priceYDelta: -16 },
      rowPriceAdjust: undefined,
      rowCardAdjust: undefined,
    });
  });

  it('通常ページでは既存の行別補正をフォールバックする', () => {
    const result = resolveRegenerateAdjustments({
      layout: baseLayout,
      isBOX: false,
      fallbackLayoutAdjust,
      fallbackRowPriceAdjust,
      fallbackRowCardAdjust,
    });

    expect(result).toEqual({
      layoutAdjust: fallbackLayoutAdjust,
      rowPriceAdjust: fallbackRowPriceAdjust,
      rowCardAdjust: fallbackRowCardAdjust,
    });
  });
});
