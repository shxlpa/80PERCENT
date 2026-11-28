import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { localStore } from './local-storage.js';
import { privateBlobStore } from './storage.js';
import { exportBundle, restoreBundle, verifyBundle, verifyStore } from './migration.js';
import { seed, media, boardBytes } from '../test-support/fixture.js';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'everything-migration-'));
  const store = localStore(join(root, 'source'));
  await seed(store);
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  return {root, store, backup: join(root, 'backup')};
}
test('lossless migration and rollback retain revision, board bytes, reused media IDs and all original bytes', async t => {
  const {root, store, backup} = await setup(t);
  await store.write('bearer-sessions/not-a-real-session', 'private');
  assert.deepEqual(await exportBundle(store, backup), {revision: 37, media: 2});
  assert.deepEqual(await readFile(join(backup, 'board.json')), boardBytes);
  assert.equal((await stat(join(backup, 'board.json'))).mode & 0o777, 0o600);
  const destination = join(root, 'restored');
  assert.deepEqual(await restoreBundle(backup, destination), {revision: 37, media: 2});
  const restored = localStore(destination);
  try {
    await verifyStore(restored, backup);
    assert.equal(await restored.read('bearer-sessions/not-a-real-session'), null);
    const previous = await restored.read('board.json');
    await restored.write('board.json', JSON.stringify({revision: 38, items: []}), previous.etag);
    await assert.rejects(verifyStore(restored, backup), /differs/);
    await exportBundle(restored, join(root, 'post-cutover'));
  } finally { restored.close(); }
  // Roll back to another fresh directory. Neither old nor newer data is overwritten.
  await restoreBundle(backup, join(root, 'rollback'));
  const rollback = localStore(join(root, 'rollback'), {readOnly: true});
  try { assert.deepEqual(await verifyStore(rollback, backup), {revision: 37, media: 2}); } finally { rollback.close(); }
  await assert.rejects(restoreBundle(backup, destination), /already exists/);
  await assert.rejects(exportBundle(store, backup), /already exists/);
});
test('missing media, changed source revisions, corrupt bytes and incomplete manifests fail closed', async t => {
  const {root, store, backup} = await setup(t);
  const imageKey = [...media.keys()][0];
  const missing = {read: key => key === imageKey ? null : store.read(key)};
  await assert.rejects(exportBundle(missing, backup), /missing/);
  let reads = 0;
  const unstable = {async read(key) { const record = await store.read(key); if (key === 'board.json' && ++reads === 2) record.etag = 'changed'; return record; }};
  await assert.rejects(exportBundle(unstable, backup), /changed/);
  await exportBundle(store, backup);
  const original = await readFile(join(backup, imageKey));
  await writeFile(join(backup, imageKey), original.subarray(0, 24));
  await assert.rejects(restoreBundle(backup, join(root, 'bad')), /checksum/);
  await assert.rejects(stat(join(root, 'bad')), {code: 'ENOENT'});
  await writeFile(join(backup, imageKey), original);
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json')));
  manifest.objects.pop();
  await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(backup), /inventory/);
});
test('a fixture Blob export uses only exact-key reads, then restores and verifies offline', async t => {
  const {root, backup} = await setup(t);
  const previous = getGlobalDispatcher();
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
  const pool = agent.get('https://test.private.blob.vercel-storage.com');
  pool.intercept({path: '/everything/board.json?cache=0'}).reply(200, boardBytes, {headers: {etag: '"fixture-revision-37"'}}).times(2);
  for (const [key, bytes] of media) pool.intercept({path: '/everything/' + key + '?cache=0'}).reply(200, bytes, {headers: {etag: '"fixture-media"'}});
  await exportBundle(privateBlobStore('vercel_blob_rw_test_fixture'), backup);
  agent.assertNoPendingInterceptors();
  assert.deepEqual(await restoreBundle(backup, join(root, 'from-blob')), {revision: 37, media: 2});
});

test('the operator CLI exports, verifies, restores and checks a fixture without network credentials', async t => {
  const {root} = await setup(t);
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['server/migrate.js', ...args], {env: {PATH: process.env.PATH}, encoding: 'utf8'}));
  const backup = join(root, 'cli-backup'), destination = join(root, 'cli-restored');
  for (const args of [['export-local', join(root, 'source'), backup], ['verify', backup], ['restore', backup, destination], ['verify-store', backup, destination]]) {
    assert.deepEqual(cli(...args), {ok: true, revision: 37, media: 2});
  }
});
