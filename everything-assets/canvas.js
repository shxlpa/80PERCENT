import { FONT_FAMILIES } from './fonts.js'
import { prepareImage } from './images.js'

const MIN_ZOOM = .02
const MAX_ZOOM = 16
const MAX_TEXT = 200_000
const MAX_ITEMS = 10_000
const SHAPES = ['rectangle', 'ellipse', 'triangle']
const COLORS = {shape: '#b9cbb6', text: '#252724'}
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const editable = target => target instanceof Element &&
  !!target.closest('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]')

function box(element, item) {
  element.style.left = item.x + 'px'
  element.style.top = item.y + 'px'
  element.style.width = item.width + 'px'
  element.style.height = item.height + 'px'
}

function newText(x, y, text = '') {
  return {id: crypto.randomUUID(), type: 'text', x, y, width: 240, height: 32,
    font: 'DM Sans', fontSize: 24, color: COLORS.text, text}
}

function resizeBox(original, handle, dx, dy, shift) {
  const left = handle.includes('w')
  const top = handle.includes('n')
  let width = Math.max(1, original.width + (left ? -dx : dx))
  let height = Math.max(1, original.height + (top ? -dy : dy))
  const preserveRatio = original.type === 'image' ? !shift : shift
  if (preserveRatio) {
    const ratio = original.width / original.height
    if (Math.abs(dx / original.width) >= Math.abs(dy / original.height)) height = width / ratio
    else width = height * ratio
  }
  return {width, height, x: left ? original.x + original.width - width : original.x,
    y: top ? original.y + original.height - height : original.y}
}

