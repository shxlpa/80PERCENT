import { deflateSync } from 'node:zlib';

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
  return Buffer.concat([size, body, checksum]);
}
export function fixturePNG(width, height, variant = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    const ridge = y > height * (.65 + .1 * Math.sin(x / 67));
    pixels[at] = ridge ? 28 : 230 - Math.floor(y / height * 90);
    pixels[at + 1] = ridge ? 40 + variant * 20 : 95 + Math.floor(x / width * 80);
    pixels[at + 2] = ridge ? 57 : 72 + Math.floor(y / height * 70) + variant * 20;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const board = {revision: 37, items: [
  {id: id(1), type: 'image', imageId: id(91) + '.png', name: 'Synthetic landscape.png', x: -340, y: -180, width: 480, height: 320},
  {id: id(2), type: 'shape', shape: 'rectangle', color: '#f5e6cc', x: -300, y: -130, width: 220, height: 80},
  {id: id(3), type: 'text', text: 'a quiet afternoon', font: 'DM Sans', fontSize: 22, color: '#252724', italic: true, x: -285, y: -115, width: 195, height: 52},
  {id: id(4), type: 'image', imageId: id(92) + '.png', name: 'Synthetic portrait.png', x: 200, y: -180, width: 180, height: 320},
  {id: id(5), type: 'text', text: 'field notes\n37 / November', font: 'DM Mono', fontSize: 19, color: '#7a3d29', x: -300, y: 195, width: 270, height: 65},
  {id: id(6), type: 'shape', shape: 'ellipse', color: '#c6b78e', x: 190, y: 180, width: 80, height: 80},
  {id: id(7), type: 'image', imageId: id(91) + '.png', name: 'Reused landscape.png', x: 410, y: 190, width: 120, height: 80}
]};
export const media = new Map([
  ['images/' + id(91) + '.png', fixturePNG(1200, 800)],
  ['images/' + id(92) + '.png', fixturePNG(720, 1280, 1)]
]);
export const boardBytes = Buffer.from(JSON.stringify(board, null, 2) + '\n');
export async function seed(store) {
  for (const [key, bytes] of media) await store.write(key, bytes);
  await store.write('board.json', boardBytes);
}
