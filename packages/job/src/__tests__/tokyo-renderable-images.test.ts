import sharp from 'sharp';
import type { PreparedCardRow } from '@haraka/shared';
import { downloadImagesWithConcurrency } from '../lib/google-drive';
import { prepareTokyoRenderableCards } from '../jobs/generate';

jest.mock('../lib/google-drive', () => ({ downloadImagesWithConcurrency: jest.fn() }));

test('Tokyo excludes absent, failed and corrupt images before planning, keeping actual bytes and prices', async () => {
  const png = await sharp({ create: { width: 3, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  const cards = ['valid', 'missing', 'failed', 'corrupt', 'alt', 'broken-alt'].map(id => ({
    id, image_url: id === 'missing' ? null : `https://example.com/${id}.png`,
    alt_image_url: id.includes('alt') ? `https://example.com/${id}-fallback.png` : null,
    price_high: 12300, price_low: 12300, tag: 'PSA10',
  })) as PreparedCardRow[];
  const download = jest.mocked(downloadImagesWithConcurrency);
  download.mockResolvedValueOnce([png, null, null, Buffer.from('broken'), null, null])
    .mockResolvedValueOnce([png]).mockResolvedValueOnce([Buffer.from('broken')]);
  const original = JSON.stringify(cards);
  const result = await prepareTokyoRenderableCards(cards);
  expect(result.cards.map(card => card.id)).toEqual(['valid', 'alt']);
  expect(result.cards).toEqual([cards[0], cards[4]]);
  expect([...result.buffers.keys()]).toEqual(['valid', 'alt']);
  expect(result.buffers.get('valid')).toBe(png);
  expect(JSON.stringify(cards)).toBe(original);
  expect(download).toHaveBeenCalledTimes(3);
});
