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
