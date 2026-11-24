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
  setPointerCapture() {}
  focus() {}
  closest(selector) { return selector === '.ec-node' && this.className === 'ec-node' ? this : null }
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
  let state
  const canvas = createCanvas({viewport, world, items: [shape], onState: next => { state = next }})
  const shapeNode = world.children.find(node => node.dataset.id === shape.id)
  function emit(type, properties = {}, target = viewport) {
    const event = Object.assign(new Event(type, {cancelable: true}), properties)
    // Browser pointer events with a layer as their target bubble to the viewport listener.
    Object.defineProperty(event, 'target', {value: target})
    viewport.dispatchEvent(event)
  }
  function camera() {
    const match = world.style.transform.match(/^translate\(([^,]+)px,\s*([^)]+)px\) scale\(([^)]+)\)$/)
    assert.ok(match, world.style.transform)
    const [x, y, zoom] = match.slice(1).map(Number)
    assert.ok([x, y, zoom, state.zoom].every(Number.isFinite), 'Nonfinite camera: ' + world.style.transform)
    assert.ok(zoom > 0)
    assert.equal(state.zoom, zoom)
    return {x, y, zoom}
  }
  return {canvas, camera, emit, shapeNode}
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
