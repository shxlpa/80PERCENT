import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWriting, parsePosts } from '../api/writing.js';

const feed = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>offline thoughts</title>${items}</channel></rss>`;
const first = '<item><title>Early &amp; bright</title><link>https://shxlpa.substack.com/p/early</link>' +
  '<pubDate>Sat, 29 Nov 2025 21:06:02 GMT</pubDate><description>A thought about light.</description></item>';
const next = '<item><title><![CDATA[Later <edition>]]></title><link>https://shxlpa.substack.com/p/later</link>' +
  '<pubDate>Wed, 05 Aug 2026 03:59:55 GMT</pubDate><description><![CDATA[A short subtitle.]]></description>' +
  '<content:encoded><![CDATA[<h2>The full story</h2>]]></content:encoded></item>';
const request = (method = 'GET') => new Request('https://portfolio.example/api/writing/', {
  method, headers: { cookie: 'unrelated=local-test' }
});

test('a refreshed feed returns new posts first and exposes only public summary fields', async () => {
  let contents = first;
  const fetchFeed = async (url, options) => {
    assert.equal(url, 'https://shxlpa.substack.com/feed');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).has('cookie'), false);
    return new Response(feed(contents));
  };
  const initial = await handleWriting(request(), fetchFeed);
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get('cache-control'), /max-age=0/);
  assert.match(initial.headers.get('vercel-cdn-cache-control'), /max-age=60\b/);
  const old = (await initial.json()).posts[0];
  assert.equal(old.title, 'Early & bright');
  contents += next;
  const updated = await handleWriting(request(), fetchFeed);
  assert.deepEqual(await updated.json(), { posts: [
    { title: 'Later <edition>', url: 'https://shxlpa.substack.com/p/later',
      date: '2026-08-05T03:59:55.000Z', snippet: 'A short subtitle.' },
    old
  ] });
});

test('feed items use publication post links and plain summaries', () => {
  const foreign = first.replace('shxlpa.substack.com', 'elsewhere.example');
  const localPath = first.replace('/p/early', '/archive');
  const noDate = first.replace('Sat, 29 Nov 2025 21:06:02 GMT', '');
  const formatted = next.replace('A short subtitle.', '<em>A formatted description.</em>');
  const posts = parsePosts(feed(foreign + localPath + noDate + formatted));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].snippet, '');
  assert.equal(posts[0].url, 'https://shxlpa.substack.com/p/later');
});

test('an empty channel succeeds and invalid feeds and upstream failures are never cached', async () => {
  const empty = await handleWriting(request(), () => new Response(feed('')));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { posts: [] });
  for (const upstream of [
    () => new Response('<html><body>Temporarily unavailable</body></html>'),
    () => new Response('<rss><channel>'),
    () => new Response('<!DOCTYPE rss><rss><channel/></rss>'),
    () => new Response(feed('<item><title>Incomplete</title></item>')),
    () => new Response(null, { status: 503 }),
    () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    () => { throw new Error('Network unavailable'); }
  ]) {
    const result = await handleWriting(request(), upstream);
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('vercel-cdn-cache-control'), null);
  }
});

test('HEAD omits the body and unsupported methods do not contact the feed', async () => {
  const head = await handleWriting(request('HEAD'), () => new Response(feed(first)));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  const failedHead = await handleWriting(request('HEAD'), () => new Response(null, { status: 503 }));
  assert.equal(failedHead.status, 502);
  assert.equal(failedHead.body, null);
  const result = await handleWriting(request('POST'), () => assert.fail('unexpected upstream request'));
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('allow'), 'GET, HEAD');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
