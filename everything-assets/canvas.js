import { FONT_FAMILIES } from './fonts.js'
import { prepareImage } from './images.js'
import { copyLayerToEvent, readLayerFromEvent, readSystemClipboard, writeSystemLayer } from './clipboard.js'
import { snapMove, snapResize } from './snapping.js'
import { exportPhoto } from './export.js'

const MIN_ZOOM = .02
const MAX_ZOOM = 16
const TRACKPAD_STEP = 1.04
const WHEEL_PIXELS_PER_STEP = 20
const PINCH_LOG_PER_STEP = Math.log(1.14)
const WHEEL_GESTURE_GAP_MS = 180
const CSS_COORDINATE_RANGE = 8_000_000
const MAX_TEXT = 200_000
const MAX_ITEMS = 10_000
const SHAPES = ['rectangle', 'ellipse', 'triangle']
const COLORS = {shape: '#b9cbb6', text: '#252724'}
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const editable = target => target instanceof Element &&
  !!target.closest('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]')

function transferFiles(transfer) {
  const files = Array.from(transfer?.files || [])
  if (files.length) return files
  return Array.from(transfer?.items || []).filter(item => item.kind === 'file')
    .map(item => item.getAsFile()).filter(Boolean)
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

function bounds(items) {
  if (!items.length) return null
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const item of items) {
    x = Math.min(x, item.x)
    y = Math.min(y, item.y)
    right = Math.max(right, item.x + item.width)
    bottom = Math.max(bottom, item.y + item.height)
  }
  return {x, y, width: right - x, height: bottom - y}
}

function translated(items, dx, dy) {
  const area = bounds(items)
  // Clamp the shared offset so layers at the storage boundary stay together.
  dx = clamp(dx, -1e9 - area.x, 1e9 - Math.max(...items.map(item => item.x)))
  dy = clamp(dy, -1e9 - area.y, 1e9 - Math.max(...items.map(item => item.y)))
  return items.map(item => ({...item, x: item.x + dx, y: item.y + dy}))
}

