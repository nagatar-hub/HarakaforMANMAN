import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { fork } from 'node:child_process';
import { runCatalogSyncJob } from '../routes/gallery.js';

test('published gallery mutations wait for the shared catalog publisher and surface its failure', async () => {
  const calls: Array<{ modulePath: string; env: NodeJS.ProcessEnv | undefined }> = [];
  const forkJob = ((modulePath: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ modulePath, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', calls.length === 1 ? 0 : 1, null));
    return child;
  }) as unknown as typeof fork;

  await runCatalogSyncJob('run-1', forkJob);
  assert.match(calls[0].modulePath, /job[\\/]dist[\\/]index\.js$/);
  assert.equal(calls[0].env?.JOB_NAME, 'publish-peleka-catalog');
  assert.equal(calls[0].env?.RUN_ID, 'run-1');

  await assert.rejects(runCatalogSyncJob('run-2', forkJob), /Pelekaカタログ同期ジョブ失敗/);
});
