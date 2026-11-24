const publication = 'https://shxlpa.substack.com';

export function canonicalPostUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== publication || url.username || url.password) return null;
    if (!/^\/p\/[\p{L}\p{M}\p{N}_-]+\/?$/u.test(decodeURIComponent(url.pathname))) return null;
    return publication + url.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}
