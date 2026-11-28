import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Persistent single-host storage. SQLite serializes compare-and-swap updates
// across processes sharing a local disk (not a network filesystem).
export function localStore(directory, {readOnly = false} = {}) {
  if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'everything.sqlite');
  const db = new DatabaseSync(path, {readOnly});
  if (!readOnly) chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;`);
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS objects (
      key TEXT PRIMARY KEY, data BLOB NOT NULL, etag TEXT NOT NULL, expires INTEGER
    );
    DELETE FROM objects WHERE expires <= unixepoch();`);
  const read = db.prepare('SELECT data, etag FROM objects WHERE key = ? AND (expires IS NULL OR expires > unixepoch())');
  const insert = db.prepare(`INSERT INTO objects(key, data, etag, expires) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data, etag=excluded.etag, expires=excluded.expires
    WHERE objects.expires <= unixepoch()`);
  const update = db.prepare('UPDATE objects SET data = ?, etag = ?, expires = ? WHERE key = ? AND etag = ?');
  const remove = db.prepare('DELETE FROM objects WHERE key = ?');
  return {
    async read(key) {
      const record = read.get(key);
      return record ? { data: Buffer.from(record.data), etag: record.etag } : null;
    },
    async write(key, data, etag = null, ttlDays) {
      const next = randomUUID();
      const bytes = Buffer.from(data);
      const expires = ttlDays ? Math.ceil(Date.now() / 1000) + ttlDays * 86400 : null;
      const result = etag === null ? insert.run(key, bytes, next, expires) : update.run(bytes, next, expires, key, etag);
      return result.changes === 1;
    },
    async remove(key) { remove.run(key); },
    close() { db.close(); }
  };
}
