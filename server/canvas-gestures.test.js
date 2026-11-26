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
  className = ''
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
    remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ') },
    contains: name => this.className.split(/\s+/).includes(name),
    toggle: (name, force) => {
      const include = force ?? !this.classList.contains(name)
      this.classList[include ? 'add' : 'remove'](name)
      return include
    },
  }
  clientWidth = 800
  clientHeight = 600

  get firstElementChild() { return this.children[0] }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] }
  getBoundingClientRect() { return {left: 0, top: 0} }
  hasAttribute() { return false }
  setAttribute() {}
  removeAttribute(name) { delete this[name] }
  captures = new Set()
  setPointerCapture(id) { this.captures.add(id) }
  hasPointerCapture(id) { return this.captures.has(id) }
  releasePointerCapture(id) { this.captures.delete(id) }
  focus() { document.activeElement = this }
  closest(selector) {
    for (const part of selector.split(',')) {
      if (part.startsWith('.') && this.classList.contains(part.slice(1))) return this
      if (part === '[data-handle]' && this.dataset.handle) return this
      if (part.toUpperCase() === this.tagName) return this
    }
    return this.parent?.closest(selector) ?? null
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  append(...children) { for (const child of children) this.insertBefore(child, null) }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove()
    this.append(...children)
  }
  insertBefore(child, next) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = this.children.indexOf(next)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.parent = this
  }
}

function board(t, options = {}) {
  const previousElement = globalThis.Element
  globalThis.Element = Surface
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: tag => Object.assign(new Surface(), {tagName: tag.toUpperCase()}),
    querySelector: () => null,
    getSelection: () => null,
    fonts: {check: () => true},
  })
  globalThis.window = new EventTarget()
  t.after(() => {
    delete globalThis.document
    delete globalThis.window
    if (previousElement) globalThis.Element = previousElement
    else delete globalThis.Element
  })
  const viewport = new Surface()
  const world = new Surface()
  const shape = {id: 'a', type: 'shape', shape: 'rectangle', color: '#ffffff', x: 10, y: 20, width: 50, height: 60}
  let state, changes = 0
  const canvas = createCanvas({viewport, world, items: [shape], onState: next => { state = next },
    onChange: () => { changes++ }, ...options})
  const shapeNode = world.children.find(node => node.dataset.id === shape.id)
  function dispatch(surface, type, properties, target) {
    const {timeStamp, ...fields} = properties
    const event = Object.assign(new Event(type, {cancelable: true}), fields)
    if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', {value: timeStamp})
    // Browser pointer events with a layer as their target bubble to the viewport listener.
    Object.defineProperty(event, 'target', {value: target})
    surface.dispatchEvent(event)
    return event
  }
  const emit = (type, properties = {}, target = viewport) => dispatch(viewport, type, properties, target)
  const key = (key, properties = {}, target = viewport) => dispatch(document, 'keydown', {key, ...properties}, target)
  function drag(from, to, {target = viewport, pointerId = 1, ...properties} = {}) {
    emit('pointerdown', {button: 0, pointerId, clientX: from[0], clientY: from[1], ...properties}, target)
    emit('pointermove', {pointerId, clientX: to[0], clientY: to[1], ...properties})
    emit('pointerup', {pointerId, clientX: to[0], clientY: to[1], ...properties})
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
  return {canvas, camera, emit, key, drag, shapeNode, viewport, world, screenBox,
    state: () => state, zoom: () => state.zoom, changes: () => changes}
}

function addSelectionLayers(canvas) {
  const shape = canvas.getItems()[0]
  const items = [shape, {...shape, id: 'b', x: 100, y: 120}, {...shape, id: 'c', x: 400, y: 300}]
  canvas.setItems(items)
  return structuredClone(items)
}

const selectedIds = state => [...state().selectedIds].sort()

