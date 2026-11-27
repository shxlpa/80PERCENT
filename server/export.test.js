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

test('Instagram preserves source-resolution content inside the smallest integer 4:5 frame', () => {
  assert.deepEqual(photoExportFrame(1152, 2048, 'instagram'),
    {width: 1640, height: 2050, left: 244, top: 1, scale: 1})
  assert.deepEqual(photoExportFrame(4000, 6000, 'instagram'), {width: 4800, height: 6000, left: 400, top: 0, scale: 1})
  assert.deepEqual(photoExportFrame(6000, 4000, 'instagram'), {width: 6000, height: 7500, left: 0, top: 1750, scale: 1})
  assert.deepEqual(photoExportFrame(4000, 4000, 'instagram'), {width: 4000, height: 5000, left: 0, top: 500, scale: 1})
  assert.deepEqual(photoExportFrame(4000, 5000, 'instagram'), {width: 4000, height: 5000, left: 0, top: 0, scale: 1})
  for (const [width, height] of [[1001, 1501], [1000, 5000], [307, 480]]) {
    const frame = photoExportFrame(width, height, 'instagram')
    assert.equal(frame.width * 5, frame.height * 4)
    assert.equal(frame.scale, 1)
    assert.ok(frame.width >= width)
    assert.ok(frame.height >= height)
    assert.ok(frame.width - 4 < width || frame.height - 5 < height)
    assert.ok(Number.isInteger(frame.left) && Number.isInteger(frame.top))
    assert.ok(Math.abs(frame.left - (frame.width - width - frame.left)) <= 1)
    assert.ok(Math.abs(frame.top - (frame.height - height - frame.top)) <= 1)
  }
  assert.deepEqual(photoExportFrame(4000, 6000), {width: 4000, height: 6000, left: 0, top: 0, scale: 1})
})

test('Instagram checks source and padded dimensions instead of silently reducing resolution', () => {
  assert.throws(() => photoExportFrame(12000, 18000), /too large/)
  assert.throws(() => photoExportFrame(12000, 18000, 'instagram'), /too large/)
  assert.doesNotThrow(() => photoExportFrame(8000, 8000))
  assert.throws(() => photoExportFrame(8000, 8000, 'instagram'), /too large/)
  assert.throws(() => photoExportFrame(32768, 1), /too large/)
  assert.throws(() => photoExportFrame(32768, 1, 'instagram'), /too large/)
  assert.throws(() => photoExportFrame(NaN, 6000, 'instagram'), /too large/)
  assert.throws(() => photoExportFrame(0, 6000, 'instagram'), /too large/)
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

test('Instagram paints white before clipping and keeps photo layers at original export resolution', async t => {
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
  assert.equal(result.width, 720)
  assert.equal(result.height, 900)
  assert.equal(result.filename, 'Photo-instagram-4x5.png')
  assert.equal(result.blob.type, 'image/png')
  assert.deepEqual(calls.slice(2), [
    ['fillRect', '#ffffff', 0, 0, 720, 900],
    ['transform', 2, 0, 0, 2, 60, 0],
    ['rect', 0, 0, 300, 450], ['clip'],
    ['image', 0, 0, 300, 450],
    ['rect', -10, 20, 40, 30], ['shape', '#ff0000'],
    ['encode', 720, 900],
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

  // Padding can exceed the limit even though the source itself still fits.
  // The exporter must reject that case before allocating, never downsample it.
  bitmap.width = 8000
  bitmap.height = 8000
  const square = {...photo, width: 300, height: 300}
  calls.length = 0
  await assert.rejects(exportPhoto({photo: square, items: [square], loadImage: async () => new Blob(['photo']), format: 'instagram'}), /too large/)
  assert.equal(calls.length, 0)
  const largeSource = await exportPhoto({photo: square, items: [square], loadImage: async () => new Blob(['photo'])})
  assert.equal(largeSource.width, 8000)
  assert.equal(largeSource.height, 8000)
  assert.deepEqual(calls.find(call => call[0] === 'encode'), ['encode', 8000, 8000])
})