// Revisions, credentials, and uploads are handled by the caller. Scene snapshots are
// immutable, so pointer previews and undo history can share unmodified layers.
export function createCanvas({
  viewport, world, items: initialItems = [], onChange = () => {}, onState = () => {},
  uploadImage, loadImage, onError = () => {}, onNotice = () => {},
}) {
  let items = initialItems.map(item => ({...item}))
  let selectedIds = new Set()
  let tool = 'select'
  let editing = null
  let gesture = null
  let spaceDown = false
  let trackpadPinch = null
  let wheelPinch = null
  let nativeWheelGuard = null
  let uploadCount = 0
  let exporting = false
  let view = {x: 0, y: 0, zoom: 1}
  let minZoom = MIN_ZOOM
  let layout = {x: 0, y: 0, scale: 1}
  let rememberedPoint = null
  let copiedLayer = null
  let localCopyOnly = false
  let lastPlacement = null
  let lastHistoryGroup = null
  const past = [], future = []
  const nodes = new Map()
  const images = new Map()
  const pointers = new Map()
  const selection = document.createElement('div')
  selection.className = 'ec-selection'
  selection.setAttribute('aria-hidden', 'true')
  const marquee = document.createElement('div')
  marquee.className = 'ec-marquee'
  marquee.setAttribute('aria-hidden', 'true')
  marquee.hidden = true
  viewport.append(marquee)
  const snapGuides = document.createElement('div')
  snapGuides.className = 'ec-snap-guides'
  snapGuides.setAttribute('aria-hidden', 'true')
  snapGuides.hidden = true
  viewport.append(snapGuides)
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
  const selectedItems = () => items.filter(item => selectedIds.has(item.id))
  const selected = () => selectedIds.size === 1 ? selectedItems()[0] ?? null : null
  const selectedPhoto = () => {
    const photos = selectedItems().filter(item => item.type === 'image')
    return photos.length === 1 ? photos[0] : null
  }
  const pruneSelection = () => { selectedIds = new Set(selectedItems().map(item => item.id)) }

  function notify() {
    onState({tool, selected: selected(), selectedItems: selectedItems(), selectedIds: [...selectedIds],
      items, zoom: view.zoom, canUndo: !!past.length,
      canRedo: !!future.length, busy: uploadCount > 0, exporting, canExportPhoto: !!selectedPhoto()})
  }

  function box(element, item) {
    element.style.left = (item.x - layout.x) * layout.scale + 'px'
    element.style.top = (item.y - layout.y) * layout.scale + 'px'
    element.style.width = item.width + 'px'
    element.style.height = item.height + 'px'
    element.style.transformOrigin = '0 0'
    element.style.transform = layout.scale === 1 ? '' : 'scale(' + layout.scale + ')'
  }

  function drawSnapGuides(guides = []) {
    while (snapGuides.firstElementChild) snapGuides.firstElementChild.remove()
    for (const guide of guides) {
      const vertical = guide.axis === 'x'
      const value = guide.value * view.zoom + (vertical ? view.x : view.y)
      const start = Math.max(0, guide.from * view.zoom + (vertical ? view.y : view.x) - 8)
      const end = Math.min(vertical ? viewport.clientHeight : viewport.clientWidth,
        guide.to * view.zoom + (vertical ? view.y : view.x) + 8)
      if (value < 0 || value > (vertical ? viewport.clientWidth : viewport.clientHeight) || end <= start) continue
      const line = document.createElement('div')
      line.className = 'ec-snap-guide'
      line.dataset.axis = guide.axis
      line.style.left = (vertical ? value : start) + 'px'
      line.style.top = (vertical ? start : value) + 'px'
      line.style.width = (vertical ? 0 : end - start) + 'px'
      line.style.height = (vertical ? end - start : 0) + 'px'
      if (guide.label) {
        const label = document.createElement('span')
        label.className = 'ec-snap-label'
        label.textContent = guide.label
        line.append(label)
      }
      snapGuides.append(line)
    }
    snapGuides.hidden = !snapGuides.firstElementChild
  }

  // Copied layers share one private fetch and one object URL for as long as they display the image.
  async function fetchImage(id, entry) {
    entry.failed = false
    try {
      const blob = await loadImage(id)
      if (images.get(id) !== entry) return
      entry.url = URL.createObjectURL(blob)
      for (const element of entry.elements) element.src = entry.url
    } catch (error) {
      if (images.get(id) !== entry) return
      entry.failed = true
      onError(error.message || 'The image could not be loaded.')
    }
  }

  function releaseImage(element) {
    const id = element.dataset.imageId
    const entry = images.get(id)
    if (!entry) return
    element.removeAttribute('src')
    delete element.dataset.imageId
    entry.elements.delete(element)
    if (!entry.elements.size) {
      if (entry.url) URL.revokeObjectURL(entry.url)
      images.delete(id)
    }
  }

  function showImage(element, id) {
    if (element.dataset.imageId === id) return
    releaseImage(element)
    element.dataset.imageId = id
    let entry = images.get(id)
    if (!entry) {
      entry = {elements: new Set(), url: null, failed: false}
      images.set(id, entry)
      fetchImage(id, entry)
    }
    entry.elements.add(element)
    if (entry.url) element.src = entry.url
  }

  function retryImages() {
    for (const [id, entry] of images) if (entry.failed) fetchImage(id, entry)
  }
  window.addEventListener('online', retryImages)
  window.addEventListener('focus', retryImages)
  window.addEventListener('pagehide', () => {
    for (const node of nodes.values()) releaseImage(node.firstElementChild)
  })

  function drawNode(item) {
    let node = nodes.get(item.id)
    if (!node || node.dataset.type !== item.type) {
      if (node) {
        releaseImage(node.firstElementChild)
        node.remove()
      }
      node = document.createElement('div')
      node.className = 'ec-node'
      node.dataset.id = item.id
      node.dataset.type = item.type
      const content = document.createElement(item.type === 'image' ? 'img' : 'div')
      content.className = 'ec-content'
      if (item.type === 'image') {
        content.draggable = false
        content.decoding = 'async'
      }
      node.append(content)
      nodes.set(item.id, node)
    }
    box(node, item)
    const content = node.firstElementChild
    if (item.type === 'image') {
      // An exceptionally large resized image must still fit the browser's CSS layout range.
      content.style.setProperty('--ec-image-limit', CSS_COORDINATE_RANGE / Math.max(item.width, item.height))
      showImage(content, item.imageId)
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
      node.style.fontStyle = item.italic ? 'italic' : 'normal'
      node.style.color = item.color
      content.classList.add('ec-text')
      if (content.textContent !== item.text) content.textContent = item.text
    }
    return node
  }

  function drawSelection(chosen = selectedItems()) {
    const area = bounds(chosen)
    selection.hidden = !area || tool !== 'select'
    selection.dataset.multiple = String(chosen.length > 1)
    if (area) box(selection, area)
    selection.style.visibility = editing ? 'hidden' : ''
    for (const [id, node] of nodes) {
      node.dataset.ecSelected = String(selectedIds.has(id) && chosen.length > 1 && tool === 'select' && !editing)
    }
  }

  function render() {
    const ids = new Set(items.map(item => item.id))
    for (const [id, node] of nodes) {
      if (!ids.has(id)) {
        releaseImage(node.firstElementChild)
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

  // Keep the last usable transform when a browser supplies incomplete gesture data.
  function applyView(x, y, zoom) {
    if (![x, y, zoom].every(Number.isFinite) || zoom < minZoom || zoom > MAX_ZOOM) return
    view = {x, y, zoom}
    const tx = x + layout.x * zoom, ty = y + layout.y * zoom
    world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + zoom / layout.scale + ')'
    world.style.setProperty('--ec-image-zoom', Math.max(MIN_ZOOM, zoom))
    world.style.setProperty('--ec-line', 1 / view.zoom + 'px')
    world.style.setProperty('--ec-handle', 8 / view.zoom + 'px')
    let gridSize = 22 * view.zoom
    while (gridSize < 12) gridSize *= 2
    while (gridSize > 32) gridSize /= 2
    viewport.style.setProperty('--grid-size', gridSize + 'px')
    viewport.style.setProperty('--grid-x', view.x % gridSize + 'px')
    viewport.style.setProperty('--grid-y', view.y % gridSize + 'px')
  }

  function remember(before, historyGroup = null) {
    if (!historyGroup || lastHistoryGroup?.key !== historyGroup || lastHistoryGroup.items !== before) {
      past.push(before)
      if (past.length > 80) past.shift()
    }
    lastHistoryGroup = historyGroup ? {key: historyGroup, items} : null
    future.length = 0
  }

  function commit(before, historyGroup = null) {
    if (items !== before) {
      remember(before, historyGroup)
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
    const descriptor = (original.italic ? 'italic ' : '') + original.fontSize + 'px "' + original.font + '"'
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
    pruneSelection()
    past.length = future.length = 0
    lastHistoryGroup = null
    render()
    notify()
  }

  function select(id, {toggle = false} = {}) {
    finishEditing()
    if (items.some(item => item.id === id)) {
      if (!toggle) selectedIds = new Set([id])
      else if (selectedIds.has(id)) selectedIds.delete(id)
      else selectedIds.add(id)
      tool = 'select'
    } else selectedIds.clear()
    render()
    notify()
  }

  function setTool(next) {
    if (!['select', 'hand', 'text', ...SHAPES].includes(next)) return
    finishEditing()
    tool = next
    if (next !== 'select') selectedIds.clear()
    render()
    notify()
  }

  function local(event, fallback = null) {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return fallback
    const rect = viewport.getBoundingClientRect()
    return {x: event.clientX - rect.left, y: event.clientY - rect.top}
  }
  const at = point => ({x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom})
  const center = () => ({x: viewport.clientWidth / 2, y: viewport.clientHeight / 2})

  function zoomAt(zoom, point, anchor = at(point)) {
    if (!Number.isFinite(zoom) || zoom <= 0) return
    zoom = clamp(zoom, minZoom, MAX_ZOOM)
    applyView(point.x - anchor.x * zoom, point.y - anchor.y * zoom, zoom)
    notify()
  }

  function resetTrackpad() {
    trackpadPinch = wheelPinch = nativeWheelGuard = null
  }

  // Carry fractional travel between samples. A very large sample can move two
  // stops; excess whole stops are discarded, so nothing runs after release.
  function trackpadStep(state, delta, point, anchor) {
    if (delta * state.remainder < 0) state.remainder = 0
    const total = state.remainder + delta
    const stops = Math.sign(total) * Math.floor(Math.abs(total) + 1e-9)
    state.remainder = total - stops
    if (stops) {
      const next = view.zoom * TRACKPAD_STEP ** clamp(stops, -2, 2)
      if (next >= MAX_ZOOM || next <= minZoom) state.remainder = 0
      zoomAt(next, point, anchor)
    } else if (anchor) {
      applyView(point.x - anchor.x * view.zoom, point.y - anchor.y * view.zoom, view.zoom)
    }
  }

  function manualZoom(zoom) {
    resetTrackpad()
    zoomAt(zoom, center())
  }

  function zoomToFit() {
    // A late pointer-up or Safari gesturechange must not overwrite the recovered view.
    resetTrackpad()
    for (const id of pointers.keys()) {
      if (viewport.hasPointerCapture?.(id)) viewport.releasePointerCapture(id)
    }
    pointers.clear()
    clearGesture()
    if (!items.length) {
      minZoom = MIN_ZOOM
      layout = {x: 0, y: 0, scale: 1}
      applyView(0, 0, 1)
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
    if (!viewport.clientWidth || !viewport.clientHeight) return
    const width = Math.max(1, right - left), height = Math.max(1, bottom - top)
    const middle = {x: (left + right) / 2, y: (top + bottom) / 2}
    const zoom = Math.min(1.5, viewport.clientWidth * .72 / width, viewport.clientHeight * .68 / height)
    minZoom = Math.min(MIN_ZOOM, zoom)
    // Browsers clamp CSS layout coordinates well before the board's storage bounds.
    // Keep extreme layouts near zero and let the camera restore their true scale.
    const extreme = Math.max(Math.abs(left), Math.abs(right), Math.abs(top), Math.abs(bottom)) > CSS_COORDINATE_RANGE
    const next = extreme
      ? {...middle, scale: Math.min(1, CSS_COORDINATE_RANGE / Math.max(width, height))}
      : {x: 0, y: 0, scale: 1}
    if (next.x !== layout.x || next.y !== layout.y || next.scale !== layout.scale) {
      layout = next
      render()
    }
    zoomAt(zoom, center(), middle)
  }

  function finishEditing() {
    if (!editing) return
    const {input, before, id, savedDraft} = editing
    editing = null
    input.remove()
    const item = items.find(entry => entry.id === id)
    if (item && !item.text.length) {
      items = items.filter(entry => entry.id !== id)
      selectedIds.delete(id)
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

  function updateSelected(props, {historyGroup = null} = {}) {
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
    if (item.type === 'text' && typeof props.italic === 'boolean') value.italic = props.italic
    if (Object.keys(value).every(key => value[key] === item[key])) return
    const before = items
    patch(item.id, value)
    if (item.type === 'text' && !('height' in value)) {
      const content = drawNode(selected()).firstElementChild
      if (content.scrollHeight > selected().height) patch(item.id, {height: content.scrollHeight + 1})
    }
    commit(before, historyGroup)
    if (!('height' in value)) growForLoadedFont(item.id)
  }

  function remove() {
    finishEditing()
    if (!selectedIds.size) return
    const before = items
    items = items.filter(item => !selectedIds.has(item.id))
    selectedIds.clear()
    commit(before)
  }

  function arrange(direction) {
    finishEditing()
    if (!selectedIds.size) return
    const before = items
    const chosen = selectedItems(), others = items.filter(item => !selectedIds.has(item.id))
    let next
    if (direction === 'front') next = [...others, ...chosen]
    else if (direction === 'back') next = [...chosen, ...others]
    else if (direction === 'forward' || direction === 'backward') {
      next = [...items]
      const step = direction === 'forward' ? -1 : 1
      for (let i = step === -1 ? next.length - 2 : 1; i >= 0 && i < next.length; i += step) {
        const neighbor = i - step
        if (next[neighbor] && selectedIds.has(next[i].id) && !selectedIds.has(next[neighbor].id)) {
          [next[i], next[neighbor]] = [next[neighbor], next[i]]
        }
      }
    } else return
    if (next.every((item, index) => item === before[index])) return
    items = next
    commit(before)
  }

  function moveSelected(dx, dy) {
    const chosen = selectedItems()
    if (!chosen.length) return
    const moved = new Map(translated(chosen, dx, dy).map(item => [item.id, item]))
    if (chosen.every(item => moved.get(item.id).x === item.x && moved.get(item.id).y === item.y)) return
    const before = items
    items = items.map(item => moved.get(item.id) || item)
    commit(before)
  }

  function restore(source, destination) {
    finishEditing()
    if (!source.length || gesture) return
    lastHistoryGroup = null
    destination.push(items)
    items = source.pop()
    pruneSelection()
    render()
    notify()
    onChange(items)
  }

  function hasRoom() {
    if (items.length < MAX_ITEMS) return true
    onError('The canvas has reached its 10,000-layer limit.')
    return false
  }

  function insert(item, {fitText = true} = {}) {
    if (!hasRoom()) return
    finishEditing()
    const before = items
    items = [...items, item]
    selectedIds = new Set([item.id])
    tool = 'select'
    if (fitText && item.type === 'text' && !item.text) {
      render()
      editText(before)
      notify()
      return
    }
    if (fitText && item.type === 'text') {
      render()
      const height = nodes.get(item.id).firstElementChild.scrollHeight
      if (height > item.height) patch(item.id, {height: height + 1})
    }
    commit(before)
    if (fitText) growForLoadedFont(item.id)
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

  async function exportSelectedPhoto() {
    if (exporting || gesture) return
    finishEditing()
    const photo = selectedPhoto()
    if (!photo) return
    const scene = items
    exporting = true
    notify()
    try {
      const {blob, width, height, filename} = await exportPhoto({photo, items: scene, loadImage})
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      try { link.click() }
      finally {
        link.remove()
        // Leave the download URL alive long enough for the browser to consume it.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      onNotice('Downloading PNG: ' + width + ' × ' + height + ' pixels.')
    } catch (error) {
      onError(error.message || 'The photo could not be exported.')
    } finally {
      exporting = false
      notify()
    }
  }

  function clearGesture() {
    if (!gesture) return
    drawSnapGuides()
    if (gesture.kind === 'marquee') selectedIds = gesture.selectionBefore
    if (gesture.preview && gesture.kind === 'draw') {
      nodes.get(gesture.preview.id)?.remove()
      nodes.delete(gesture.preview.id)
    }
    gesture = null
    marquee.hidden = true
    delete viewport.dataset.ecPanning
    render()
    notify()
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
    const point = local(event)
    if (!point) return
    resetTrackpad()
    finishEditing()
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
      gesture = {kind: 'resize', start: point, original: selected(), handle,
        targets: items.filter(item => !selectedIds.has(item.id))}
      return
    }
    if (tool !== 'select') {
      if (!hasRoom()) return
      gesture = {kind: 'draw', start: point, origin: at(point), tool, id: crypto.randomUUID()}
      return
    }
    const id = event.target.closest('.ec-node')?.dataset.id
    if (id) {
      if (event.shiftKey) {
        if (selectedIds.has(id)) selectedIds.delete(id)
        else selectedIds.add(id)
      } else if (!selectedIds.has(id)) selectedIds = new Set([id])
      if (selectedIds.has(id)) gesture = {kind: 'move', start: point, originals: selectedItems(),
        targets: items.filter(item => !selectedIds.has(item.id))}
    } else {
      const selectionBefore = new Set(selectedIds)
      if (!event.shiftKey) selectedIds.clear()
      gesture = {kind: 'marquee', start: point, origin: at(point), selectionBefore,
        base: new Set(selectedIds)}
    }
    drawSelection()
    notify()
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

  function preview(point, shift, unsnapped = false) {
    const g = gesture
    const dx = point.x - g.start.x, dy = point.y - g.start.y
    if (g.kind === 'pan') {
      applyView(g.view.x + dx, g.view.y + dy, g.view.zoom)
    } else if (g.kind === 'draw') {
      g.preview = drawDraft(g, point, shift)
      const node = drawNode(g.preview)
      if (!node.isConnected) world.insertBefore(node, selection)
      box(selection, g.preview)
      selection.dataset.multiple = 'false'
      selection.hidden = false
    } else if (g.kind === 'marquee') {
      if (!g.dragged && Math.hypot(dx, dy) < 3) return
      g.dragged = true
      const end = at(point)
      const left = Math.min(g.origin.x, end.x), right = Math.max(g.origin.x, end.x)
      const top = Math.min(g.origin.y, end.y), bottom = Math.max(g.origin.y, end.y)
      selectedIds = new Set(g.base)
      for (const item of items) {
        if (item.x <= right && item.x + item.width >= left &&
            item.y <= bottom && item.y + item.height >= top) selectedIds.add(item.id)
      }
      marquee.style.left = Math.min(g.start.x, point.x) + 'px'
      marquee.style.top = Math.min(g.start.y, point.y) + 'px'
      marquee.style.width = Math.abs(dx) + 'px'
      marquee.style.height = Math.abs(dy) + 'px'
      marquee.hidden = false
      drawSelection()
      notify()
    } else if (g.kind === 'move') {
      if (!g.preview && Math.hypot(dx, dy) < 2) return
      const raw = translated(g.originals, dx / view.zoom, dy / view.zoom)
      const snap = unsnapped ? {dx: 0, dy: 0, guides: []} : snapMove(raw, g.targets, view.zoom)
      g.preview = translated(raw, snap.dx, snap.dy)
      // A storage-boundary clamp must not display a guide that was not reached.
      drawSnapGuides(snap.guides.filter(guide => {
        const axis = guide.axis
        return Math.abs(g.preview[0][axis] - raw[0][axis] - (axis === 'x' ? snap.dx : snap.dy)) < 1e-6
      }))
      for (const item of g.preview) drawNode(item)
      drawSelection(g.preview)
    } else if (g.kind === 'resize') {
      if (!g.preview && Math.hypot(dx, dy) < 2) return
      const source = g.original
      const dimensions = resizeBox(source, g.handle, dx / view.zoom, dy / view.zoom, shift)
      const raw = {...source, ...dimensions}
      const preserveRatio = source.type === 'image' ? !shift : shift
      const snap = unsnapped ? {item: raw, guides: []} : snapResize(source, raw, g.handle, g.targets, view.zoom, preserveRatio)
      g.preview = snap.item
      drawSnapGuides(snap.guides)
      drawNode(g.preview)
      box(selection, g.preview)
    }
  }

  viewport.addEventListener('pointermove', event => {
    const point = local(event)
    if (!point) return
    rememberedPoint = point
    if (!pointers.has(event.pointerId) || !gesture) return
    pointers.set(event.pointerId, point)
    if (gesture.kind === 'pinch') {
      const {middle, distance} = pinchGeometry()
      zoomAt(gesture.zoom * distance / gesture.distance, middle, gesture.anchor)
      return
    }
    preview(point, event.shiftKey, event.altKey)
  })
  viewport.addEventListener('pointerleave', () => { rememberedPoint = null })

  function endPointer(event, cancelled) {
    const lastPoint = pointers.get(event.pointerId)
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
    const point = local(event, lastPoint)
    if (g.kind === 'draw') {
      const item = drawDraft(g, point, event.shiftKey)
      clearGesture()
      insert(item)
    } else if (g.kind === 'move' || g.kind === 'resize') {
      preview(point, event.shiftKey, event.altKey)
      const before = items
      if (g.preview) {
        const previews = new Map((g.kind === 'move' ? g.preview : [g.preview]).map(item => [item.id, item]))
        const changed = items.some(item => {
          const next = previews.get(item.id)
          return next && ['x', 'y', 'width', 'height'].some(key => next[key] !== item[key])
        })
        if (changed) items = items.map(item => previews.get(item.id) || item)
      }
      gesture = null
      drawSnapGuides()
      commit(before)
    } else if (g.kind === 'marquee') {
      preview(point, event.shiftKey)
      gesture = null
      marquee.hidden = true
      drawSelection()
      notify()
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
    if (gesture) return
    // WebKit can deliver wheel samples alongside a native pinch. Its midpoint
    // already accounts for any pan during the gesture.
    if (trackpadPinch && event.timeStamp - trackpadPinch.last < WHEEL_GESTURE_GAP_MS) return
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
    if (event.ctrlKey || event.metaKey) {
      const delta = -event.deltaY * unit
      if (!Number.isFinite(delta) || !delta) return
      if (nativeWheelGuard && event.timeStamp <= nativeWheelGuard.until &&
          Math.sign(delta) === nativeWheelGuard.direction) return
      trackpadPinch = null
      if (!wheelPinch || event.timeStamp - wheelPinch.last > WHEEL_GESTURE_GAP_MS) wheelPinch = {remainder: 0}
      wheelPinch.last = event.timeStamp
      trackpadStep(wheelPinch, delta / WHEEL_PIXELS_PER_STEP, local(event, center()))
    } else {
      resetTrackpad()
      let dx = event.deltaX * unit, dy = event.deltaY * unit
      if (event.shiftKey && dx === 0) { dx = dy; dy = 0 }
      applyView(view.x - dx, view.y - dy, view.zoom)
    }
  }, {passive: false})


  // Safari trackpads report native gesture events. Touchscreens already use the pointer path.
  viewport.addEventListener('gesturestart', event => {
    event.preventDefault()
    if (!gesture) {
      const point = local(event, center())
      resetTrackpad()
      trackpadPinch = {anchor: at(point), point, remainder: 0, lastScale: 1, last: event.timeStamp}
    }
  })
  viewport.addEventListener('gesturechange', event => {
    event.preventDefault()
    if (!trackpadPinch || pointers.size > 1) return
    if (!Number.isFinite(event.scale) || event.scale <= 0) return
    const delta = Math.log(event.scale) - Math.log(trackpadPinch.lastScale)
    trackpadPinch.lastScale = event.scale
    trackpadPinch.last = event.timeStamp
    if (delta) nativeWheelGuard = {until: event.timeStamp + 90, direction: Math.sign(delta)}
    wheelPinch = null
    trackpadPinch.point = local(event, trackpadPinch.point)
    trackpadStep(trackpadPinch, delta / PINCH_LOG_PER_STEP, trackpadPinch.point, trackpadPinch.anchor)
  })
  viewport.addEventListener('gestureend', event => {
    event.preventDefault()
    if (trackpadPinch && nativeWheelGuard) nativeWheelGuard.until = event.timeStamp + 90
    trackpadPinch = null
  })

  viewport.addEventListener('dragover', event => {
    const transfer = event.dataTransfer
    // A drag can expose the file kind before the browser exposes its name or MIME type.
    if (!transfer || (!transfer.types.includes('Files') && !Array.from(transfer.items).some(item => item.kind === 'file'))) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    viewport.dataset.dragging = 'true'
  })
  viewport.addEventListener('dragleave', event => {
    if (!viewport.contains(event.relatedTarget)) delete viewport.dataset.dragging
  })
  viewport.addEventListener('drop', event => {
    delete viewport.dataset.dragging
    const files = transferFiles(event.dataTransfer)
    if (!files.length) return
    event.preventDefault()
    addFiles(files, at(local(event, center())))
  })

  function modalOpen() { return !!document.querySelector('dialog[open],[aria-modal="true"]:not([hidden])') }
  function clipboardBusy() { return editing || gesture || modalOpen() }

  function pasteLayer(item, point) {
    const offset = 16 / view.zoom
    const onSource = point.x >= item.x && point.x <= item.x + item.width &&
      point.y >= item.y && point.y <= item.y + item.height
    let x = onSource ? item.x + offset : point.x - item.width / 2
    let y = onSource ? item.y + offset : point.y - item.height / 2
    if (lastPlacement?.source === item.id && selected()?.id === lastPlacement.id &&
        Math.hypot(point.x - lastPlacement.point.x, point.y - lastPlacement.point.y) < 3 / view.zoom) {
      const previous = selected()
      if (previous) { x = previous.x + offset; y = previous.y + offset }
    }
    const id = crypto.randomUUID()
    insert({...item, id, x: clamp(x, -1e9, 1e9), y: clamp(y, -1e9, 1e9)}, {fitText: false})
    if (selected()?.id === id) lastPlacement = {source: item.id, id, point}
  }

  document.addEventListener('copy', event => {
    const item = selected()
    if (!item || !event.clipboardData || event.defaultPrevented || editable(event.target) ||
        clipboardBusy() || document.getSelection()?.toString()) return
    copyLayerToEvent(item, event.clipboardData)
    event.preventDefault()
    copiedLayer = item
    localCopyOnly = false
  })

  async function copySelected() {
    const item = selected()
    if (!item || clipboardBusy()) return
    copiedLayer = item
    localCopyOnly = false
    try {
      await writeSystemLayer(item)
    } catch {
      if (!document.execCommand?.('copy')) {
        localCopyOnly = true
        onError('Copied inside Everything. Use Paste in this tab.')
      }
    }
  }

  function pasteText(text, point) {
    if (!text) return
    if (text.length > MAX_TEXT) {
      onError('Each text layer can hold up to 200,000 characters.')
      return
    }
    insert({...newText(point.x, point.y, text), width: 320})
  }
  document.addEventListener('paste', event => {
    if (editable(event.target) || clipboardBusy() || event.defaultPrevented || !event.clipboardData) return
    const layer = readLayerFromEvent(event.clipboardData)
    const files = transferFiles(event.clipboardData)
    const text = event.clipboardData.getData('text/plain')
    if (!layer && !files.length && !text) return
    event.preventDefault()
    localCopyOnly = false
    copiedLayer = layer
    const point = at(rememberedPoint || center())
    if (layer) pasteLayer(layer, point)
    else if (files.length) addFiles(files, point)
    else pasteText(text, point)
  })

  async function pasteClipboard() {
    if (clipboardBusy()) return
    const point = at(rememberedPoint || center())
    if (copiedLayer && (localCopyOnly || !navigator.clipboard?.read)) {
      pasteLayer(copiedLayer, point)
      return
    }
    let contents
    try {
      contents = await readSystemClipboard()
    } catch {
      if (clipboardBusy()) return
      if (copiedLayer) {
        pasteLayer(copiedLayer, point)
        onError('Pasted the layer last copied in Everything.')
      } else onError('Use your device’s Paste command or allow clipboard access.')
      return
    }
    if (clipboardBusy()) return
    const {layer, files, text} = contents
    copiedLayer = layer || null
    if (layer) pasteLayer(layer, point)
    else if (files?.length) await addFiles(files, point)
    else if (text) pasteText(text, point)
    else onError('Copy a layer, image, or text first.')
  }

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
    if (!cmd && !event.altKey && event.shiftKey && (key === '1' || key === '!')) {
      event.preventDefault()
      zoomToFit()
      return
    }
    if (gesture) {
      if (event.key === 'Alt' && ['move', 'resize'].includes(gesture.kind)) {
        const point = pointers.values().next().value
        if (point) preview(point, event.shiftKey, true)
      }
      return
    }
    if (cmd && key === 'a') {
      event.preventDefault()
      selectedIds = new Set(items.map(item => item.id))
      tool = 'select'
      render()
      notify()
    } else if (cmd && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) restore(future, past)
      else restore(past, future)
    } else if (cmd && key === 'y') {
      event.preventDefault()
      restore(future, past)
    } else if (cmd && ['-', '=', '+'].includes(key)) {
      event.preventDefault()
      manualZoom(view.zoom * (key === '-' ? .8 : 1.25))
    } else if (cmd && key === '0') {
      event.preventDefault()
      manualZoom(1)
    } else if (cmd || event.altKey) {
      return
    } else if (shortcuts[key]) {
      event.preventDefault()
      setTool(shortcuts[key])
    } else if (event.code === 'Space' && !event.target.closest('button,a')) {
      event.preventDefault()
      spaceDown = true
      viewport.dataset.ecTool = 'hand'
    } else if (key === 'delete' || key === 'backspace') {
      if (!selectedIds.size) return
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
    } else if (key.startsWith('arrow') && selectedIds.size && event.target === viewport) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      moveSelected(step * ((key === 'arrowright') - (key === 'arrowleft')),
        step * ((key === 'arrowdown') - (key === 'arrowup')))
    }
  })
  const releaseSpace = () => { spaceDown = false; viewport.dataset.ecTool = tool }
  document.addEventListener('keyup', event => {
    if (event.code === 'Space') releaseSpace()
    if (event.key === 'Alt' && gesture && ['move', 'resize'].includes(gesture.kind)) {
      const point = pointers.values().next().value
      if (point) preview(point, event.shiftKey, false)
    }
  })
  window.addEventListener('blur', () => {
    releaseSpace()
    resetTrackpad()
    clearGesture()
    pointers.clear()
  })

  render()
  applyView(0, 0, 1)
  notify()
  return {
    setItems, setTool, select, updateSelected, arrange, remove, zoomToFit, addFiles, startTextEdit,
    finishEditing, copySelected, pasteClipboard, exportSelectedPhoto, canReplaceItems: () => !editing && !gesture && !uploadCount,
    getItems: () => items, undo: () => restore(past, future), redo: () => restore(future, past),
    zoomBy: factor => manualZoom(view.zoom * factor), zoomToActual: () => manualZoom(1),
  }
}
