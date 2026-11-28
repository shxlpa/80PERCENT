import { createHandler } from '../server/everything.js';

// Vercel has no persistent local disk. Fail closed instead of silently using
// Blob or an ephemeral SQLite database. Run server/serve.js on the private host.
const handle = createHandler({store: null, password: null});
export default { fetch(request) { return handle(request); } };