test('photo export eligibility requires exactly one selected image and permits selected overlays', async t => {
  const {canvas, state, changes} = board(t, {loadImage: () => new Promise(() => {})})
  const shape = canvas.getItems()[0]
  const photo = {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo',
    x: 100, y: 20, width: 300, height: 200}
  const text = {id: 'text', type: 'text', text: 'Caption', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 120, y: 40, width: 160, height: 32}
  const saved = [shape, photo, text, {...photo, id: 'other-photo', imageId: 'other.png', x: 450}]
  canvas.setItems(saved)
  assert.equal(state().canExportPhoto, false)
  assert.equal(state().exporting, false)
  for (const id of ['a', 'text']) {
    canvas.select(id)
    assert.equal(state().canExportPhoto, false)
    await canvas.exportSelectedPhoto()
    assert.equal(state().exporting, false)
  }
  canvas.select('photo')
  assert.equal(state().canExportPhoto, true)
  canvas.select('text', {toggle: true})
  canvas.select('a', {toggle: true})
  assert.equal(state().selected, null)
  assert.equal(state().canExportPhoto, true)
  canvas.select('other-photo', {toggle: true})
  assert.equal(state().canExportPhoto, false)
  await canvas.exportSelectedPhoto()
  canvas.select('other-photo', {toggle: true})
  assert.equal(state().canExportPhoto, true)
  canvas.select(null)
  assert.equal(state().canExportPhoto, false)
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(changes(), 0)
  assert.equal(state().canUndo, false)
})

test('failed photo export resets its busy state without modifying selection or saved history', async t => {
  const requests = [], errors = []
  const {canvas, state, changes} = board(t, {
    loadImage(id) {
      const pending = Promise.withResolvers()
      requests.push({id, ...pending})
      return pending.promise
    },
    onError: error => errors.push(error),
  })
  const photo = {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo',
    x: 100, y: 20, width: 300, height: 200}
  canvas.setItems([photo])
  canvas.select(photo.id)
  assert.equal(requests.length, 1, 'board rendering starts its own image request')
  const exporting = canvas.exportSelectedPhoto()
  assert.equal(state().exporting, true)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  await canvas.exportSelectedPhoto()
  assert.equal(requests.length, 2, 'a second export cannot start while one is pending')
  requests[1].reject(new Error('Photo download failed.'))
  await exporting
  assert.deepEqual(errors, ['Photo download failed.'])
  assert.equal(state().exporting, false)
  assert.equal(state().canExportPhoto, true)
  assert.deepEqual(selectedIds(state), ['photo'])
  assert.deepEqual(canvas.getItems(), [photo])
  assert.equal(changes(), 0)
  assert.equal(state().canUndo, false)
  const retry = canvas.exportSelectedPhoto()
  assert.equal(state().exporting, true)
  await Promise.resolve()
  assert.equal(requests.length, 3, 'a failed export can be retried')
  requests[2].reject(new Error('Still offline.'))
  await retry
  assert.equal(state().exporting, false)
  assert.equal(changes(), 0)
})

function visibleSnapGuides(...roots) {
  const found = new Set()
  function visit(node, hidden = false) {
    hidden ||= node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden'
    if (!hidden && node.classList.contains('ec-snap-guide')) found.add(node)
    for (const child of node.children) visit(child, hidden)
  }
  roots.forEach(root => visit(root))
  return [...found]
}

