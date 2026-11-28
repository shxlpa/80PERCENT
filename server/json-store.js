// Storage-neutral helpers. The private server never imports the Blob SDK.
export async function readJson(store, key) {
  const record = await store.read(key);
  if (!record) return null;
  return { value: JSON.parse(record.data.toString()), etag: record.etag };
}
