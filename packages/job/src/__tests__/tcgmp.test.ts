import { getTcgmpDetail, getTcgmpImage, parseTcgmpDetail, parseTcgmpSearch, validateTcgmpImageUrl } from '../lib/tcgmp';

// Reduced excerpts of public GET /s/product/?prc_id=57&word=OP05-091 and detail?id=498924.
const search = `<input name="word" value="OP05-091">
<a href="/s/product/detail?id=498924&amp;referer=1"><div class="image"><img src="https://d1sqsdq2kxn50g.cloudfront.net/TS/OP05/091SR2.jpg" alt="レベッカ【ワンピースカードゲーム】"></div></a>
<a href="/s/product/detail?id=480480&amp;referer=1"><div class="image"><img src="https://d1sqsdq2kxn50g.cloudfront.net/TS/OP05/091SR1.jpg" alt="レベッカ[Makitoshi画]【ワンピースカードゲーム】"></div></a>`;
const detail = `<a href="https://d1sqsdq2kxn50g.cloudfront.net/TXL/OP05/091SR2.jpg" rel="image" class="colorbox"><img></a>
<script type="application/ld+json">{"@type":"Product","name":"黒)OP06収録)SP◆レベッカ","sku":"OP05-091SR2","description":"OP06・ＳＰ","offers":{"lowPrice":"999"}}</script>`;

test('retains variants without selection and extracts full image/metadata without prices', () => {
  expect(parseTcgmpSearch(search).map(x => x.id)).toEqual(['498924', '480480']);
  expect(parseTcgmpDetail(detail, '498924')).toEqual({ id: '498924', name: '黒)OP06収録)SP◆レベッカ', sku: 'OP05-091SR2', description: 'OP06・ＳＰ', imageUrl: 'https://d1sqsdq2kxn50g.cloudfront.net/TXL/OP05/091SR2.jpg' });
  expect(() => parseTcgmpDetail('<html>challenge</html>', '498924')).toThrow();
  expect(() => parseTcgmpSearch('<html>challenge</html>')).toThrow();
  expect(() => validateTcgmpImageUrl('https://d1sqsdq2kxn50g.cloudfront.net.evil.test/TXL/a.jpg')).toThrow();
  expect(() => validateTcgmpImageUrl('http://d1sqsdq2kxn50g.cloudfront.net/TXL/a.jpg')).toThrow();
  expect(() => validateTcgmpImageUrl('https://user@d1sqsdq2kxn50g.cloudfront.net/TXL/a.jpg')).toThrow();
});

test('serializes requests with 8 second gaps, rejects errors, and never follows redirects', async () => {
  jest.useFakeTimers({ now: 100_000 });
  const original = global.fetch;
  const started: number[] = [];
  global.fetch = jest.fn(async () => {
    started.push(Date.now());
    return new Response(detail, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }) as typeof fetch;
  try {
    const a = getTcgmpDetail('498924');
    const b = getTcgmpDetail('498924');
    await jest.advanceTimersByTimeAsync(0);
    await a;
    expect(started).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(7999);
    expect(started).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    await b;
    expect(started).toEqual([100_000, 108_000]);
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response('', { status: 429 }));
    const rejected = expect(getTcgmpDetail('498924')).rejects.toThrow('429');
    await jest.advanceTimersByTimeAsync(8000);
    await rejected;
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }));
    const oversized = expect(getTcgmpDetail('498924')).rejects.toThrow('too large');
    await jest.advanceTimersByTimeAsync(8000);
    await oversized;
    await expect(getTcgmpImage('https://example.com/a.jpg')).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(4);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('fetch failed', { cause: { code: 'ECONNRESET' } }));
    const transport = expect(getTcgmpDetail('498924')).rejects.toThrow('TCGMP transport error (ECONNRESET)');
    await jest.advanceTimersByTimeAsync(8000);
    await transport;
  } finally { global.fetch = original; jest.useRealTimers(); }
});
