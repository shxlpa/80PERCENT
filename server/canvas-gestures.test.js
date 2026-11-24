import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvas } from '../everything-assets/canvas.js'
import { parseLayer } from '../everything-assets/clipboard.js'

// A DOM surface for the actual canvas listeners. All input handling, geometry and
// object updates run through createCanvas; the fixture supplies only the browser APIs it touches.
class Surface extends EventTarget {
  children = []
  dataset = {}
  style = {setProperty(name, value) { this[name] = value }}
  classList = {add() {}}
  clientWidth = 800
  clientHeight = 600

  get firstElementChild() { return this.children[0] }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] }
  getBoundingClientRect() { return {left: 0, top: 0} }
  hasAttribute() { return false }
  setAttribute() {}
  captures = new Set()
  setPointerCapture(id) { this.captures.add(id) }
  hasPointerCapture(id) { return this.captures.has(id) }
  releasePointerCapture(id) { this.captures.delete(id) }
  focus() {}
  closest(selector) { return selector === '.ec-node' && this.className === 'ec-node' ? this : null }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  append(child) { this.insertBefore(child, null) }
  insertBefore(child, next) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = this.children.indexOf(next)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parent = this
  }
}

function board(t) {
  globalThis.document = Object.assign(new EventTarget(), {createElement: () => new Surface()})
  globalThis.window = new EventTarget()
  t.after(() => { delete globalThis.document; delete globalThis.window })
  const viewport = new Surface()
  const world = new Surface()
  const shape = {id: 'a', type: 'shape', shape: 'rectangle', color: '#ffffff', x: 10, y: 20, width: 50, height: 60}
  let state, changes = 0
  const canvas = createCanvas({viewport, world, items: [shape], onState: next => { state = next },
    onChange: () => { changes++ }})
  const shapeNode = world.children.find(node => node.dataset.id === shape.id)
  function emit(type, properties = {}, target = viewport) {
    const {timeStamp, ...fields} = properties
    const event = Object.assign(new Event(type, {cancelable: true}), fields)
    if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', {value: timeStamp})
    // Browser pointer events with a layer as their target bubble to the viewport listener.
    Object.defineProperty(event, 'target', {value: target})
    viewport.dispatchEvent(event)
  }
  function transform() {
    const match = world.style.transform.match(/^translate\(([^,]+)px,\s*([^)]+)px\) scale\(([^)]+)\)$/)
    assert.ok(match, world.style.transform)
    const [x, y, zoom] = match.slice(1).map(Number)
    assert.ok([x, y, zoom, state.zoom].every(Number.isFinite), 'Nonfinite camera: ' + world.style.transform)
    assert.ok(zoom > 0)
    return {x, y, zoom}
  }
  function camera() {
    const value = transform()
    assert.equal(state.zoom, value.zoom)
    return value
  }
  function screenBox(id) {
    const {x, y, zoom} = transform()
    const {style} = world.children.find(node => node.dataset.id === id)
    const localScale = style.transform ? Number(style.transform.slice(6, -1)) : 1
    return {
      left: x + zoom * parseFloat(style.left), top: y + zoom * parseFloat(style.top),
      width: zoom * localScale * parseFloat(style.width), height: zoom * localScale * parseFloat(style.height),
    }
  }
  return {canvas, camera, emit, shapeNode, viewport, screenBox, zoom: () => state.zoom, changes: () => changes}
}

test('a malformed Safari pinch cannot poison later pinch, wheel, or fit zooms', t => {
  const {canvas, camera, emit} = board(t)
  emit('gesturestart', {clientX: 160, clientY: 140})
  for (const scale of [undefined, NaN, Infinity, 0, -1]) {
    emit('gesturechange', {scale, clientX: 160, clientY: 140})
    assert.equal(camera().zoom, 1)
  }
  emit('gesturechange', {scale: 2, clientX: 160, clientY: 140, timeStamp: 20})
  assert.equal(camera().zoom, 1.04 ** 2)
  emit('gestureend')

  emit('wheel', {ctrlKey: true, deltaX: 0, deltaY: -20, clientX: 160, clientY: 140, timeStamp: 300})
  assert.ok(camera().zoom > 1.04 ** 2)
  canvas.zoomToFit()
  assert.equal(camera().zoom, 1.5)
  canvas.zoomToActual()
  assert.equal(camera().zoom, 1)
})

