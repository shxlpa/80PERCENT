import sax from 'sax';
import { canonicalPostUrl } from '../writing/post-url.js';

const feedUrl = 'https://shxlpa.substack.com/feed';
const maxFeedBytes = 8 * 1024 * 1024;
const fields = new Set(['title', 'link', 'pubDate', 'description']);

function postFrom(item) {
  const url = canonicalPostUrl(item.link?.trim());
  const title = item.title?.trim();
  const timestamp = Date.parse(item.pubDate);
  if (!url || !title || !Number.isFinite(timestamp)) return null;

  // The publication supplies plain-text descriptions. Omit HTML summaries
  // from other feed formats without ever rendering their markup.
  let snippet = (item.description || '').replace(/\s+/g, ' ').trim();
  if (/<(?:\/?[a-z][\w:-]*\b[^>]*|!--[\s\S]*?)>/i.test(snippet)) snippet = '';
  if (snippet.length > 200) snippet = snippet.slice(0, 200).trimEnd() + '…';
  return { title, url, date: new Date(timestamp).toISOString(), snippet };
}

export function parsePosts(xml) {
  const parser = sax.parser(true, { strictEntities: true });
  const path = [];
  const posts = [];
  let hasRoot = false;
  let hasChannel = false;
  let item;
  let itemCount = 0;

  parser.onerror = error => { throw error; };
  parser.ondoctype = parser.onsgmldeclaration = () => { throw new Error('Unexpected XML declaration'); };
  parser.onopentag = ({ name }) => {
    path.push(name);
    if (path.length > 64) throw new Error('Feed is too deeply nested');
    if (path.length === 1) {
      if (hasRoot || name !== 'rss') throw new Error('Expected an RSS feed');
      hasRoot = true;
    } else if (path.length === 2 && name === 'channel') {
      if (hasChannel) throw new Error('Expected one RSS channel');
      hasChannel = true;
    } else if (path.length === 3 && path[1] === 'channel' && name === 'item') {
      item = {};
      itemCount++;
    }
  };
  parser.ontext = parser.oncdata = value => {
    const field = path[3];
    if (item && path.length === 4 && fields.has(field)) {
      item[field] = (item[field] || '') + value;
    }
  };
  parser.onclosetag = () => {
    if (item && path.length === 3) {
      const post = postFrom(item);
      if (post) posts.push(post);
      item = undefined;
    }
    path.pop();
  };
  parser.write(xml).close();
  if (!hasChannel || (itemCount && !posts.length)) throw new Error('Invalid RSS channel');
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

async function readFeed(fetchFeed) {
  const response = await fetchFeed(feedUrl, {
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6000)
  });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxFeedBytes) {
    await response.body?.cancel();
    throw new Error('Feed unavailable');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxFeedBytes) throw new Error('Feed too large');
    chunks.push(chunk);
  }
  return parsePosts(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}

export async function handleWriting(request, fetchFeed = fetch) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  }
  try {
    const posts = await readFeed(fetchFeed);
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
    headers['Vercel-CDN-Cache-Control'] = 'public, max-age=60';
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ posts }), { headers });
  } catch {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'Writing is temporarily unavailable.' }),
      { status: 502, headers });
  }
}

export default { fetch(request) { return handleWriting(request); } };