function snappingBoard(t) {
  const fixture = board(t, {loadImage: () => new Promise(() => {})})
  const items = [
    {id: 'text', type: 'text', text: 'Caption', font: 'DM Sans', fontSize: 24,
      color: '#252724', x: 0, y: 0, width: 40, height: 20},
    {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo', x: 100, y: 20, width: 100, height: 100},
  ]
  fixture.canvas.setItems(items)
  const textNode = fixture.world.children.find(node => node.dataset.id === 'text')
  return {...fixture, textNode, saved: structuredClone(items)}
}

test('dragging text previews alignment guides and commits its snapped position once', t => {
  const {canvas, emit, textNode, viewport, world, screenBox, saved, state, changes} = snappingBoard(t)
  const start = {button: 0, pointerId: 51, clientX: 10, clientY: 10}
  const end = {...start, clientX: 142, clientY: 72}
  emit('pointerdown', start, textNode)
  emit('pointermove', end)
  assert.deepEqual([screenBox('text').left, screenBox('text').top], [130, 60])
  assert.ok(visibleSnapGuides(viewport, world).length >= 2)
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(changes(), 0)
  emit('pointerup', end)
  assert.deepEqual(canvas.getItems()[0], {...saved[0], x: 130, y: 60})
  assert.deepEqual(canvas.getItems()[1], saved[1])
  assert.equal(changes(), 1)
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(state().canUndo, false)
})

test('Alt bypasses live snapping and cancelled alignment leaves no guides or saved edits', t => {
  const {canvas, emit, textNode, viewport, world, screenBox, saved, changes} = snappingBoard(t)
  const start = {button: 0, pointerId: 52, clientX: 10, clientY: 10}
  const end = {...start, clientX: 142, clientY: 72}
  emit('pointerdown', start, textNode)
  emit('pointermove', end)
  assert.ok(visibleSnapGuides(viewport, world).length >= 2)
  emit('pointermove', {...end, altKey: true})
  assert.deepEqual([screenBox('text').left, screenBox('text').top], [132, 62])
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  emit('pointermove', end)
  assert.deepEqual([screenBox('text').left, screenBox('text').top], [130, 60])
  emit('pointercancel', {pointerId: 52})
  assert.deepEqual([screenBox('text').left, screenBox('text').top], [0, 0])
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  assert.equal(changes(), 0)
  emit('pointerdown', {...start, pointerId: 53}, textNode)
  emit('pointermove', {...end, pointerId: 53})
  emit('pointerup', {...end, pointerId: 53, altKey: true})
  assert.deepEqual(canvas.getItems()[0], {...saved[0], x: 132, y: 62})
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  assert.equal(changes(), 1)
})

test('group movement excludes every selected layer from snap targets', t => {
  const {canvas, drag, shapeNode, viewport, world} = board(t)
  const shape = canvas.getItems()[0]
  canvas.setItems([shape, {...shape, id: 'b', x: 100, y: 120}])
  canvas.select('a')
  canvas.select('b', {toggle: true})
  drag([20, 25], [24, 29], {target: shapeNode})
  assert.deepEqual(canvas.getItems().map(({x, y}) => [x, y]), [[14, 24], [104, 124]])
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
})

test('image resize previews matching height with its aspect ratio and supports Alt bypass', t => {
  const {canvas, emit, world, viewport, screenBox, changes, state} = board(t, {loadImage: () => new Promise(() => {})})
  const original = {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo', x: 10, y: 20, width: 200, height: 100}
  const target = {...original, id: 'target', x: 350, y: 25, width: 180, height: 150}
  canvas.setItems([original, target])
  canvas.select(original.id)
  const handle = world.children.find(node => node.classList.contains('ec-selection')).children
    .find(node => node.dataset.handle === 'se')
  const start = {button: 0, pointerId: 54, clientX: 210, clientY: 120}
  const end = {...start, clientX: 304, clientY: 167}
  emit('pointerdown', start, handle)
  emit('pointermove', end)
  assert.deepEqual(screenBox('photo'), {left: 10, top: 20, width: 300, height: 150})
  assert.ok(visibleSnapGuides(viewport, world).length > 0)
  assert.deepEqual(canvas.getItems(), [original, target])
  assert.equal(changes(), 0)
  emit('pointermove', {...end, altKey: true})
  assert.deepEqual(screenBox('photo'), {left: 10, top: 20, width: 294, height: 147})
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  emit('pointerup', end)
  assert.deepEqual(canvas.getItems(), [{...original, width: 300, height: 150}, target])
  assert.equal(changes(), 1)
  assert.equal(visibleSnapGuides(viewport, world).length, 0)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [original, target])
  assert.equal(state().canUndo, false)
})

test('italic text updates its rendered style, saves, and restores through undo and redo', t => {
  const {canvas, world, state, changes} = board(t)
  const text = {id: 'text', type: 'text', text: 'Emphasis', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 10, y: 20, width: 240, height: 32}
  canvas.setItems([text])
  canvas.select(text.id)
  const node = world.children.find(node => node.dataset.id === text.id)
  assert.equal(node.style.fontStyle, 'normal', 'older text layers default to regular type')
  canvas.updateSelected({italic: true})
  assert.equal(node.style.fontStyle, 'italic')
  assert.equal(state().selected.italic, true)
  assert.equal(changes(), 1)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [text])
  assert.equal(node.style.fontStyle, 'normal')
  canvas.redo()
  assert.equal(node.style.fontStyle, 'italic')
  canvas.updateSelected({italic: false})
  assert.equal(node.style.fontStyle, 'normal')
  assert.equal(canvas.getItems()[0].italic, false)
  canvas.undo()
  assert.equal(node.style.fontStyle, 'italic')
  const beforeInvalid = changes()
  canvas.updateSelected({italic: 'false'})
  assert.equal(canvas.getItems()[0].italic, true)
  assert.equal(changes(), beforeInvalid, 'nonboolean italic updates are ignored')
})

