import test from 'node:test'
import assert from 'node:assert/strict'
import {planPhotoExport, photoExportDimensions, exportPhoto} from '../everything-assets/export.js'

const photo = {id: 'photo', type: 'image', imageId: 'photo.jpg', name: 'Photo.jpg', x: 100, y: 200, width: 300, height: 200}

test('photo export includes only positively overlapping layers above the selected photo, in paint order', () => {
  const below = {...photo, id: 'below', type: 'shape'}
  const partial = {id: 'partial', type: 'text', x: 90, y: 190, width: 30, height: 40}
  const overlay = {...photo, id: 'overlay'}
  const edge = {...photo, id: 'edge', x: 400}
  const outside = {...photo, id: 'outside', y: 500}
  const items = Object.freeze([below, photo, partial, overlay, edge, outside].map(Object.freeze))
  const plan = planPhotoExport(photo, items)
  assert.equal(plan.photo, photo)
  assert.deepEqual(plan.layers.map(item => item.id), ['photo', 'partial', 'overlay'])
  assert.equal(plan.layers[1], partial)
  assert.deepEqual(items.map(item => item.id), ['below', 'photo', 'partial', 'overlay', 'edge', 'outside'])
})

test('photo export requires a selected image belonging to the scene', () => {
  assert.throws(() => planPhotoExport({...photo, id: 'missing'}, [photo]), /Select a photo/)
  assert.throws(() => planPhotoExport(photo, [{...photo, type: 'text'}]), /Select a photo/)
})

test('export uses the stored full-resolution source and preserves a stretched displayed aspect ratio', () => {
  assert.deepEqual(photoExportDimensions(photo, 6000, 4000), {width: 6000, height: 4000, scale: 20})
  assert.deepEqual(photoExportDimensions({...photo, height: 300}, 6000, 4000), {width: 6000, height: 6000, scale: 20})
  assert.deepEqual(photoExportDimensions({...photo, width: 600}, 6000, 4000), {width: 12000, height: 4000, scale: 20})
})

test('oversized or unreadable source dimensions fail explicitly instead of being downscaled', () => {
  assert.throws(() => photoExportDimensions(photo, 40000, 30000), /too large/)
  assert.throws(() => photoExportDimensions(photo, 12000, 8000), /too large/)
  assert.throws(() => photoExportDimensions(photo, NaN, 4000), /could not be read/)
})

test('a source fetch failure exits before creating browser rendering resources', async () => {
  await assert.rejects(exportPhoto({photo, items: [photo], loadImage: async () => { throw new Error('Offline') }}), /Offline/)
})
