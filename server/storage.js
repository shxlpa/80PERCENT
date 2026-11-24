import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob';

const prefix = 'everything/';

// A null ETag means "create only". Otherwise compare and swap the exact
// version that was read. Both adapters use the same contract.
export function privateBlobStore(token) {
  const privateOptions = { token, access: 'private' };
  return {
    async read(key) {
      // Compressed responses carry weak ETags. Conditional writes need the strong
      // ETag of the stored bytes, including when a board grows past the compression threshold.
      const result = await get(prefix + key, {
        ...privateOptions, useCache: false, headers: { 'Accept-Encoding': 'identity' }
      });
      if (!result) return null;
      return { data: Buffer.from(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
    },
    async write(key, data, etag = null, ttlDays) {
      if (etag !== null && (!etag || etag.startsWith('W/'))) {
        throw new Error('A conditional write requires a strong storage ETag.');
      }
      try {
        await put(prefix + key, data, {
          ...privateOptions, addRandomSuffix: false, contentType: 'application/octet-stream',
          ...(etag === null ? { allowOverwrite: false } : { ifMatch: etag }),
          ...(ttlDays && { ttlDays })
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        // Competing first creates may yield a generic SDK error. Verify the
        // destination before returning a conflict; outages remain failures.
        if (etag === null) {
          const existing = await get(prefix + key, { ...privateOptions, useCache: false });
          if (existing) {
            await existing.stream?.cancel();
            return false;
          }
        }
        throw error;
      }
    },
    async remove(key) {
      await del(prefix + key, { token });
    }
  };
}

export async function readJson(store, key) {
  const record = await store.read(key);
  if (!record) return null;
  return { value: JSON.parse(record.data.toString()), etag: record.etag };
}