test('incomplete coordinates and wheel deltas leave the canvas pannable', t => {
  const {canvas, camera, emit} = board(t)
  emit('gesturestart', {clientX: 20})
  emit('gesturechange', {scale: 1.25, clientX: 90, clientY: NaN})
  camera()
  emit('gestureend')
  emit('wheel', {deltaX: Infinity, deltaY: NaN})
  camera()
  emit('wheel', {ctrlKey: true, deltaX: 0, deltaY: NaN, clientX: 80, clientY: 22})
  camera()

  canvas.setTool('hand')
  emit('pointerdown', {button: 0, pointerId: 1, clientX: 40, clientY: 70})
  emit('pointermove', {pointerId: 1, clientX: 60, clientY: NaN})
  const before = camera()
  emit('pointerup', {pointerId: 1, clientX: 40, clientY: 70})
  emit('pointerdown', {button: 0, pointerId: 2, clientX: 40, clientY: 70})
  emit('pointermove', {pointerId: 2, clientX: 52, clientY: 91})
  emit('pointerup', {pointerId: 2, clientX: 52, clientY: 91})
  assert.deepEqual(camera(), {...before, x: before.x + 12, y: before.y + 21})
})

test('lost pointer capture cancels the draft so the next pointer can move a layer', t => {
  const {canvas, camera, emit, shapeNode} = board(t)
  emit('gesturestart')
  emit('gesturechange', {scale: NaN})
  emit('gestureend')
  assert.equal(camera().zoom, 1)
  const start = {button: 0, pointerId: 5, clientX: 20, clientY: 25}
  emit('pointerdown', start, shapeNode)
  emit('pointerup', {pointerId: 5, clientX: NaN})
  assert.deepEqual(canvas.getItems().map(({x, y}) => [x, y]), [[10, 20]])

  emit('pointerdown', start, shapeNode)
  emit('pointermove', {...start, clientX: 60})
  emit('lostpointercapture', {pointerId: 5})
  assert.equal(canvas.canReplaceItems(), true)
  assert.equal(canvas.getItems()[0].x, 10)

  emit('pointerdown', {...start, pointerId: 7}, shapeNode)
  emit('pointermove', {...start, pointerId: 7, clientX: 42, clientY: 65})
  emit('pointerup', {...start, pointerId: 7, clientX: 42, clientY: 65})
  const [item] = canvas.getItems()
  assert.deepEqual([item.x, item.y], [32, 60])
})

test('fit shows far-scattered layers in a narrow viewport without changing the scene', t => {
  const {canvas, viewport, screenBox, zoom, changes} = board(t)
  viewport.clientWidth = 280
  viewport.clientHeight = 180
  const shape = canvas.getItems()[0]
  canvas.setItems([
    {...shape, id: 'west', x: -1e9, y: 1e9, width: 1e7, height: 100},
    {...shape, id: 'east', x: 1e9, y: -1e9, width: 500, height: 1e7},
  ])
  const saved = structuredClone(canvas.getItems())
  canvas.zoomToFit()
  const fit = zoom()
  assert.ok(fit > 0 && fit < .02)
  for (const item of saved) {
    const box = screenBox(item.id)
    assert.ok(box.left >= 0 && box.left + box.width <= viewport.clientWidth)
    assert.ok(box.top >= 0 && box.top + box.height <= viewport.clientHeight)
    assert.ok(Math.abs(box.width - item.width * fit) < 1e-6)
  }
  assert.ok(screenBox('east').left - screenBox('west').left > 110)
  canvas.zoomBy(1.25)
  assert.equal(zoom(), fit * 1.25)
  canvas.zoomBy(.5)
  assert.equal(zoom(), fit)
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(changes(), 0)
})

