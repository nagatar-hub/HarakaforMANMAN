import {
  OrderListLeaseLostError,
  startOrderListLease,
} from '../lib/order-list-lease';

describe('order-list processing lease', () => {
  it('renewNowでheartbeatを更新し、停止後はactive扱いしない', async () => {
    const renew = jest.fn(async () => undefined);
    const lease = startOrderListLease({ renew }, 'import-1', 60_000);

    await lease.renewNow();
    expect(renew).toHaveBeenCalledWith('import-1', expect.any(String));
    lease.assertActive();

    await lease.stop();
    expect(() => lease.assertActive()).toThrow(OrderListLeaseLostError);
  });

  it('heartbeat更新失敗を処理リース喪失として呼び出し側へ伝える', async () => {
    const lease = startOrderListLease({
      renew: async () => {
        throw new Error('database unavailable');
      },
    }, 'import-2', 60_000);

    await expect(lease.renewNow()).rejects.toThrow(
      'オーダーリスト処理リースを維持できません: database unavailable',
    );
    await lease.stop();
  });
});