test('live text color changes paint and save immediately while one picker session has one undo', t => {
  const {canvas, world, state, changes} = board(t)
  const text = {id: 'text', type: 'text', text: 'Live color', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 10, y: 20, width: 240, height: 32}
  canvas.setItems([text])
  canvas.select(text.id)
  const historyGroup = {}
  const node = world.children.find(node => node.dataset.id === text.id)
  for (let i = 1; i <= 100; i++) {
    const color = '#' + i.toString(16).padStart(6, '0')
    canvas.updateSelected({color}, {historyGroup})
    assert.equal(node.style.color, color)
    assert.equal(canvas.getItems()[0].color, color)
    assert.equal(changes(), i, 'each live input must be published for autosave')
  }
  canvas.updateSelected({color: '#000064'}, {historyGroup})
  assert.equal(changes(), 100, 'final change event with the same color must be a no-op')
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [text])
  assert.equal(node.style.color, text.color)
  assert.equal(state().canUndo, false, '100 color inputs must occupy one undo entry')
  canvas.redo()
  assert.equal(node.style.color, '#000064')
  assert.equal(canvas.getItems()[0].color, '#000064')
})

test('color undo groups stay separate across picker sessions, edits, and history resets', t => {
  const {canvas, state} = board(t)
  const original = {...canvas.getItems()[0]}
  canvas.select(original.id)
  const first = {}, second = {}
  canvas.updateSelected({color: '#111111'}, {historyGroup: first})
  canvas.updateSelected({color: '#222222'}, {historyGroup: first})
  canvas.updateSelected({color: '#333333'}, {historyGroup: second})
  canvas.updateSelected({color: '#444444'}, {historyGroup: second})
  canvas.undo()
  assert.equal(canvas.getItems()[0].color, '#222222')
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [original])
  assert.equal(state().canUndo, false)

  canvas.setItems([original])
  canvas.updateSelected({color: '#111111'}, {historyGroup: first})
  canvas.updateSelected({width: 70})
  canvas.updateSelected({color: '#222222'}, {historyGroup: first})
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [{...original, color: '#111111', width: 70}])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [{...original, color: '#111111'}])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [original])

  canvas.updateSelected({color: '#111111'}, {historyGroup: first})
  canvas.undo()
  canvas.updateSelected({color: '#222222'}, {historyGroup: first})
  assert.equal(state().canRedo, false)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [original])
  canvas.redo()
  canvas.updateSelected({color: '#333333'}, {historyGroup: first})
  canvas.undo()
  assert.equal(canvas.getItems()[0].color, '#222222', 'redo must end a previous color group')

  canvas.updateSelected({color: '#444444'}, {historyGroup: first})
  canvas.setItems([original])
  canvas.updateSelected({color: '#555555'}, {historyGroup: first})
  canvas.undo()
  assert.deepEqual(canvas.getItems(), [original], 'scene replacement must start fresh history')
  assert.equal(state().canUndo, false)
})

test('marquee selects intersecting layers in either direction without saving the scene', t => {
  const {canvas, drag, state, changes} = board(t)
  const saved = addSelectionLayers(canvas)
  for (const [from, to] of [[[0, 0], [170, 200]], [[170, 200], [40, 50]]]) {
    drag(from, to)
    assert.deepEqual(selectedIds(state), ['a', 'b'])
    assert.deepEqual(state().selectedItems.map(item => item.id).sort(), ['a', 'b'])
    assert.equal(state().selected, null)
    assert.deepEqual(canvas.getItems(), saved)
    assert.equal(changes(), 0)
  }
  drag([200, 210], [200, 210])
  assert.deepEqual(selectedIds(state), [])
  assert.equal(state().selected, null)
  assert.equal(changes(), 0)
})

test('marquee follows world geometry after zoom and pan', t => {
  const {canvas, drag, state, camera, changes} = board(t)
  addSelectionLayers(canvas)
  canvas.zoomBy(2)
  canvas.setTool('hand')
  drag([20, 20], [470, 370])
  canvas.setTool('select')
  const {x, y, zoom} = camera()
  const screen = (wx, wy) => [x + wx * zoom, y + wy * zoom]
  drag(screen(170, 200), screen(0, 0))
  assert.deepEqual(selectedIds(state), ['a', 'b'])
  assert.equal(changes(), 0)
})

