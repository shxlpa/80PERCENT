import { validItem } from '../everything-assets/layers.js';

export { imageId } from '../everything-assets/layers.js';
export const imageTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };

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
