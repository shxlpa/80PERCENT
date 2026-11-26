import assert from 'node:assert/strict'
import {test} from 'node:test'
import {snapMove, snapResize} from '../everything-assets/snapping.js'

const image = (id, x, y, width, height) => ({id, type: 'image', x, y, width, height})
const text = (id, x, y, width, height) => ({id, type: 'text', x, y, width, height})

test('text centers on an image horizontally and vertically with visible guide coordinates', () => {
  const moving = text('caption', 132, 62, 40, 20)
  const target = image('photo', 100, 20, 100, 100)
  const result = snapMove([moving], [target], 1)
  assert.deepEqual([result.dx, result.dy], [-2, -2])
  assert.ok(result.guides.some(guide => guide.axis === 'x' && guide.value === 150))
  assert.ok(result.guides.some(guide => guide.axis === 'y' && guide.value === 70))
  for (const guide of result.guides) {
    assert.ok([guide.value, guide.from, guide.to].every(Number.isFinite))
    assert.ok(guide.from <= guide.to)
  }
  assert.deepEqual(moving, text('caption', 132, 62, 40, 20), 'geometry remains immutable')
})

test('images snap adjacent edges and align their tops', () => {
  const result = snapMove([image('moving', 204, 25, 80, 70)], [image('target', 100, 20, 100, 100)], 1)
  assert.deepEqual([result.dx, result.dy], [-4, -5])
  assert.ok(result.guides.some(guide => guide.axis === 'x' && guide.value === 200))
  assert.ok(result.guides.some(guide => guide.axis === 'y' && guide.value === 20))
})

test('move snapping uses a six-screen-pixel threshold at every zoom', () => {
  const target = image('target', 100, 20, 100, 100)
  for (const zoom of [.5, 1, 2]) {
    const distance = 6 / zoom
    const within = snapMove([image('moving', 200 + distance, 20, 80, 70)], [target], zoom)
    assert.equal(within.dx, -distance)
    const outside = snapMove([image('moving', 200 + distance + .1 / zoom, 20, 80, 70)], [target], zoom)
    assert.equal(outside.dx, 0)
  }
})

test('multiple selected layers snap their shared bounds as one group', () => {
  const moving = [text('a', 101, 50, 20, 20), text('b', 161, 90, 20, 20)]
  const result = snapMove(moving, [image('target', 90, 20, 100, 100)], 1)
  assert.deepEqual([result.dx, result.dy], [-1, 0])
  assert.ok(result.guides.some(guide => guide.axis === 'x' && guide.value === 140))
  assert.deepEqual(snapMove(moving, [], 1), {dx: 0, dy: 0, guides: []})
})

test('text aligns to corresponding local placement across neighboring inline images', () => {
  const first = image('first', 0, 0, 200, 100)
  const reference = text('reference', 40, 30, 60, 20)
  for (const [next, moving] of [
    [image('next', 240, 0, 200, 100), text('moving', 283, 33, 60, 20)],
    [image('next', 0, 140, 200, 100), text('moving', 43, 173, 60, 20)],
  ]) {
    const result = snapMove([moving], [first, next, reference], 1)
    assert.deepEqual([result.dx, result.dy], [-3, -3])
    assert.ok(result.guides.length >= 2)
  }
})

test('resizing to match image height preserves aspect ratio and the opposite corner', () => {
  for (const [original, candidate, handle, target, expected] of [
    [image('moving', 10, 20, 200, 100), image('moving', 10, 20, 294, 147), 'se',
      image('target', 350, 25, 180, 150), {x: 10, y: 20, width: 300, height: 150}],
    [image('moving', 200, 200, 200, 100), image('moving', 106, 153, 294, 147), 'nw',
      image('target', 500, 200, 180, 150), {x: 100, y: 150, width: 300, height: 150}],
  ]) {
    const {item, guides} = snapResize(original, candidate, handle, [target], 1, true)
    const {x, y, width, height} = item
    assert.deepEqual({x, y, width, height}, expected)
    assert.equal(width / height, original.width / original.height)
    assert.ok(guides.length > 0)
    const fixedX = handle.includes('w') ? x + width : x
    const fixedY = handle.includes('n') ? y + height : y
    assert.equal(fixedX, handle.includes('w') ? original.x + original.width : original.x)
    assert.equal(fixedY, handle.includes('n') ? original.y + original.height : original.y)
  }
})