test('marquee still finds layers after recentering extreme world coordinates', t => {
  const {canvas, drag, state, screenBox, changes} = board(t)
  const shape = canvas.getItems()[0]
  canvas.setItems([
    {...shape, id: 'west', x: -1e9, y: 0},
    {...shape, id: 'east', x: 1e9, y: 0},
  ])
  canvas.zoomToFit()
  const west = screenBox('west'), east = screenBox('east')
  drag([west.left - 10, west.top - 10], [east.left + east.width + 10, east.top + east.height + 10])
  assert.deepEqual(selectedIds(state), ['east', 'west'])
  assert.equal(changes(), 0)
})

test('Shift marquee adds layers and Shift click toggles membership', t => {
  const {canvas, drag, state, world, changes} = board(t)
  addSelectionLayers(canvas)
  canvas.select('c')
  drag([0, 0], [170, 200], {shiftKey: true})
  assert.deepEqual(selectedIds(state), ['a', 'b', 'c'])
  const a = world.children.find(node => node.dataset.id === 'a')
  drag([20, 25], [20, 25], {target: a, shiftKey: true})
  assert.deepEqual(selectedIds(state), ['b', 'c'])
  drag([20, 25], [20, 25], {target: a, shiftKey: true})
  assert.deepEqual(selectedIds(state), ['a', 'b', 'c'])
  canvas.select('c', {toggle: true})
  canvas.select('b', {toggle: true})
  assert.deepEqual(selectedIds(state), ['a'])
  assert.equal(state().selected.id, 'a')
  const c = world.children.find(node => node.dataset.id === 'c')
  drag([410, 310], [410, 310], {target: c})
  assert.deepEqual(selectedIds(state), ['c'])
  assert.equal(state().selected.id, 'c')
  assert.equal(changes(), 0)
})

test('dragging a selected layer moves the group in one undoable change', t => {
  const {canvas, emit, shapeNode, state, changes, screenBox} = board(t)
  const saved = addSelectionLayers(canvas)
  canvas.select('a')
  canvas.select('b', {toggle: true})
  canvas.zoomBy(2)
  const beforeA = screenBox('a'), beforeB = screenBox('b')
  const start = {button: 0, pointerId: 12, clientX: beforeA.left + 10, clientY: beforeA.top + 10}
  const end = {...start, clientX: start.clientX + 60, clientY: start.clientY + 80}
  emit('pointerdown', start, shapeNode)
  emit('pointermove', end)
  assert.deepEqual(selectedIds(state), ['a', 'b'])
  assert.equal(screenBox('a').left, beforeA.left + 60)
  assert.equal(screenBox('b').left, beforeB.left + 60)
  assert.deepEqual(canvas.getItems(), saved, 'movement is a preview until release')
  assert.equal(changes(), 0)
  emit('pointerup', end)
  const moved = canvas.getItems()
  assert.deepEqual(moved.map(({x, y}) => [x, y]), [[40, 60], [130, 160], [400, 300]])
  assert.equal(changes(), 1)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(state().canUndo, false)
  canvas.redo()
  assert.deepEqual(canvas.getItems(), moved)
})

test('group movement clamps a shared offset at world limits without saving outward nudges', t => {
  const {canvas, drag, key, shapeNode, screenBox, state, changes} = board(t)
  const shape = canvas.getItems()[0]
  for (const sign of [-1, 1]) {
    const saved = [
      {...shape, x: sign * (1e9 - 5), y: sign * (1e9 - 10)},
      {...shape, id: 'b', x: sign * (1e9 - 20), y: sign * (1e9 - 30)},
    ]
    canvas.setItems(saved)
    canvas.select('a')
    canvas.select('b', {toggle: true})
    canvas.zoomToFit()
    const box = screenBox('a')
    const start = [box.left + 10, box.top + 10]
    const beforeChanges = changes()
    drag(start, [start[0] + sign * 100, start[1] + sign * 100], {target: shapeNode})
    const atLimit = canvas.getItems()
    assert.deepEqual(atLimit.map(({x, y}) => [x, y]), [
      [sign * 1e9, sign * 1e9],
      [sign * (1e9 - 15), sign * (1e9 - 20)],
    ])
    assert.equal(changes(), beforeChanges + 1)
    key(sign > 0 ? 'ArrowRight' : 'ArrowLeft', {shiftKey: true})
    key(sign > 0 ? 'ArrowDown' : 'ArrowUp', {shiftKey: true})
    assert.deepEqual(canvas.getItems(), atLimit)
    assert.equal(changes(), beforeChanges + 1, 'outward nudges must not autosave')
    canvas.undo()
    assert.deepEqual(canvas.getItems(), saved, 'one undo restores the whole drag')
    assert.equal(state().canUndo, false, 'outward nudges must not create undo entries')
  }
})

