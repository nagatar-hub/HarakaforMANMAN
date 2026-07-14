import type { PreparedCardRow } from '@haraka/shared';
import { checkImageHealth } from '../lib/image-health-check';

jest.mock('../lib/progress.js', () => ({
  updateProgress: jest.fn(async () => undefined),
}));

function makeCard(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: 'card-1',
    image_url: null,
    alt_image_url: null,
    ...overrides,
  } as PreparedCardRow;
}

function makeSupabase(result: { data: Array<{ id: string }> | null; error: { message: string } | null }) {
  const builder: Record<string, jest.Mock> = {};
  builder.update = jest.fn(() => builder);
  builder.in = jest.fn(() => builder);
  builder.select = jest.fn(async () => result);
  const from = jest.fn(() => builder);
  return { client: { from }, builder, from };
}

describe('checkImageHealth', () => {
  afterEach(() => jest.clearAllMocks());

  it('primaryもfallbackもないカードをdeadとして保存・集計する', async () => {
    const { client, builder } = makeSupabase({ data: [{ id: 'card-1' }], error: null });

    const deadCount = await checkImageHealth(client as never, 'run-1', [makeCard()]);

    expect(deadCount).toBe(1);
    expect(builder.update).toHaveBeenCalledWith({ image_status: 'dead' });
    expect(builder.in).toHaveBeenCalledWith('id', ['card-1']);
  });

  it('画像ステータスのDB保存失敗を成功扱いにしない', async () => {
    const { client } = makeSupabase({ data: null, error: { message: 'write failed' } });

    await expect(checkImageHealth(client as never, 'run-1', [makeCard()]))
      .rejects.toThrow('画像ステータス更新失敗 (dead): write failed');
  });
});
