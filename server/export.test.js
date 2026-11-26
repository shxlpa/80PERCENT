import test from 'node:test'
import assert from 'node:assert/strict'
import {planPhotoExport, photoExportDimensions, photoExportFrame, exportPhoto} from '../everything-assets/export.js'

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

test('Instagram frames center the unchanged content in the smallest integer 3:4 canvas', () => {
  assert.deepEqual(photoExportFrame(4000, 6000, 'instagram'), {width: 4500, height: 6000, left: 250, top: 0})
  assert.deepEqual(photoExportFrame(6000, 4000, 'instagram'), {width: 6000, height: 8000, left: 0, top: 2000})
  assert.deepEqual(photoExportFrame(3000, 4000, 'instagram'), {width: 3000, height: 4000, left: 0, top: 0})
  assert.deepEqual(photoExportFrame(1152, 2048, 'instagram'), {width: 1536, height: 2048, left: 192, top: 0})
  const odd = photoExportFrame(1001, 1501, 'instagram')
  assert.deepEqual(odd, {width: 1128, height: 1504, left: 63, top: 1})
  assert.equal(odd.width * 4, odd.height * 3)
  assert.equal(Math.abs(odd.left - (odd.width - 1001 - odd.left)), 1)
  assert.equal(Math.abs(odd.top - (odd.height - 1501 - odd.top)), 1)
  assert.deepEqual(photoExportFrame(4000, 6000), {width: 4000, height: 6000, left: 0, top: 0})
})

test('padded final dimensions obey the same memory and edge limits without resizing content', () => {
  assert.doesNotThrow(() => photoExportFrame(8000, 8000))
  assert.throws(() => photoExportFrame(8000, 8000, 'instagram'), /too large/)
  assert.doesNotThrow(() => photoExportFrame(32766, 1))
  assert.throws(() => photoExportFrame(32766, 1, 'instagram'), /too large/)
})

test('unsupported export formats fail before fetching images', async () => {
  let loads = 0
  await assert.rejects(exportPhoto({photo, items: [photo], format: 'square', loadImage: async () => { loads++ }}), /export format/)
  assert.equal(loads, 0)
})

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {configurable: true, writable: true, value})
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  })
}

test('Instagram paints white before clipping and centers full-size photo layers without stretching', async t => {
  const calls = []
  let closed = 0, removed = 0
  const bitmap = {width: 600, height: 900, close() { closed++ }}
  replaceGlobal(t, 'createImageBitmap', async () => bitmap)
  const context = {
    fillStyle: '',
    fillRect(...args) { calls.push(['fillRect', this.fillStyle, ...args]) },
    getImageData() { return {data: [1, 2, 3, 255]} },
    clearRect(...args) { calls.push(['clearRect', ...args]) },
    setTransform(...args) { calls.push(['transform', ...args]) },
    beginPath() {},
    rect(...args) { calls.push(['rect', ...args]) },
    clip() { calls.push(['clip']) },
    drawImage(source, ...args) { assert.equal(source, bitmap); calls.push(['image', ...args]) },
    fill() { calls.push(['shape', this.fillStyle]) },
  }
  const canvas = {width: 0, height: 0, getContext: () => context,
    toBlob(callback, type) { calls.push(['encode', this.width, this.height]); callback(new Blob(['png'], {type})) }}
  replaceGlobal(t, 'document', {
    createElement(name) {
      if (name === 'canvas') return canvas
      return {style: {}, setAttribute() {}, remove() { removed++ }}
    },
    body: {append() {}},
  })
  const portrait = {...photo, width: 300, height: 450}
  const overlay = {id: 'shape', type: 'shape', shape: 'rectangle', color: '#ff0000', x: 90, y: 220, width: 40, height: 30}
  const result = await exportPhoto({photo: portrait, items: [portrait, overlay], loadImage: async () => new Blob(['photo']), format: 'instagram'})
  assert.equal(result.width, 675)
  assert.equal(result.height, 900)
  assert.equal(result.filename, 'Photo-instagram-3x4.png')
  assert.equal(result.blob.type, 'image/png')
  assert.deepEqual(calls.slice(2), [
    ['fillRect', '#ffffff', 0, 0, 675, 900],
    ['transform', 2, 0, 0, 2, 37, 0],
    ['rect', 0, 0, 300, 450], ['clip'],
    ['image', 0, 0, 300, 450],
    ['rect', -10, 20, 40, 30], ['shape', '#ff0000'],
    ['encode', 675, 900],
  ])
  assert.equal(closed, 1)
  assert.equal(removed, 1)
  assert.equal(canvas.width, 1)
  assert.equal(canvas.height, 1)

  calls.length = 0
  const original = await exportPhoto({photo: portrait, items: [portrait], loadImage: async () => new Blob(['photo'])})
  assert.equal(original.width, 600)
  assert.equal(original.height, 900)
  assert.equal(original.filename, 'Photo-with-overlays.png')
  assert.equal(calls.some(call => call[0] === 'fillRect' && call[1] === '#ffffff'), false)
  assert.deepEqual(calls.find(call => call[0] === 'transform'), ['transform', 2, 0, 0, 2, 0, 0])
})