test('cancelled marquee restores its starting selection and releases the gesture', t => {
  const {canvas, emit, state, changes} = board(t)
  const saved = addSelectionLayers(canvas)
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'pinch']) {
    canvas.select('a')
    emit('pointerdown', {button: 0, pointerId: 20, clientX: 80, clientY: 100})
    emit('pointermove', {pointerId: 20, clientX: 180, clientY: 200})
    assert.deepEqual(selectedIds(state), ['b'])
    if (reason === 'blur') window.dispatchEvent(new Event('blur'))
    else if (reason === 'pinch') {
      emit('pointerdown', {button: 0, pointerId: 21, clientX: 220, clientY: 250})
      assert.deepEqual(selectedIds(state), ['a'])
      emit('pointerup', {pointerId: 21, clientX: 220, clientY: 250})
      emit('pointerup', {pointerId: 20, clientX: 180, clientY: 200})
    } else emit(reason, {pointerId: 20})
    assert.deepEqual(selectedIds(state), ['a'], reason)
    assert.equal(canvas.canReplaceItems(), true, reason)
    assert.deepEqual(canvas.getItems(), saved)
    assert.equal(changes(), 0)
  }
})

test('cancelled group movement restores every previewed layer', t => {
  const {canvas, emit, shapeNode, screenBox, state, changes} = board(t)
  const saved = addSelectionLayers(canvas)
  canvas.select('a')
  canvas.select('b', {toggle: true})
  const before = ['a', 'b'].map(screenBox)
  emit('pointerdown', {button: 0, pointerId: 22, clientX: 20, clientY: 25}, shapeNode)
  emit('pointermove', {pointerId: 22, clientX: 70, clientY: 90})
  emit('pointercancel', {pointerId: 22})
  assert.deepEqual(['a', 'b'].map(screenBox), before)
  assert.deepEqual(selectedIds(state), ['a', 'b'])
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(changes(), 0)
})

test('select all, group nudge, delete, and undo operate on the entire selection', t => {
  const {canvas, key, state, changes} = board(t)
  const saved = addSelectionLayers(canvas)
  canvas.select('a')
  canvas.select('b', {toggle: true})
  assert.equal(key('ArrowRight', {shiftKey: true}).defaultPrevented, true)
  assert.deepEqual(canvas.getItems().map(({x, y}) => [x, y]), [[20, 20], [110, 120], [400, 300]])
  assert.equal(changes(), 1)
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(state().canUndo, false)
  key('Delete')
  assert.deepEqual(canvas.getItems().map(item => item.id), ['c'])
  assert.deepEqual(selectedIds(state), [])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
  for (const modifier of ['ctrlKey', 'metaKey']) {
    canvas.select(null)
    assert.equal(key('a', {[modifier]: true}).defaultPrevented, true)
    assert.deepEqual(selectedIds(state), ['a', 'b', 'c'])
  }
})

test('group arrangement preserves relative layer order and is atomic', t => {
  const {canvas, state} = board(t)
  const saved = addSelectionLayers(canvas)
  canvas.select('a')
  canvas.select('c', {toggle: true})
  canvas.arrange('front')
  assert.deepEqual(canvas.getItems().map(item => item.id), ['b', 'a', 'c'])
  assert.deepEqual(selectedIds(state), ['a', 'c'])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
  assert.equal(state().canUndo, false)
  canvas.arrange('back')
  assert.deepEqual(canvas.getItems().map(item => item.id), ['a', 'c', 'b'])
  canvas.undo()
  assert.deepEqual(canvas.getItems(), saved)
})

test('replaced scenes prune stale selection without losing selected surviving layers', t => {
  const {canvas, state} = board(t)
  const saved = addSelectionLayers(canvas)
  canvas.select('a')
  canvas.select('b', {toggle: true})
  canvas.setItems(saved.filter(item => item.id !== 'a'))
  assert.deepEqual(selectedIds(state), ['b'])
  assert.equal(state().selected.id, 'b')
  canvas.setItems([])
  assert.deepEqual(selectedIds(state), [])
  assert.equal(state().selected, null)
})

