import { localStore } from './local-storage.js';
import { createEverythingServer } from './http-server.js';

const port = Number(process.env.PORT || 3000);
const origin = process.env.EVERYTHING_ORIGIN || `http://127.0.0.1:${port}`;
const store = localStore(process.env.EVERYTHING_DATA_DIR || '.everything-data');
const server = await createEverythingServer({store, password: process.env.EVERYTHING_PASSWORD, origin});
server.listen(port, '127.0.0.1', () => console.log(`Everything is available at ${origin}/everything/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
