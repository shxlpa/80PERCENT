// Persistent private hosting. Intentionally no .env.local loading or Blob fallback.
import { isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { localStore } from './local-storage.js';
import { createEverythingServer, servingOrigin } from './http-server.js';

const { EVERYTHING_PASSWORD: password, EVERYTHING_DATA_DIR: directory, EVERYTHING_ORIGIN: configured } = process.env;
if (!password || !directory || !isAbsolute(directory) || !configured) {
  throw new Error('Set EVERYTHING_PASSWORD, an absolute EVERYTHING_DATA_DIR, and EVERYTHING_ORIGIN.');
}
const origin = servingOrigin(configured);
if (!origin.startsWith('https://')) throw new Error('Private hosting requires an HTTPS origin.');
// A typo in the data path must never produce a silently empty production board.
if (!(await stat(join(directory, 'everything.sqlite'))).isFile()) throw new Error('Restore a verified database before serving.');
const store = localStore(directory);
const server = await createEverythingServer({store, password, origin});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Everything is available at ${origin}/everything/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
