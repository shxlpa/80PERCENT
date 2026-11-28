// Real entry-point parity: immutable main archive vs the private HTTPS server.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as httpsServer } from 'node:https';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { localStore } from '../server/local-storage.js';
import { seed, board, media, id, fixturePNG } from './fixture.js';
import { exportBundle, restoreBundle } from '../server/migration.js';

const main = process.env.BASELINE_REF || '40f435bd02e0c3d246496280729e965e53cdb612';
const root = resolve('.');
const temporary = await mkdtemp(join(tmpdir(), 'everything-browser-'));
const artifacts = resolve('test-results/parity'); await mkdir(artifacts, {recursive: true});
const baseline = join(temporary, 'baseline'); await mkdir(baseline);
execFileSync('git', ['archive', '--format=tar', '--output=' + join(temporary, 'base.tar'), main]);
execFileSync('tar', ['-xf', join(temporary, 'base.tar'), '-C', baseline]);
await symlink(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
const tls = {key: await readFile(join(temporary, 'key.pem')), cert: await readFile(join(temporary, 'cert.pem'))};
const fixture = localStore(join(temporary, 'seed')); await seed(fixture);
await exportBundle(fixture, join(temporary, 'bundle')); fixture.close();
const summary = {baseline: main, runs: [], limitations: ['Browser device emulation is not a physical iPhone or real Tailscale host.']};
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const n = server.address().port; await new Promise(done => server.close(done)); return n; }
const readBoard = store => store.read('board.json').then(record => JSON.parse(record.data));
const node = (page, n) => page.locator(`[data-id="${id(n)}"]`);
async function ready(page, origin) {
  await page.goto(origin + '/everything/');
  await expect(page.locator('#password')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}
async function unlock(page) {
  await page.locator('#password').fill('synthetic-test-password'); await page.locator('#unlock').click();
  await expect(page.locator('#save-status')).toHaveText('Autosaved');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.ec-node img')).toHaveCount(3);
  await page.waitForFunction(() => [...document.querySelectorAll('.ec-node img')].every(image => image.complete && image.naturalWidth));
}
async function paste(page, type) {
  const image = fixturePNG(320, 240).toString('base64');
  await page.locator('#viewport').focus();
  await page.evaluate(({type, image}) => {
    const transfer = new DataTransfer();
    if (type === 'text') transfer.setData('text/plain', 'Pasted fixture note');
    else transfer.items.add(new File([Uint8Array.from(atob(image), c => c.charCodeAt(0))], 'Pasted fixture.png', {type: 'image/png'}));
    document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
  }, {type, image});
}
async function run(browser, device, version) {
  const label = device.name + '-' + version;
  const data = join(temporary, label); await restoreBundle(join(temporary, 'bundle'), data);
  const observer = localStore(data, {readOnly: true});
  const backendPort = await port();
  const publicPort = version === 'port' ? await port() : backendPort;
  const origin = `${version === 'port' ? 'https://localhost' : 'http://127.0.0.1'}:${publicPort}`;
  let proxy;
  if (version === 'port') {
    proxy = httpsServer(tls, (req, res) => {
      const upstream = request({hostname: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers: req.headers}, result => {
        res.writeHead(result.statusCode, result.headers); result.pipe(res);
      }); upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    }); proxy.listen(publicPort, '127.0.0.1'); await once(proxy, 'listening');
  }
  const child = spawn(process.execPath, version === 'port' ? ['--import', join(root, 'test-support/no-blob-runtime.js'), 'server/serve.js'] : ['server/dev.js'], {
    cwd: version === 'port' ? root : baseline,
    env: {PATH: process.env.PATH, PORT: String(backendPort), EVERYTHING_DATA_DIR: data, EVERYTHING_PASSWORD: 'synthetic-test-password', EVERYTHING_ORIGIN: origin,
      ...(version === 'port' ? {BLOB_READ_WRITE_TOKEN: 'deliberately-invalid-unused-fixture'} : {})},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stderr.on('data', chunk => { logs += chunk; });
  const context = await browser.newContext({...device.options, ignoreHTTPSErrors: true, acceptDownloads: true});
  const otherContext = await browser.newContext({...device.options, ignoreHTTPSErrors: true, acceptDownloads: true});
  const unexpected = [], errors = [], requests = [], conflicts = [];
  for (const ctx of [context, otherContext]) {
    await ctx.route('**/*', route => {
      const url = route.request().url(); requests.push(url);
      if (new URL(url).origin !== origin) { unexpected.push(url); return route.abort(); }
      return route.continue();
    });
    ctx.on('page', p => p.on('pageerror', error => errors.push(error.message)));
    ctx.on('response', response => { if (response.status() === 409) conflicts.push(response.url()); });
  }
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(logs); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + logs)), 10000); timer.unref(); })]);
    const page = await context.newPage(); await ready(page, origin);
    await page.screenshot({path: join(artifacts, label + '-locked.png'), animations: 'disabled'});
    await unlock(page); assert.deepEqual(await readBoard(observer), board);
    await page.screenshot({path: join(artifacts, label + '-board.png'), animations: 'disabled'});
    const other = await otherContext.newPage(); await ready(other, origin); await unlock(other);
    // Original and Instagram exports through visible controls, without board changes.
    if (device.options.isMobile) {
      const box = await node(page, 4).boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else await node(page, 4).click();
    const exports = [];
    for (const button of ['export-photo', 'export-instagram']) {
      const pending = page.waitForEvent('download'); await page.locator('#' + button).click();
      const download = await pending;
      const bytes = await readFile(await download.path());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      exports.push([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
      await writeFile(join(artifacts, label + '-' + button + '.png'), bytes);
    }
    assert.deepEqual(exports, [[720, 1280], [1024, 1280]]);
    await page.locator('#clear-selection').click();
    const landscape = await node(page, 1).boundingBox();
    await node(page, 1).click({position: {x: landscape.width * .8, y: landscape.height * .8}});
    const overlayDownload = page.waitForEvent('download'); await page.locator('#export-photo').click();
    const overlayBytes = await readFile(await (await overlayDownload).path());
    assert.deepEqual([overlayBytes.readUInt32BE(16), overlayBytes.readUInt32BE(20)], [1200, 800]);
    await writeFile(join(artifacts, label + '-export-overlays.png'), overlayBytes);
    assert.deepEqual(await readBoard(observer), board);
    await page.locator('#clear-selection').click();
    // Native pointer drag, pan and wheel zoom; touch pointer pinch is also exercised below.
    const shape = node(page, 6), box = await shape.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 - 22, {steps: 6}); await page.mouse.up();
    await expect.poll(async () => (await readBoard(observer)).items.find(item => item.id === id(6)).x).not.toBe(190);
    await other.evaluate(() => dispatchEvent(new Event('focus')));
    await expect.poll(() => node(other, 6).getAttribute('style')).toBe(await node(page, 6).getAttribute('style'));
    await page.locator('#clear-selection').click();
    const initialTransform = await page.locator('#world').getAttribute('style');
    await page.locator('#tool-hand').click();
    await page.mouse.move(110, 170); await page.mouse.down(); await page.mouse.move(135, 190); await page.mouse.up();
    assert.notEqual(await page.locator('#world').getAttribute('style'), initialTransform);
    await page.locator('#tool-select').click();
    const oldZoom = await page.locator('#zoom-value').textContent();
    if (device.options.isMobile) {
      // Playwright cannot send a native mobile WebKit wheel/pinch gesture.
      // Exercise WebKit's gesture handlers; physical touch remains a device check.
      await page.evaluate(() => {
        const viewport = document.getElementById('viewport');
        for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
          viewport.dispatchEvent(Object.assign(new Event(type, {bubbles: true, cancelable: true}), {clientX: 170, clientY: 210, scale: type === 'gesturechange' ? 2 : 1}));
        }
      });
    } else {
      await page.mouse.move(170, 210); await page.keyboard.down('Control'); await page.mouse.wheel(0, -80); await page.keyboard.up('Control');
    }
    await expect(page.locator('#zoom-value')).not.toHaveText(oldZoom);
    await page.locator('#zoom-fit').click();
    // File picker uploads retain exact bytes. Clipboard dispatch exercises the app paste path.
    const upload = fixturePNG(640, 480, 1);
    await page.locator('#image-picker').setInputFiles({name: 'Uploaded fixture.png', mimeType: 'image/png', buffer: upload});
    await expect.poll(async () => (await readBoard(observer)).items.length).toBe(8);
    const uploaded = (await readBoard(observer)).items.find(item => item.name === 'Uploaded fixture.png');
    assert.deepEqual((await observer.read('images/' + uploaded.imageId)).data, upload);
    await paste(page, 'text'); await expect.poll(async () => (await readBoard(observer)).items.length).toBe(9);
    await paste(page, 'image'); await expect.poll(async () => (await readBoard(observer)).items.length).toBe(10);
    // Two independently unlocked sessions edit the same saved board before either refreshes.
    await paste(other, 'text');
    await expect.poll(async () => (await readBoard(observer)).items.length).toBe(11);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.locator('.ec-node')).toHaveCount(11);
    await expect(page.locator('#save-status')).toHaveText('Autosaved');
    const saved = await readBoard(observer);
    await page.reload(); await expect(page.locator('#password')).toBeVisible();
    const guestStatus = await page.evaluate(() => fetch('/api/everything?action=board').then(r => r.status)); assert.equal(guestStatus, 401);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.locator('#password').fill('synthetic-test-password'); await page.locator('#unlock').click();
    await expect(page.locator('.ec-node')).toHaveCount(11); await expect(page.locator('#save-status')).toHaveText('Autosaved');
    assert.deepEqual(await readBoard(observer), saved);
    await page.locator('#logout').click(); await expect(page.locator('#password')).toBeVisible();
    await expect(other.locator('#save-status')).toHaveText('Autosaved');
    assert.ok(conflicts.length >= 1, 'stale session must exercise revision conflict reconciliation');
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); assert.doesNotMatch(logs, /failed|forbidden/i);
    const result = {label, requests: requests.length, externalRequests: unexpected.length, consoleErrors: errors.length, revisionConflicts: conflicts.length, initialRevision: 37, savedRevision: saved.revision, finalLayers: saved.items.length, exports,
      checks: ['entry-point unlock', 'visual parity screenshots', 'two sessions', 'drag', 'pan', device.options.isMobile ? 'touch tap and dispatched WebKit gesture' : 'wheel zoom', 'file upload bytes', 'clipboard text/image', 'stale-session merge', 'refresh lock', 'reopen saved board', 'logout', 'full-resolution exports']};
    summary.runs.push(result); console.log(JSON.stringify(result));
  } finally {
    await context.close(); await otherContext.close(); observer.close();
    child.kill('SIGTERM'); await once(child, 'exit').catch(() => {});
    if (proxy) await new Promise(done => proxy.close(done));
  }
}
try {
  const configurations = [
    {name: 'desktop-chromium', engine: chromium, options: {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1}},
    {name: 'iphone-webkit', engine: webkit, options: devices['iPhone 13']}
  ];
  for (const device of configurations) {
    const browser = await device.engine.launch({headless: true});
    try { for (const version of ['baseline', 'port']) await run(browser, device, version); }
    finally { await browser.close(); }
    for (const state of ['locked', 'board', 'export-photo', 'export-instagram', 'export-overlays']) {
      const before = await readFile(join(artifacts, device.name + '-baseline-' + state + '.png'));
      const after = await readFile(join(artifacts, device.name + '-port-' + state + '.png'));
      assert.ok(before.equals(after), device.name + ' ' + state + ' must be pixel-identical');
    }
  }
  summary.visualParity = 'All four locked/editor screenshot pairs and six export pairs are byte-identical.';
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(summary.visualParity);
} finally { await rm(temporary, {recursive: true, force: true}); }