// Revisions, credentials, and uploads are handled by the caller. Scene snapshots are
// immutable, so pointer previews and undo history can share unmodified layers.
export function createCanvas({
  viewport, world, items: initialItems = [], onChange = () => {}, onState = () => {},
  uploadImage, imageUrl, onError = () => {},
}) {
  let items = initialItems.map(item => ({...item}))
  let selectedId = null
  let tool = 'select'
  let editing = null
  let gesture = null
  let spaceDown = false
  let trackpadPinch = null
  let uploadCount = 0
  let view = {x: 0, y: 0, zoom: 1}
  let rememberedPoint = null
  const past = [], future = []
  const nodes = new Map()
  const pointers = new Map()
  const selection = document.createElement('div')
  selection.className = 'ec-selection'
  selection.setAttribute('aria-hidden', 'true')
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('i')
    handle.className = 'ec-handle'
    handle.dataset.handle = corner
    selection.append(handle)
  }
  viewport.classList.add('ec-viewport')
  if (!viewport.hasAttribute('tabindex')) viewport.tabIndex = 0
  world.classList.add('ec-world')
  world.append(selection)
  const selected = () => items.find(item => item.id === selectedId) ?? null

  function notify() {
    onState({tool, selected: selected(), items, zoom: view.zoom, canUndo: !!past.length,
      canRedo: !!future.length, busy: uploadCount > 0})
  }

  function drawNode(item) {
    let node = nodes.get(item.id)
    if (!node || node.dataset.type !== item.type) {
      node?.remove()
      node = document.createElement('div')
      node.className = 'ec-node'
      node.dataset.id = item.id
      node.dataset.type = item.type
      const content = document.createElement(item.type === 'image' ? 'img' : 'div')
      content.className = 'ec-content'
      node.append(content)
      nodes.set(item.id, node)
    }
    box(node, item)
    const content = node.firstElementChild
    if (item.type === 'image') {
      if (content.dataset.imageId !== item.imageId) {
        content.dataset.imageId = item.imageId
        content.src = imageUrl(item.imageId)
        content.draggable = false
        content.decoding = 'async'
      }
      content.alt = item.name || 'Image'
    } else if (item.type === 'shape') {
      content.style.backgroundColor = item.color
      content.style.borderRadius = item.shape === 'ellipse' ? '50%' : ''
      content.style.clipPath = item.shape === 'triangle' ? 'polygon(50% 0,100% 100%,0 100%)' : ''
      node.setAttribute('aria-label', item.shape)
      node.setAttribute('role', 'img')
    } else {
      node.style.fontFamily = '"' + item.font + '", sans-serif'
      node.style.fontSize = item.fontSize + 'px'
      node.style.color = item.color
      content.classList.add('ec-text')
      if (content.textContent !== item.text) content.textContent = item.text
    }
    return node
  }

  function drawSelection() {
    const item = selected()
    selection.hidden = !item || tool !== 'select'
    if (item) box(selection, item)
    selection.style.visibility = editing ? 'hidden' : ''
  }

  function render() {
    const ids = new Set(items.map(item => item.id))
    for (const [id, node] of nodes) {
      if (!ids.has(id)) {
        node.remove()
        nodes.delete(id)
      }
    }
    let next = world.firstElementChild
    for (const item of items) {
      const node = drawNode(item)
      if (node !== next) world.insertBefore(node, next)
      next = node.nextElementSibling
    }
    viewport.dataset.ecTool = spaceDown ? 'hand' : tool
    drawSelection()
  }

  function camera() {
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')'
    world.style.setProperty('--ec-line', 1 / view.zoom + 'px')
    world.style.setProperty('--ec-handle', 8 / view.zoom + 'px')
    let gridSize = 22 * view.zoom
    while (gridSize < 12) gridSize *= 2
    while (gridSize > 32) gridSize /= 2
    viewport.style.setProperty('--grid-size', gridSize + 'px')
    viewport.style.setProperty('--grid-x', view.x % gridSize + 'px')
    viewport.style.setProperty('--grid-y', view.y % gridSize + 'px')
  }

  function remember(before) {
    past.push(before)
    if (past.length > 80) past.shift()
    future.length = 0
  }

  function commit(before) {
    if (items !== before) {
      remember(before)
      onChange(items)
    }
    render()
    notify()
  }

  function patch(id, props) {
    items = items.map(item => item.id === id ? {...item, ...props} : item)
  }

  // Font files load on demand. Their final wrapping can differ from the first paint.
  // Only expand the exact text revision that requested measurement.
  function growForLoadedFont(id) {
    const original = items.find(item => item.id === id)
    if (!original || original.type !== 'text') return
    const descriptor = original.fontSize + 'px "' + original.font + '"'
    if (document.fonts.check(descriptor)) return
    document.fonts.load(descriptor).then(() => {
      if (items.find(item => item.id === id) !== original || gesture || editing) return
      const content = nodes.get(id)?.firstElementChild
      if (!content || content.scrollHeight <= original.height) return
      patch(id, {height: content.scrollHeight + 1})
      render()
      notify()
      onChange(items)
    }).catch(() => {})
  }

  function setItems(next) {
    if (editing || gesture) return
    items = next.map(item => ({...item}))
    if (!selected()) selectedId = null
    past.length = future.length = 0
    render()
    notify()
  }

  function select(id) {
    finishEditing()
    selectedId = items.some(item => item.id === id) ? id : null
    if (selectedId) tool = 'select'
    render()
    notify()
  }

  function setTool(next) {
    if (!['select', 'hand', 'text', ...SHAPES].includes(next)) return
    finishEditing()
    tool = next
    if (next !== 'select') selectedId = null
    render()
    notify()
  }

  function local(event) {
    const rect = viewport.getBoundingClientRect()
    return {x: event.clientX - rect.left, y: event.clientY - rect.top}
  }
  const at = point => ({x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom})
  const center = () => ({x: viewport.clientWidth / 2, y: viewport.clientHeight / 2})

  function zoomAt(zoom, point, anchor = at(point)) {
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
    view = {zoom, x: point.x - anchor.x * zoom, y: point.y - anchor.y * zoom}
    camera()
    notify()
  }

  function zoomToFit() {
    if (!items.length) {
      view = {x: 0, y: 0, zoom: 1}
      camera()
      notify()
      return
    }
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (const item of items) {
      left = Math.min(left, item.x)
      right = Math.max(right, item.x + item.width)
      top = Math.min(top, item.y)
      bottom = Math.max(bottom, item.y + item.height)
    }
    const zoom = Math.min(1.5, viewport.clientWidth * .72 / Math.max(1, right - left),
      viewport.clientHeight * .68 / Math.max(1, bottom - top))
    zoomAt(zoom, center(), {x: (left + right) / 2, y: (top + bottom) / 2})
  }

  function finishEditing() {
    if (!editing) return
    const {input, before, id, savedDraft} = editing
    editing = null
    input.remove()
    const item = items.find(entry => entry.id === id)
    if (item && !item.text.length) {
      items = items.filter(entry => entry.id !== id)
      selectedId = null
      if (savedDraft || before.some(entry => entry.id === id)) {
        remember(before)
        onChange(items)
      }
    } else if (savedDraft) {
      remember(before)
      growForLoadedFont(id)
    }
    render()
    notify()
  }

  function editText(before) {
    const item = selected()
    if (item?.type !== 'text' || editing) return
    const node = nodes.get(item.id)
    const input = document.createElement('textarea')
    input.className = 'ec-edit'
    input.value = item.text
    input.maxLength = MAX_TEXT
    input.setAttribute('aria-label', 'Edit text layer')
    input.spellcheck = true
    editing = {id: item.id, input, before, savedDraft: false, minHeight: item.height}
    node.append(input)
    drawSelection()
    input.focus({preventScroll: true})
    input.setSelectionRange(input.value.length, input.value.length)
    input.addEventListener('input', () => {
      if (!editing) return
      input.style.height = '1px'
      const height = Math.max(editing.minHeight, input.scrollHeight + 1)
      input.style.height = ''
      patch(item.id, {text: input.value, height})
      editing.savedDraft = true
      drawNode(selected())
      onChange(items)
      notify()
    })
    input.addEventListener('blur', finishEditing)
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
        event.preventDefault()
        finishEditing()
        viewport.focus({preventScroll: true})
      }
    })
  }

  function startTextEdit() { editText(items) }

  function updateSelected(props) {
    finishEditing()
    const item = selected()
    if (!item) return
    const value = {}
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) {
      if (!(key in props) || !Number.isFinite(Number(props[key]))) continue
      if (key === 'fontSize' && item.type !== 'text') continue
      const pos = key === 'x' || key === 'y'
      value[key] = clamp(Number(props[key]), pos ? -1e9 : 1, pos ? 1e9 : key === 'fontSize' ? 2048 : 1e7)
    }
    if (item.type !== 'image' && /^#[a-f0-9]{6}$/i.test(props.color)) value.color = props.color
    if (item.type === 'text' && FONT_FAMILIES.includes(props.font)) value.font = props.font
    if (Object.keys(value).every(key => value[key] === item[key])) return
    const before = items
    patch(item.id, value)
    if (item.type === 'text' && !('height' in value)) {
      const content = drawNode(selected()).firstElementChild
      if (content.scrollHeight > selected().height) patch(item.id, {height: content.scrollHeight + 1})
    }
    commit(before)
    if (!('height' in value)) growForLoadedFont(item.id)
  }

  function remove() {
    finishEditing()
    if (!selected()) return
    const before = items
    items = items.filter(item => item.id !== selectedId)
    selectedId = null
    commit(before)
  }

  function arrange(direction) {
    finishEditing()
    const from = items.findIndex(item => item.id === selectedId)
    if (from < 0) return
    const to = {front: items.length - 1, back: 0, forward: Math.min(items.length - 1, from + 1),
      backward: Math.max(0, from - 1)}[direction]
    if (to == null || to === from) return
    const before = items
    items = [...items]
    items.splice(to, 0, items.splice(from, 1)[0])
    commit(before)
  }

  function restore(source, destination) {
    finishEditing()
    if (!source.length || gesture) return
    destination.push(items)
    items = source.pop()
    if (!selected()) selectedId = null
    render()
    notify()
    onChange(items)
  }

  function hasRoom() {
    if (items.length < MAX_ITEMS) return true
    onError('The canvas has reached its 10,000-layer limit.')
    return false
  }

  function insert(item) {
    if (!hasRoom()) return
    finishEditing()
    const before = items
    items = [...items, item]
    selectedId = item.id
    tool = 'select'
    if (item.type === 'text' && !item.text) {
      render()
      editText(before)
      notify()
      return
    }
    if (item.type === 'text') {
      render()
      const height = nodes.get(item.id).firstElementChild.scrollHeight
      if (height > item.height) patch(item.id, {height: height + 1})
    }
    commit(before)
    growForLoadedFont(item.id)
  }

  async function addFiles(files, point = at(center())) {
    const batch = Array.from(files)
    if (!batch.length) return
    finishEditing()
    uploadCount++
    notify()
    try {
      for (const [index, file] of batch.entries()) {
        if (!hasRoom()) break
        try {
          const {file: upload, width, height} = await prepareImage(file)
          const imageId = await uploadImage(upload)
          const ratio = Math.min(1, 480 / Math.max(width, height))
          const w = Math.max(1, width * ratio), h = Math.max(1, height * ratio)
          insert({id: crypto.randomUUID(), type: 'image', imageId,
            name: (file.name || 'Pasted image').slice(0, 240),
            x: point.x - w / 2 + 24 * index, y: point.y - h / 2 + 24 * index, width: w, height: h})
        } catch (error) {
          onError(error.message || 'The image could not be added.')
        }
      }
    } finally {
      uploadCount--
      notify()
    }
  }

  function clearGesture() {
    if (!gesture) return
    if (gesture.preview && gesture.kind === 'draw') {
      nodes.get(gesture.preview.id)?.remove()
      nodes.delete(gesture.preview.id)
    }
    gesture = null
    delete viewport.dataset.ecPanning
    render()
  }

  function pinchGeometry() {
    const [a, b] = pointers.values()
    return {middle: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2},
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))}
  }

  function beginPan(point) {
    gesture = {kind: 'pan', start: point, view}
    viewport.dataset.ecPanning = 'true'
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.target.closest('.ec-edit') || event.button > 1) return
    // Native controls can also live inside the viewport (e.g. an empty-state button).
    if (event.target.closest('button,a,input,select,textarea,dialog')) return
    finishEditing()
    const point = local(event)
    pointers.set(event.pointerId, point)
    viewport.setPointerCapture(event.pointerId)
    viewport.focus({preventScroll: true})
    if (pointers.size >= 2) {
      clearGesture()
      const {middle, distance} = pinchGeometry()
      gesture = {kind: 'pinch', anchor: at(middle), zoom: view.zoom, distance}
      return
    }
    if (spaceDown || tool === 'hand' || event.button === 1) {
      event.preventDefault()
      beginPan(point)
      return
    }
    const handle = event.target.closest('[data-handle]')?.dataset.handle
    if (handle && selected()) {
      gesture = {kind: 'resize', start: point, original: selected(), handle}
      return
    }
    if (tool !== 'select') {
      if (!hasRoom()) return
      gesture = {kind: 'draw', start: point, origin: at(point), tool, id: crypto.randomUUID()}
      return
    }
    const id = event.target.closest('.ec-node')?.dataset.id
    selectedId = id || null
    drawSelection()
    notify()
    if (selected()) gesture = {kind: 'move', start: point, original: selected()}
  })

  function drawDraft(g, point, shift) {
    const end = at(point)
    const dx = end.x - g.origin.x, dy = end.y - g.origin.y
    const isText = g.tool === 'text'
    const dragged = Math.hypot(point.x - g.start.x, point.y - g.start.y) > 3
    let w = dragged ? Math.max(1, Math.abs(dx)) : (isText ? 240 : 120)
    let h = dragged ? Math.max(1, Math.abs(dy)) : (isText ? 32 : 120)
    if (shift && !isText) w = h = Math.max(w, h)
    if (isText) { w = Math.max(w, 20); h = Math.max(h, 32) }
    const x = g.origin.x - (dragged && dx < 0 ? w : 0)
    const y = g.origin.y - (dragged && dy < 0 ? h : 0)
    const item = isText ? newText(x, y) : {type: 'shape', shape: g.tool, color: COLORS.shape}
    return {...item, id: g.id, x, y, width: w, height: h}
  }

  function preview(point, shift) {
    const g = gesture
    const dx = point.x - g.start.x, dy = point.y - g.start.y
    if (g.kind === 'pan') {
      view = {...g.view, x: g.view.x + dx, y: g.view.y + dy}
      camera()
    } else if (g.kind === 'draw') {
      g.preview = drawDraft(g, point, shift)
      const node = drawNode(g.preview)
      if (!node.isConnected) world.insertBefore(node, selection)
      box(selection, g.preview)
      selection.hidden = false
    } else if (g.kind === 'move' || g.kind === 'resize') {
      if (!g.preview && Math.hypot(dx, dy) < 2) return
      const source = g.original
      const dimensions = g.kind === 'move'
        ? {x: source.x + dx / view.zoom, y: source.y + dy / view.zoom}
        : resizeBox(source, g.handle, dx / view.zoom, dy / view.zoom, shift)
      g.preview = {...source, ...dimensions}
      drawNode(g.preview)
      box(selection, g.preview)
    }
  }

  viewport.addEventListener('pointermove', event => {
    const point = local(event)
    rememberedPoint = point
    if (!pointers.has(event.pointerId) || !gesture) return
    pointers.set(event.pointerId, point)
    if (gesture.kind === 'pinch') {
      const {middle, distance} = pinchGeometry()
      zoomAt(gesture.zoom * distance / gesture.distance, middle, gesture.anchor)
      return
    }
    preview(point, event.shiftKey)
  })
  viewport.addEventListener('pointerleave', () => { rememberedPoint = null })

  function endPointer(event, cancelled) {
    if (!pointers.delete(event.pointerId) || !gesture) return
    const g = gesture
    if (g.kind === 'pinch') {
      if (pointers.size >= 2) {
        const {middle, distance} = pinchGeometry()
        gesture = {kind: 'pinch', anchor: at(middle), zoom: view.zoom, distance}
      } else if (pointers.size) beginPan(pointers.values().next().value)
      else clearGesture()
      return
    }
    if (cancelled) { clearGesture(); return }
    const point = local(event)
    if (g.kind === 'draw') {
      const item = drawDraft(g, point, event.shiftKey)
      clearGesture()
      insert(item)
    } else if (g.kind === 'move' || g.kind === 'resize') {
      preview(point, event.shiftKey)
      const before = items
      if (g.preview && items.some(item => item.id === g.preview.id)) patch(g.preview.id, g.preview)
      gesture = null
      commit(before)
    } else clearGesture()
  }
  viewport.addEventListener('pointerup', event => endPointer(event, false))
  viewport.addEventListener('pointercancel', event => endPointer(event, true))
  viewport.addEventListener('lostpointercapture', event => endPointer(event, true))

  viewport.addEventListener('dblclick', event => {
    if (tool !== 'select' || editing) return
    const node = document.elementFromPoint(event.clientX, event.clientY)?.closest('.ec-node')
    if (node?.dataset.type !== 'text') return
    select(node.dataset.id)
    startTextEdit()
  })

  viewport.addEventListener('wheel', event => {
    if (event.target.closest('textarea') && !event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    if (gesture || trackpadPinch) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
    if (event.ctrlKey || event.metaKey) {
      zoomAt(view.zoom * Math.exp(-event.deltaY * unit * .012), local(event))
    } else {
      let dx = event.deltaX * unit, dy = event.deltaY * unit
      if (event.shiftKey && dx === 0) { dx = dy; dy = 0 }
      view = {...view, x: view.x - dx, y: view.y - dy}
      camera()
    }
  }, {passive: false})


  // Safari trackpads report native gesture events. Touchscreens already use the pointer path.
  viewport.addEventListener('gesturestart', event => {
    event.preventDefault()
    if (!gesture) {
      const point = Number.isFinite(event.clientX) ? local(event) : center()
      trackpadPinch = {zoom: view.zoom, anchor: at(point), point}
    }
  })
  viewport.addEventListener('gesturechange', event => {
    event.preventDefault()
    if (!trackpadPinch || pointers.size > 1) return
    const point = Number.isFinite(event.clientX) ? local(event) : trackpadPinch.point
    zoomAt(trackpadPinch.zoom * event.scale, point, trackpadPinch.anchor)
  })
  viewport.addEventListener('gestureend', event => { event.preventDefault(); trackpadPinch = null })

  viewport.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    viewport.dataset.dragging = 'true'
  })
  viewport.addEventListener('dragleave', event => {
    if (!viewport.contains(event.relatedTarget)) delete viewport.dataset.dragging
  })
  viewport.addEventListener('drop', event => {
    delete viewport.dataset.dragging
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    addFiles(event.dataTransfer.files, at(local(event)))
  })

  function modalOpen() { return !!document.querySelector('dialog[open],[aria-modal="true"]:not([hidden])') }
  function pasteText(text, point) {
    if (!text) return
    if (text.length > MAX_TEXT) {
      onError('Each text layer can hold up to 200,000 characters.')
      return
    }
    insert({...newText(point.x, point.y, text), width: 320})
  }
  document.addEventListener('paste', event => {
    if (editable(event.target) || modalOpen() || !event.clipboardData) return
    let files = Array.from(event.clipboardData.files)
    if (!files.length) {
      files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file')
        .map(item => item.getAsFile()).filter(Boolean)
    }
    const text = event.clipboardData.getData('text/plain')
    if (!files.length && !text) return
    event.preventDefault()
    const point = at(rememberedPoint || center())
    if (files.length) addFiles(files, point)
    else pasteText(text, point)
  })

  const shortcuts = {v: 'select', h: 'hand', t: 'text', r: 'rectangle', o: 'ellipse'}
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || editable(event.target) || modalOpen() || event.isComposing) return
    const key = event.key.toLowerCase()
    const cmd = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      clearGesture()
      setTool('select')
      select(null)
      return
    }
    if (gesture) return
    if (cmd && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) restore(future, past)
      else restore(past, future)
    } else if (cmd && key === 'y') {
      event.preventDefault()
      restore(future, past)
    } else if (cmd && ['-', '=', '+'].includes(key)) {
      event.preventDefault()
      zoomAt(view.zoom * (key === '-' ? .8 : 1.25), center())
    } else if (cmd && key === '0') {
      event.preventDefault()
      zoomAt(1, center())
    } else if (cmd || event.altKey) {
      return
    } else if (shortcuts[key]) {
      event.preventDefault()
      setTool(shortcuts[key])
    } else if (event.shiftKey && (key === '1' || key === '!')) {
      event.preventDefault()
      zoomToFit()
    } else if (event.code === 'Space' && !event.target.closest('button,a')) {
      event.preventDefault()
      spaceDown = true
      viewport.dataset.ecTool = 'hand'
    } else if (key === 'delete' || key === 'backspace') {
      if (!selected()) return
      event.preventDefault()
      remove()
    } else if (key === 'enter' && event.target === viewport) {
      event.preventDefault()
      if (tool === 'text') {
        const point = at(center())
        insert(newText(point.x, point.y))
      } else if (SHAPES.includes(tool)) {
        const point = at(center())
        insert({id: crypto.randomUUID(), type: 'shape', shape: tool, ...point,
          width: 120, height: 120, color: COLORS.shape})
      } else startTextEdit()
    } else if (key === '[' || key === ']') {
      event.preventDefault()
      arrange(key === '[' ? 'backward' : 'forward')
    } else if (key.startsWith('arrow') && selected() && event.target === viewport) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      const {x,y} = selected()
      updateSelected({x: x + step * ((key === 'arrowright') - (key === 'arrowleft')),
        y: y + step * ((key === 'arrowdown') - (key === 'arrowup'))})
    }
  })
  const releaseSpace = () => { spaceDown = false; viewport.dataset.ecTool = tool }
  document.addEventListener('keyup', event => { if (event.code === 'Space') releaseSpace() })
  window.addEventListener('blur', () => {
    releaseSpace()
    trackpadPinch = null
    clearGesture()
    pointers.clear()
  })

  render()
  camera()
  notify()
  return {
    setItems, setTool, select, updateSelected, arrange, remove, zoomToFit, addFiles, startTextEdit,
    finishEditing, canReplaceItems: () => !editing && !gesture && !uploadCount,
    getItems: () => items, undo: () => restore(past, future), redo: () => restore(future, past),
    zoomBy: factor => zoomAt(view.zoom * factor, center()), zoomToActual: () => zoomAt(1, center()),
  }
}
