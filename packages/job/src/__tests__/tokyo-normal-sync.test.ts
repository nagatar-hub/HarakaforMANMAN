import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import type { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';

const snapshot = { snapshot: { id: 'snapshot-1', store: 'manman-akihabara', business_date: '2026-09-07' },
  products: [
    { id: 'psa-1', franchise: 'Pokemon', product_type: 'psa', name: 'カイ', model_number: '236/172', image_url: 'https://example.com/psa.png', source_price: 10000, price_high: 9300 },
    { id: 'box-1', franchise: 'ONE PIECE', product_type: 'box', name: '謀略の王国', model_number: null, image_url: null, source_price: 20000, price_high: 18600 },
  ] } as unknown as Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>;

test('normal prepared cards preserve snapshot price and exact source, PSA/BOX tags and one-price compatibility', () => {
  const rows = buildTokyoPreparedCards('run-1', snapshot);
  expect(rows.map(row => [row.source_shinsoku_id,row.tag,row.price_high,row.price_low,row.source,row.price_source]))
    .toEqual([['psa-1','PSA10',9300,9300,'shinsoku','shinsoku'],['box-1','BOX',18600,18600,'shinsoku','shinsoku']]);
  expect(rows[0]).toMatchObject({ run_id:'run-1',grade:'PSA10',list_no:'236/172',image_url:'https://example.com/psa.png',price_source_date:'2026-09-07' });
});

test('Tokyo normal sync claims then publishes and prepares all snapshot products, never accessing legacy pricing', async () => {
  const prior = { store:process.env.STORE_NAME, importId:process.env.ORDER_LIST_IMPORT_ID };
  process.env.STORE_NAME='manman-akihabara'; process.env.ORDER_LIST_IMPORT_ID='import-1';
  const auth = jest.fn(() => { throw new Error('legacy OAuth must not be called'); });
  const build = jest.fn(async () => snapshot);
  const prepared: unknown[] = [];
  const db = {
    rpc: jest.fn(async (name: string) => ({ data:name==='publish_tokyo_buyback_snapshot'?'snapshot-1':true,error:null })),
    from: jest.fn((table: string) => {
      const chain: any = {};
      for (const method of ['update','eq','is','select']) chain[method]=jest.fn(() => chain);
      chain.insert=jest.fn((rows: unknown) => { if(table==='prepared_card') { prepared.push(...rows as unknown[]);return Promise.resolve({error:null}); }return chain; });
      chain.single=jest.fn(async () => ({ data: { id:table==='run'?'run-1':'import-1',business_date:'2026-09-07' },error:null }));
      chain.maybeSingle=jest.fn(async () => ({ data:{id:'run-1'},error:null }));
      return chain;
    }),
  };
  let runSync: () => Promise<void> = async () => {};
  jest.isolateModules(() => {
    jest.doMock('../lib/supabase', () => ({ createSupabaseClientFromSecrets:async()=>db }));
    jest.doMock('../lib/auth', () => ({ getAccessToken:auth }));
    jest.doMock('../lib/progress', () => ({ updateProgress:jest.fn(),clearProgress:jest.fn() }));
    jest.doMock('../lib/discord', () => ({ sendDiscordNotification:jest.fn(),COLOR:{} }));
    jest.doMock('../jobs/tokyo-buyback-sync', () => ({ TOKYO_BUYBACK_STORE:'manman-akihabara',buildTokyoBuybackSnapshot:build }));
    runSync=require('../jobs/sync').runSync;
  });
  try {
    await runSync();
    expect(auth).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(db,expect.any(Date),{claimedImportId:'import-1',runId:'run-1'});
    expect(prepared).toHaveLength(2);
    expect(db.rpc).toHaveBeenCalledWith('publish_tokyo_buyback_snapshot',expect.objectContaining({p_run_id:'run-1'}));
    expect(db.rpc).toHaveBeenCalledWith('finalize_order_list_sync',expect.objectContaining({p_import_id:'import-1',p_run_id:'run-1',p_total_prepared:2,p_total_pages:0}));
    expect(db.rpc).not.toHaveBeenCalledWith('fail_order_list_sync',expect.anything());
  } finally {
    if(prior.store===undefined) delete process.env.STORE_NAME; else process.env.STORE_NAME=prior.store;
    if(prior.importId===undefined) delete process.env.ORDER_LIST_IMPORT_ID; else process.env.ORDER_LIST_IMPORT_ID=prior.importId;
  }
});
