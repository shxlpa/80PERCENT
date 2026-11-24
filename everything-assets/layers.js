const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const itemId = new RegExp('^' + uuid + '$');
export const imageId = new RegExp('^' + uuid + '\\.(png|jpg|gif|webp|avif|bmp|ico)$');
const between = (n, low, high) => Number.isFinite(n) && n >= low && n <= high;
const color = value => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);

export function validItem(item) {
  if (!item || typeof item.id !== 'string' || !itemId.test(item.id) ||
      !between(item.x, -1e9, 1e9) || !between(item.y, -1e9, 1e9) ||
      !between(item.width, 0.01, 1e7) || !between(item.height, 0.01, 1e7)) return false;
  switch (item.type) {
    case 'shape': return ['rectangle', 'ellipse', 'triangle'].includes(item.shape) && color(item.color);
    case 'text': return typeof item.text === 'string' && item.text.length <= 200000 &&
      typeof item.font === 'string' && item.font.length <= 100 && between(item.fontSize, 1, 2048) && color(item.color);
    case 'image': return typeof item.imageId === 'string' && imageId.test(item.imageId) && typeof item.name === 'string' && item.name.length <= 1024;
    default: return false;
  }
}
