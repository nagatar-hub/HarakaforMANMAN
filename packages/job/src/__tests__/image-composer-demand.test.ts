import { composePage, createDemandTextSvg, demandUnitForCard } from '../lib/image-composer';
import sharp from 'sharp';

test('募集数を下段に表示し、BOXだけ個単位にする', () => {
  expect(createDemandTextSvg({ demand: 12, width: 200, height: 40, fontSize: 18 }).toString())
    .toContain('12枚募集！');
  expect(createDemandTextSvg({ demand: 3, unit: '個', width: 200, height: 40, fontSize: 18 }).toString())
    .toContain('3個募集！');
  expect(demandUnitForCard({ grade: 'BOX', tag: 'BOX' })).toBe('個');
  expect(demandUnitForCard({ grade: 'PSA10', tag: null })).toBe('枚');
});

test('real sharp strict mode rejects absent and corrupt bytes before producing a priced back image', async () => {
  for (const images of [new Map(), new Map([['card-1', Buffer.from('not-an-image')]])]) {
    await expect(composePage({
      templateBuffer: Buffer.from('unused'), cardBackBuffer: Buffer.from('must-not-use-back'),
      cards: [{ id: 'card-1' }] as any,
      layout: { startX: 0, cardWidth: 80, cardHeight: 120, colWidth: 100, rows: [{ cardY: 0 }] } as any,
      assetProfile: { grid_cols: 1 } as any,
      cardImageBuffers: images, requireCardImages: true, dateText: '09/07',
    })).rejects.toThrow('Card image');
  }
});

test('real sharp strict mode restores a back only in the unused slot without a price', async () => {
  const solid = (width: number, height: number, background: string) => sharp({
    create: { width, height, channels: 3, background },
  }).png().toBuffer();
  const output = await composePage({
    templateBuffer: await solid(800, 500, '#ffffff'), cardBackBuffer: await solid(80, 120, '#0000ff'),
    cards: [{ id: 'card-1', price_high: 10000, price_low: 9000 }] as any,
    layout: { startX: 0, priceStartX: 0, cardWidth: 80, cardHeight: 120, colWidth: 100,
      priceBoxWidth: 80, priceBoxHeight: 32, dateX: 400, dateY: 300,
      rows: [{ cardY: 0, priceHighY: 140, priceLowY: 180 }] } as any,
    assetProfile: { grid_cols: 2, price_format: '¥{price}', font_family: 'sans-serif' } as any,
    cardImageBuffers: new Map([['card-1', await solid(80, 120, '#ff0000')]]),
    requireCardImages: true, totalSlots: 2, dateText: '09/07',
  });
  const pixel = async (left: number, top: number) => [...await sharp(output)
    .extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  expect(await pixel(40, 60)).toEqual([255, 0, 0]);
  expect(await pixel(140, 60)).toEqual([0, 0, 255]);
  const emptyPriceBytes = await sharp(output).extract({ left: 100, top: 130, width: 80, height: 90 }).png().toBuffer();
  const emptyPrices = await sharp(emptyPriceBytes).stats();
  expect(emptyPrices.channels.slice(0, 3).every(channel => channel.min === 255)).toBe(true);
});