test('free resize matches height independently and respects the screen-space tolerance', () => {
  const original = image('moving', 10, 20, 200, 100)
  const candidate = image('moving', 10, 20, 294, 147)
  const target = image('target', 350, 25, 180, 150)
  const {item} = snapResize(original, candidate, 'se', [target], 1, false)
  assert.equal(item.height, 150)
  assert.equal(item.width, 294)
  const outside = snapResize(original, candidate, 'se', [target], 3, false)
  assert.deepEqual(outside.item, candidate)
  assert.deepEqual(outside.guides, [])
})

test('panorama resize rejects a nearby height that would pull the other edge far from the pointer', () => {
  const original = image('moving', 0, 0, 9900, 99)
  const candidate = image('moving', 0, 0, 10000, 100)
  const target = image('target', 10020, 15, 200, 101)
  const constrained = snapResize(original, candidate, 'se', [target], 1, true)
  assert.deepEqual(constrained.item, candidate)
  assert.deepEqual(constrained.guides, [])
  const free = snapResize(original, candidate, 'se', [target], 1, false)
  assert.equal(free.item.height, 101, 'the height is close enough when width is unconstrained')
  assert.equal(free.item.width, 10000)
})

test('neighboring image rows prefer matching height and columns prefer matching width', () => {
  const rowReference = image('reference', 100, 140, 300, 400)
  const rowOriginal = image('moving', 400, 140, 290, 387)
  const rowCandidate = {...rowOriginal, width: 298.5, height: 298.5 * 387 / 290}
  const row = snapResize(rowOriginal, rowCandidate, 'se', [rowReference], 1, true)
  assert.equal(row.item.height, 400, 'equal row heights take precedence over a slightly closer width')
  assert.ok(Math.abs(row.item.width - 400 * 290 / 387) < 1e-9)
  assert.deepEqual([row.item.x, row.item.y], [400, 140])
  assert.ok(row.guides.some(guide => guide.axis === 'y' && guide.value === 540))

  const columnReference = image('reference', 140, 100, 400, 300)
  const columnOriginal = image('moving', 140, 400, 387, 290)
  const columnCandidate = {...columnOriginal, width: 298.5 * 387 / 290, height: 298.5}
  const column = snapResize(columnOriginal, columnCandidate, 'se', [columnReference], 1, true)
  assert.equal(column.item.width, 400, 'equal column widths take precedence over a slightly closer height')
  assert.ok(Math.abs(column.item.height - 400 * 290 / 387) < 1e-9)
  assert.deepEqual([column.item.x, column.item.y], [140, 400])
  assert.ok(column.guides.some(guide => guide.axis === 'x' && guide.value === 540))
})

test('a widely scattered selection only snaps when every selected position stays within world bounds', () => {
  for (const axis of ['x', 'y']) {
    const orient = item => axis === 'x' ? item : {...item, x: item.y, y: item.x, width: item.height, height: item.width}
    for (const margin of [0, 3]) {
      const moving = [
        image('negative', -1e9 + margin, 0, 10, 10),
        image('positive', 1e9 - margin, 0, 10, 10),
        image('middle', 0, 0, 10, 10),
      ].map(orient)
      for (const delta of [-2, 2]) {
        const target = orient(image('target', delta - 50, 0, 110, 10))
        const result = snapMove(moving, [target], 1)
        const correction = axis === 'x' ? result.dx : result.dy
        assert.equal(correction, margin ? delta : 0)
        assert.equal(result.guides.some(guide => guide.axis === axis), Boolean(margin))
        assert.ok(moving.every(item => Math.abs(item[axis] + correction) <= 1e9))
      }
    }
  }
})
