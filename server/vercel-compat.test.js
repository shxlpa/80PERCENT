import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { boardBytes, media } from '../test-support/fixture.js';

test('legacy Vercel entry preserves authenticated board/media reads while private hosting stays independent', async t => {
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN, oldPassword = process.env.EVERYTHING_PASSWORD;
  const password = 'isolated-compatibility-fixture', token = 'a'.repeat(43);
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_fixture';
  process.env.EVERYTHING_PASSWORD = password;
  const previous = getGlobalDispatcher(), agent = new MockAgent();
  agent.disableNetConnect(); setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previous); await agent.close();
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
    if (oldPassword === undefined) delete process.env.EVERYTHING_PASSWORD; else process.env.EVERYTHING_PASSWORD = oldPassword;
  });
  const pool = agent.get('https://test.private.blob.vercel-storage.com');
  const session = createHmac('sha256', password).update('bearer:' + token).digest('hex');
  pool.intercept({path: '/everything/bearer-sessions/' + session + '?cache=0'})
    .reply(200, String(Date.now() + 3600_000), {headers: {etag: '"fixture-session"'}}).times(3);
  pool.intercept({path: '/everything/board.json?cache=0'})
    .reply(200, boardBytes, {headers: {etag: '"fixture-board"'}});
  const [imageKey, bytes] = [...media][0];
  pool.intercept({path: '/everything/' + imageKey + '?cache=0'})
    .reply(200, bytes, {headers: {etag: '"fixture-image"'}});
  const {default: api} = await import('../api/everything.js?compatibility-fixture');
  const call = (action, authenticated = false) => api.fetch(new Request('https://fixture.invalid/api/everything?action=' + action,
    {headers: authenticated ? {authorization: 'Bearer ' + token} : {}}));
  assert.match(await (await call('page')).text(), /data-page="login"/);
  assert.equal((await call('board')).status, 401);
  assert.match(await (await call('page', true)).text(), /data-page="editor"/);
  assert.deepEqual(await (await call('board', true)).json(), JSON.parse(boardBytes));
  assert.deepEqual(Buffer.from(await (await call('image&id=' + imageKey.slice(7), true)).arrayBuffer()), bytes);
  // Invalid content is rejected before login throttling/storage: safe readiness probe.
  const invalidLogin = await api.fetch(new Request('https://fixture.invalid/api/everything?action=login',
    {method: 'POST', headers: {origin: 'https://fixture.invalid'}}));
  assert.equal(invalidLogin.status, 415);
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.ok(config.rewrites.some(rule => rule.source === '/everything/' && rule.destination === '/api/everything?action=page'));
  agent.assertNoPendingInterceptors();
});
