import { createHandler } from '../server/everything.js';
import { privateBlobStore } from '../server/storage.js';

const token = process.env.BLOB_READ_WRITE_TOKEN;
const handle = createHandler({ store: token && privateBlobStore(token), password: process.env.EVERYTHING_PASSWORD });

export default {
  fetch(request) {
    return handle(request, request.headers.get('x-vercel-forwarded-for') || 'unknown');
  }
};
