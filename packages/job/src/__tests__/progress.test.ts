import { clearProgress, updateProgress } from '../lib/progress';

function makeSupabaseMock() {
  const query = {
    update: jest.fn(),
    eq: jest.fn(),
  };
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const supabase = { from: jest.fn(() => query) };
  return { supabase, query };
}

describe('progress store scope', () => {
  it('進捗更新をmanmanのRunだけに限定する', async () => {
    const { supabase, query } = makeSupabaseMock();

    await updateProgress(supabase as never, 'run-1', 3, 10, '処理中');

    expect(query.eq.mock.calls).toEqual([
      ['id', 'run-1'],
      ['store', 'manman'],
    ]);
  });

  it('進捗クリアをmanmanのRunだけに限定する', async () => {
    const { supabase, query } = makeSupabaseMock();

    await clearProgress(supabase as never, 'run-2');

    expect(query.eq.mock.calls).toEqual([
      ['id', 'run-2'],
      ['store', 'manman'],
    ]);
  });
});