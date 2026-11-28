import { localStore } from './local-storage.js';
import { exportBundle, restoreBundle, verifyBundle, verifyStore } from './migration.js';

const [command, source, destination, ...extra] = process.argv.slice(2);
let store;
try {
  if (extra.length) throw new Error('Unexpected arguments.');
  let result;
  if (command === 'export-local' && source && destination) {
    store = localStore(source, {readOnly: true});
    result = await exportBundle(store, destination);
  } else if (command === 'export-blob' && source === '--allow-blob-read' && destination) {
    // The only opt-in network entry point. Never load .env.local or the app token.
    if (!process.env.MIGRATION_BLOB_TOKEN) throw new Error('Set MIGRATION_BLOB_TOKEN explicitly for this one authorized export.');
    const { privateBlobStore } = await import('./storage.js');
    store = privateBlobStore(process.env.MIGRATION_BLOB_TOKEN);
    result = await exportBundle({read: key => store.read(key)}, destination);
  } else if (command === 'restore' && source && destination) {
    result = await restoreBundle(source, destination);
  } else if (command === 'verify-store' && source && destination) {
    store = localStore(destination, {readOnly: true});
    result = await verifyStore(store, source);
  } else if (command === 'verify' && source && !destination) {
    const bundle = await verifyBundle(source);
    result = {revision: bundle.revision, media: bundle.media};
  } else {
    throw new Error('Usage: node server/migrate.js export-local DATA NEW_BACKUP | verify BACKUP | restore BACKUP NEW_DATA | verify-store BACKUP DATA | export-blob --allow-blob-read NEW_BACKUP');
  }
  console.log(JSON.stringify({ok: true, ...result}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.close?.(); }