test('fit brings a small cluster at a remote coordinate back to readable size', t => {
  const {canvas, viewport, screenBox, zoom} = board(t)
  const shape = {...canvas.getItems()[0], x: 999999990, y: -999999990}
  canvas.setItems([shape])
  canvas.zoomToFit()
  const box = screenBox(shape.id)
  assert.equal(zoom(), 1.5)
  assert.equal(box.left + box.width / 2, viewport.clientWidth / 2)
  assert.equal(box.top + box.height / 2, viewport.clientHeight / 2)
})

test('fit clears interrupted pointer and trackpad gestures without committing the preview', t => {
  const {canvas, camera, emit, viewport, shapeNode, changes} = board(t)
  const saved = structuredClone(canvas.getItems())
  const point = {button: 0, pointerId: 17, clientX: 30, clientY: 45}
  emit('pointerdown', point, shapeNode)
  emit('pointermove', {...point, clientX: 90})
  assert.equal(canvas.canReplaceItems(), false)
  canvas.zoomToFit()
  const fit = camera()
  assert.equal(canvas.canReplaceItems(), true)
  assert.equal(viewport.hasPointerCapture(point.pointerId), false)
  emit('pointerup', {...point, clientX: 180})
  emit('gesturestart')
  emit('gesturechange', {scale: 2})
  canvas.zoomToFit()
  emit('gesturechange', {scale: 4})
  assert.deepEqual(camera(), fit)
  emit('wheel', {deltaX: 20, deltaY: 30})
  assert.deepEqual(camera(), {...fit, x: fit.x - 20, y: fit.y - 30})
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(changes(), 0)
})

test('wheel zoom quantizes finger travel independently of fine event sampling', t => {
  const {camera, canvas, emit, changes} = board(t)
  const wheel = (deltaY, timeStamp, fields = {}) => emit('wheel', {
    ctrlKey: true, clientX: 175, clientY: 90, deltaX: 0, deltaY, timeStamp, ...fields,
  })
  const samples = [1, 4, 40].map(count => {
    canvas.zoomToActual()
    const before = camera()
    for (let i = 0; i < count; i++) wheel(-40 / count, i * 100 / count)
    const after = camera()
    assert.ok(Math.abs((175 - after.x) / after.zoom - (175 - before.x) / before.zoom) < 1e-8)
    assert.ok(Math.abs((90 - after.y) / after.zoom - (90 - before.y) / before.zoom) < 1e-8)
    return after.zoom
  })
  for (const zoom of samples) assert.ok(Math.abs(zoom - 1.04 ** 2) < 1e-8)
  canvas.zoomToActual()
  wheel(-19, 500)
  assert.equal(camera().zoom, 1)
  wheel(12, 505)
  wheel(8, 510)
  assert.equal(camera().zoom, 1 / 1.04)
  const beforePan = camera()
  wheel(30, 511, {ctrlKey: false, deltaX: 24})
  assert.deepEqual(camera(), {...beforePan, x: beforePan.x - 24, y: beforePan.y - 30})
  assert.equal(changes(), 0)
})

test('an anomalous wheel event stops immediately and leaves later input responsive', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']})
  const {canvas, camera, emit} = board(t)
  const wheel = deltaY => emit('wheel', {ctrlKey: true, deltaX: 0, deltaY, clientX: 160, clientY: 210})
  wheel(-10000)
  assert.equal(camera().zoom, 1.04 ** 2)
  const stopped = camera()
  t.mock.timers.tick(2000)
  assert.deepEqual(camera(), stopped)
  for (let i = 0; i < 10; i++) wheel(-20)
  assert.ok(Math.abs(camera().zoom - 1.04 ** 12) < 1e-8)
  canvas.zoomBy(100)
  wheel(-10000)
  wheel(20)
  assert.equal(camera().zoom, 16 / 1.04)
})

