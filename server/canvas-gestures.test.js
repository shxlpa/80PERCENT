import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCanvas } from '../everything-assets/canvas.js'

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
    const event = Object.assign(new Event(type, {cancelable: true}), properties)
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
  emit('gesturechange', {scale: 2, clientX: 160, clientY: 140})
  assert.equal(camera().zoom, 2)
  emit('gestureend')

  emit('wheel', {ctrlKey: true, deltaX: 0, deltaY: -10, clientX: 160, clientY: 140})
  assert.ok(camera().zoom > 2)
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
