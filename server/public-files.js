import { extname } from 'node:path';

// These are the only source directories copied to the static deployment.
export const publicEntries = [
  'index.html', 'styles.css', 'assets', 'design',
  'old', 'photography', 'resume', 'technical-work', 'writing', 'everything-assets'
];

export function isPublicPath(relative) {
  const parts = relative.split('/');
  return publicEntries.includes(parts[0]) && parts.every(part => part && !part.startsWith('.'));
}

export function contentType(pathname) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.mov': 'video/quicktime', '.heic': 'image/heic', '.json': 'application/json'
  };
  return types[extname(pathname).toLowerCase()] || 'application/octet-stream';
}
