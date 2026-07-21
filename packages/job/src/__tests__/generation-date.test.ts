import {
  formatGenerationDate,
  getJstDateParts,
  parseBusinessDate,
  resolveGenerationDisplayDate,
} from '../lib/generation-date';

describe('generation date', () => {
  it('Excel取込Runはorder_list_importの業務日を画像表示日に使う', async () => {
    const loadBusinessDate = jest.fn(async () => '2026-07-15');

    const result = await resolveGenerationDisplayDate({
      orderListImportId: 'import-20260715',
      loadBusinessDate,
      now: new Date('2026-07-20T23:30:00.000Z'),
    });

    expect(loadBusinessDate).toHaveBeenCalledWith('import-20260715');
    expect(result).toEqual({ year: '2026', month: '07', day: '15' });
    expect(formatGenerationDate(result)).toBe('07/15');
  });

  it('order_list_importがない旧RunだけJST当日へフォールバックする', async () => {
    const loadBusinessDate = jest.fn(async () => '2026-07-15');
    const now = new Date('2026-07-20T15:30:00.000Z');

    const result = await resolveGenerationDisplayDate({
      orderListImportId: null,
      loadBusinessDate,
      now,
    });

    expect(loadBusinessDate).not.toHaveBeenCalled();
    expect(result).toEqual({ year: '2026', month: '07', day: '21' });
    expect(result).toEqual(getJstDateParts(now));
  });

  it('取込IDがあるのに業務日を取得できない場合はJST当日へ黙って置換しない', async () => {
    await expect(resolveGenerationDisplayDate({
      orderListImportId: 'missing-import',
      loadBusinessDate: async () => null,
      now: new Date('2026-07-20T15:30:00.000Z'),
    })).rejects.toThrow('missing-import の業務日を取得できません');
  });

  it('不正な業務日を拒否する', () => {
    expect(() => parseBusinessDate('2026-02-30')).toThrow('業務日が不正です');
    expect(() => parseBusinessDate('07/15')).toThrow('業務日の形式が不正です');
  });
});