test('native WebKit pinch quantizes cumulative scale and suppresses duplicate wheel events', t => {
  const {canvas, camera, emit} = board(t)
  const point = {clientX: 142, clientY: 86}
  const wheel = (deltaY, timeStamp) =>
    emit('wheel', {...point, ctrlKey: true, deltaX: 0, deltaY, timeStamp})
  for (const samples of [1, 7, 50]) {
    canvas.zoomToActual()
    const before = camera()
    emit('gesturestart', {...point, timeStamp: 0})
    wheel(-200, 2)
    emit('wheel', {...point, deltaX: 5, deltaY: 12, timeStamp: 3})
    assert.deepEqual(camera(), before)
    for (let i = 1; i <= samples; i++) {
      emit('gesturechange', {...point, scale: 1.35 ** (i / samples), timeStamp: i * 100 / samples})
    }
    const after = camera()
    assert.ok(Math.abs(after.zoom - 1.04 ** 2) < 1e-8)
    assert.ok(Math.abs((point.clientX - before.x) / before.zoom - (point.clientX - after.x) / after.zoom) < 1e-8)
    emit('gesturechange', {...point, scale: 1.35, timeStamp: 101})
    emit('gestureend', {timeStamp: 102})
    wheel(-200, 105)
    assert.deepEqual(camera(), after)
    wheel(20, 109)
    assert.ok(camera().zoom < after.zoom, 'opposite input should take effect immediately')
  }
})

test('pasting a layer creates an independent, undoable copy with the same appearance', t => {
  const {canvas, viewport, changes} = board(t)
  const previousElement = globalThis.Element
  globalThis.Element = Surface
  t.after(() => { if (previousElement) globalThis.Element = previousElement; else delete globalThis.Element })
  document.querySelector = () => null
  document.getSelection = () => null
  const shape = {...canvas.getItems()[0], id: crypto.randomUUID(), color: '#674123'}
  canvas.setItems([shape])
  canvas.select(shape.id)
  const data = new Map()
  const clipboardData = {setData: (type, value) => data.set(type, value), getData: type => data.get(type) || ''}
  function clipboard(type) {
    const event = Object.assign(new Event(type, {cancelable: true}), {clipboardData})
    Object.defineProperty(event, 'target', {value: viewport})
    document.dispatchEvent(event)
    return event.defaultPrevented
  }
  assert.ok(clipboard('copy'))
  assert.equal(data.get('text/plain'), 'rectangle')
  assert.ok(clipboard('paste'))
  assert.equal(changes(), 1)
  const copy = canvas.getItems()[1]
  assert.notEqual(copy.id, shape.id)
  assert.deepEqual({...copy, id: shape.id, x: shape.x, y: shape.y}, shape)
  assert.ok(clipboard('paste'))
  const next = canvas.getItems()[2]
  assert.notEqual(next.id, copy.id)
  assert.ok(next.x > copy.x && next.y > copy.y)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [shape, copy])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [shape])
  document.getSelection = () => 'a selected phrase'
  canvas.select(shape.id)
  assert.equal(clipboard('copy'), false)
})

test('clipboard layers retain known fields and validate private image references', () => {
  const image = {id: crypto.randomUUID(), type: 'image', imageId: crypto.randomUUID()+'.png',
    x: 0, y: -20, width: 250, height: 193, name: 'Photo.png'}
  assert.deepEqual(parseLayer(JSON.stringify({...image, other: {nested: true}})), image)
  assert.equal(parseLayer(JSON.stringify({...image, imageId: 'https://example.com/image.png'})), null)
  assert.equal(parseLayer(JSON.stringify({...image, width: -3})), null)
  assert.equal(parseLayer('ordinary text'), null)
})
