// Offline, lossless board backups. No network code and no session/credential export.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validBoard, imageExtension } from './validation.js';
import { localStore } from './local-storage.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mediaKeys = board => [...new Set(board.items.filter(item => item.type === 'image').map(item => 'images/' + item.imageId))].sort();
function parseBoard(bytes) {
  const board = JSON.parse(bytes.toString());
  if (!validBoard(board)) throw new Error('Invalid board; refusing an incomplete backup.');
  return board;
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists; never overwrite a backup or database.');
}
async function privateRead(root, key) {
  // Keys are derived only from a validated board, not from manifest paths.
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Unsafe backup directory.');
  if (key.startsWith('images/') && !(await lstat(join(root, 'images'))).isDirectory()) throw new Error('Unsafe media directory.');
  if (key.startsWith('images/') && (await lstat(join(root, 'images'))).isSymbolicLink()) throw new Error('Unsafe media directory.');
  const path = join(root, key);
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('Unsafe backup file.');
  return readFile(path);
}

export async function verifyBundle(directory) {
  const manifest = JSON.parse((await privateRead(directory, 'manifest.json')).toString());
  if (manifest.format !== 'everything-backup-v1' || !Array.isArray(manifest.objects)) throw new Error('Unsupported backup format.');
  const bytes = await privateRead(directory, 'board.json');
  const board = parseBoard(bytes);
  if (manifest.revision !== board.revision) throw new Error('Backup revision mismatch.');
  const keys = ['board.json', ...mediaKeys(board)];
  if (JSON.stringify(manifest.objects.map(object => object.key)) !== JSON.stringify(keys)) throw new Error('Incomplete or duplicate backup inventory.');
  const objects = [];
  for (const [index, key] of keys.entries()) {
    const data = key === 'board.json' ? bytes : await privateRead(directory, key);
    const record = manifest.objects[index];
    if (record.bytes !== data.length || record.sha256 !== hash(data)) throw new Error('Backup checksum mismatch.');
    if (key !== 'board.json' && imageExtension(data) !== key.split('.').pop()) throw new Error('Image format mismatch.');
    objects.push({key, data});
  }
  return {revision: board.revision, media: keys.length - 1, objects};
}

export async function exportBundle(store, destination) {
  destination = resolve(destination);
  await absent(destination);
  const stage = join(dirname(destination), '.everything-backup-' + randomUUID());
  await mkdir(stage, {mode: 0o700});
  try {
    const first = await store.read('board.json');
    if (!first) throw new Error('Board is missing; refusing an empty backup.');
    const board = parseBoard(first.data);
    const objects = [];
    await mkdir(join(stage, 'images'), {mode: 0o700});
    for (const key of ['board.json', ...mediaKeys(board)]) {
      const record = key === 'board.json' ? first : await store.read(key);
      if (!record) throw new Error('Referenced media is missing; backup aborted.');
      await writeFile(join(stage, key), record.data, {mode: 0o600, flag: 'wx', flush: true});
      objects.push({key, bytes: record.data.length, sha256: hash(record.data)});
    }
    const last = await store.read('board.json');
    if (!last || first.etag !== last.etag || !first.data.equals(last.data)) throw new Error('Board changed during backup; stop editing and retry.');
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({format: 'everything-backup-v1', revision: board.revision, objects}, null, 2) + '\n', {mode: 0o600, flag: 'wx', flush: true});
    const verified = await verifyBundle(stage);
    // An exclusive reservation prevents racing another export to this destination.
    await mkdir(destination, {mode: 0o700});
    try { await rename(stage, destination); } catch (error) { await rm(destination, {recursive: true}); throw error; }
    return {revision: verified.revision, media: verified.media};
  } finally { await rm(stage, {recursive: true, force: true}); }
}

export async function verifyStore(store, directory) {
  const bundle = await verifyBundle(directory);
  for (const object of bundle.objects) {
    const current = await store.read(object.key);
    if (!current || !current.data.equals(object.data)) throw new Error('Restored store differs from backup.');
  }
  return {revision: bundle.revision, media: bundle.media};
}

export async function restoreBundle(directory, destination) {
  const bundle = await verifyBundle(directory);
  destination = resolve(destination);
  await absent(destination);
  const stage = join(dirname(destination), '.everything-restore-' + randomUUID());
  let store;
  try {
    store = localStore(stage);
    for (const object of bundle.objects) {
      if (!await store.write(object.key, object.data)) throw new Error('Restore collision.');
    }
    await verifyStore(store, directory);
    store.close(); store = null;
    // Reopen the disk database and verify before making it eligible for serving.
    store = localStore(stage, {readOnly: true});
    const result = await verifyStore(store, directory);
    store.close(); store = null;
    await mkdir(destination, {mode: 0o700});
    try { await rename(stage, destination); } catch (error) { await rm(destination, {recursive: true}); throw error; }
    return result;
  } finally { store?.close(); await rm(stage, {recursive: true, force: true}); }
}