test('selection retains single resize, explicit pan, and shape drawing gestures', t => {
  const {canvas, drag, emit, key, state, world, camera} = board(t)
  canvas.select('a')
  const selection = world.children.find(node => node.classList.contains('ec-selection'))
  const handle = selection.children.find(node => node.dataset.handle === 'se')
  drag([60, 80], [80, 100], {target: handle})
  assert.deepEqual(canvas.getItems().map(({x, y, width, height}) => [x, y, width, height]), [[10, 20, 70, 80]])
  const beforePan = camera()
  drag([200, 200], [220, 230], {button: 1})
  assert.deepEqual(camera(), {...beforePan, x: beforePan.x + 20, y: beforePan.y + 30})
  assert.deepEqual(selectedIds(state), ['a'])
  key(' ', {code: 'Space'})
  const beforeSpace = camera()
  drag([200, 200], [240, 250])
  assert.deepEqual(camera(), {...beforeSpace, x: beforeSpace.x + 40, y: beforeSpace.y + 50})
  document.dispatchEvent(Object.assign(new Event('keyup'), {code: 'Space'}))
  canvas.setTool('rectangle')
  drag([300, 300], [360, 340], {shiftKey: true})
  const created = canvas.getItems()[1]
  assert.equal(created.type, 'shape')
  assert.equal(created.width, 60)
  assert.equal(created.height, 60)
  assert.equal(state().selected.id, created.id)
  // An ordinary select click after drawing must no longer pan or create a shape.
  emit('pointerdown', {button: 0, pointerId: 33, clientX: 0, clientY: 0})
  emit('pointerup', {pointerId: 33, clientX: 0, clientY: 0})
  assert.deepEqual(selectedIds(state), [])
  assert.equal(canvas.getItems().length, 2)
})

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

test('clipboard text preserves optional italic styling and rejects invalid values', () => {
  const text = {id: crypto.randomUUID(), type: 'text', text: 'Emphasis', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 10, y: 20, width: 240, height: 32}
  for (const item of [text, {...text, italic: true}, {...text, italic: false}]) {
    assert.deepEqual(parseLayer(JSON.stringify(item)), item)
  }
  for (const italic of ['true', 'false', 1, 0, null, {}]) {
    assert.equal(parseLayer(JSON.stringify({...text, italic})), null)
  }
})

test('private images share one fetch, ignore replaced loads and release their object URLs', async t => {
  const requests = []
  const errors = []
  const {canvas, world} = board(t, {
    loadImage(id) {
      const request = Promise.withResolvers()
      requests.push({id, ...request})
      return request.promise
    },
    onError: error => errors.push(error),
  })
  const revoke = t.mock.method(URL, 'revokeObjectURL')
  const image = {id: 'layer', type: 'image', imageId: 'first.png', name: 'one', x: 0, y: 0, width: 10, height: 10}
  const copy = {...image, id: 'copy'}
  const blob = new Blob(['image data'], {type: 'image/png'})
  const element = id => world.children.find(node => node.dataset.id === id).firstElementChild
  canvas.setItems([image, copy])
  assert.deepEqual(requests.map(r => r.id), ['first.png'])
  requests[0].resolve(blob)
  await requests[0].promise
  const firstUrl = element('layer').src
  assert.match(firstUrl, /^blob:/)
  assert.equal(element('copy').src, firstUrl)
  const changed = {...image, imageId: 'second.png'}
  canvas.setItems([changed, copy])
  assert.equal(element('layer').src, undefined)
  assert.equal(revoke.mock.callCount(), 0)
  canvas.setItems([{...changed, imageId: 'third.png'}])
  assert.equal(revoke.mock.calls[0].arguments[0], firstUrl)
  requests[1].resolve(blob)
  await requests[1].promise
  assert.equal(element('layer').src, undefined)
  requests[2].reject(new Error('offline'))
  await assert.rejects(requests[2].promise)
  assert.deepEqual(errors, ['offline'])
  window.dispatchEvent(new Event('online'))
  assert.deepEqual(requests.map(r => r.id), ['first.png', 'second.png', 'third.png', 'third.png'])
  requests[3].resolve(blob)
  await requests[3].promise
  const lastUrl = element('layer').src
  assert.match(lastUrl, /^blob:/)
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(revoke.mock.calls[1].arguments[0], lastUrl)
  assert.equal(element('layer').src, undefined)
})
