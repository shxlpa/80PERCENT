import { canonicalPostUrl } from './post-url.js';

const container = document.getElementById('posts-container');
const status = document.getElementById('posts-status');
const message = document.getElementById('posts-message');
const dates = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'America/Los_Angeles' });
const refreshInterval = 60_000;
let lastRequest = -Infinity;
let loading = false;
let previous = null;

const reveal = 'IntersectionObserver' in window && new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      reveal.unobserve(entry.target);
    }
  }
}, { threshold: 0.1 });

function postCard(post, index) {
  const url = canonicalPostUrl(post?.url);
  if (!url || typeof post.title !== 'string' || !post.title.trim()) return null;
  const link = document.createElement('a');
  link.className = 'writing-entry';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  if (reveal) {
    link.classList.add('reveal');
    if (index < 3) link.classList.add('reveal-delay-' + index);
  }
  const published = Date.parse(post.date);
  if (Number.isFinite(published)) {
    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = dates.format(published);
    link.append(date);
  }
  const heading = document.createElement('h3');
  heading.textContent = post.title;
  link.append(heading);
  if (typeof post.snippet === 'string' && post.snippet) {
    const snippet = document.createElement('p');
    snippet.textContent = post.snippet;
    link.append(snippet);
  }
  return link;
}

async function refreshPosts() {
  if (loading || document.hidden) return;
  loading = true;
  lastRequest = Date.now();
  try {
    const response = await fetch('/api/writing/', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Feed unavailable');
    const { posts } = await response.json();
    if (!Array.isArray(posts)) throw new Error('Invalid feed');
    const snapshot = JSON.stringify(posts);
    if (snapshot !== previous) {
      const cards = posts.map(postCard).filter(Boolean);
      const focusUrl = container.contains(document.activeElement) ? document.activeElement.href : null;
      if (reveal) reveal.disconnect();
      container.replaceChildren(...cards);
      if (reveal) cards.forEach(card => reveal.observe(card));
      if (focusUrl) cards.find(card => card.href === focusUrl)?.focus({ preventScroll: true });
      previous = snapshot;
    }
    status.hidden = Boolean(container.childElementCount);
    if (!status.hidden) message.textContent = 'No published posts yet.';
  } catch {
    message.textContent = container.childElementCount ? 'The post list could not be refreshed.' : 'The latest posts could not be loaded.';
    status.hidden = false;
  } finally {
    loading = false;
  }
}

function refreshWhenReturning() {
  if (Date.now() - lastRequest >= refreshInterval) refreshPosts();
}

refreshPosts();
window.setInterval(refreshPosts, refreshInterval);
document.addEventListener('visibilitychange', refreshWhenReturning);
window.addEventListener('pageshow', refreshWhenReturning);
