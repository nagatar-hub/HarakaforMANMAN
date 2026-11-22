import { sendDiscordNotification } from '../lib/discord';

describe('Discord notification isolation', () => {
  const originalDisabled = process.env.DISCORD_NOTIFICATIONS_DISABLED;

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.DISCORD_NOTIFICATIONS_DISABLED;
    else process.env.DISCORD_NOTIFICATIONS_DISABLED = originalDisabled;
    jest.restoreAllMocks();
  });

  it('明示無効時はWebhook取得・送信より前に終了する', async () => {
    process.env.DISCORD_NOTIFICATIONS_DISABLED = '1';
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await sendDiscordNotification({
      title: 'preview test',
      description: 'must not leave the test boundary',
      color: 0,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('店舗名付きのDiscord送信', () => {
  it.each([
    ['oripark', '【オリパーク】', '画像生成完了', 0x00ff00, '画像生成完了'],
    ['manman', '【満満】', '同期失敗', 0xff0000, '【エンジニア対応】同期失敗'],
    ['manman-akihabara', '【東京満満】', '【データ修正】商品名', 0xffaa00, '【データ修正】商品名'],
    ['new-store', '【new-store】', 'オーダーリスト未反映', 0xffaa00, '【データ修正】オーダーリスト未反映'],
  ] as const)('%s の店舗名と既存の通知分類を送る', async (store, prefix, title, color, expected) => {
    const original = process.env;
    process.env = { ...original, STORE_NAME: store, DISCORD_NOTIFICATIONS_DISABLED: '0', DISCORD_WEBHOOK_URL: 'https://example.invalid/webhook' };
    const send = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await jest.isolateModulesAsync(async () => {
        const { sendDiscordNotification } = jest.requireActual('../lib/discord');
        await sendDiscordNotification({ title, description: '対象の商品', color });
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(send.mock.calls[0][1]?.body)).embeds[0]).toMatchObject({
        title: prefix + expected, description: '対象の商品', color,
      });
    } finally {
      send.mockRestore();
      process.env = original;
    }
  });
});
