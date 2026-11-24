const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const itemId = new RegExp('^' + uuid + '$');
export const imageId = new RegExp('^' + uuid + '\\.(png|jpg|gif|webp|avif|bmp|ico)$');
export const imageTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };
const between = (n, low, high) => Number.isFinite(n) && n >= low && n <= high;
const color = value => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);

function validItem(item) {
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

export function validBoard(board) {
  return Number.isSafeInteger(board?.revision) && board.revision >= 0 && Array.isArray(board.items) &&
    board.items.length <= 10000 && board.items.every(validItem) &&
    new Set(board.items.map(item => item.id)).size === board.items.length;
}

export function imageExtension(bytes) {
  if (bytes.length < 12) return;
  const ascii = (start, end) => bytes.toString('ascii', start, end);
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /avif|avis/.test(ascii(8, Math.min(bytes.length, 64)))) return 'avif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (bytes.readUInt32BE(0) === 0x00000100) return 'ico';
}
