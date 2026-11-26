import assert from 'node:assert/strict'
import {test} from 'node:test'
import {bindShell, renderShell} from '../everything-assets/shell.js'

// Inspector controls only: the real shell listeners receive native input events.
class Control extends EventTarget {
  dataset = {}
  hidden = false
  checked = false
  value = ''
  attributes = new Map()
  setAttribute(name, value) { this.attributes.set(name, value) }
  querySelector() { return this }
  add() {}
}

function inspector(t) {
  const controls = new Map()
  const control = id => {
    if (!controls.has(id)) controls.set(id, new Control())
    return controls.get(id)
  }
  const previous = {document: globalThis.document, Option: globalThis.Option}
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: control,
    querySelectorAll: () => [],
    activeElement: null,
  })
  globalThis.Option = class {}
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  control('layers-panel').hidden = true
  const layer = {id: 'text-a', type: 'text', text: 'Choose a color', font: 'DM Sans', fontSize: 24,
    color: '#252724', x: 10, y: 20, width: 240, height: 32}
  let selected = layer
  const show = (item, extra = {}) => {
    selected = item
    renderShell({tool: 'select', items: [item], selected: item, selectedItems: [item], selectedIds: [item.id],
      zoom: 1, busy: false, canUndo: false, canRedo: false, canExportPhoto: false, exporting: false, ...extra})
  }
  show(layer)
  const calls = []
  const exportOptions = []
  let exportCalls = 0
  bindShell({
    updateSelected(props, options) {
      calls.push({props, options})
      show({...selected, ...props})
    },
    exportSelectedPhoto(options) { exportCalls++; exportOptions.push(options) },
  })
  const picker = control('object-color')
  const emit = (type, color) => {
    if (color) picker.value = color
    picker.dispatchEvent(new Event(type))
    return calls.at(-1)
  }
  return {calls, control, emit, show, layer, exportOptions, exportCalls: () => exportCalls}
}

test('Instagram framing is optional, routes the chosen format, and survives selection and busy renders', t => {
  const {control, show, layer, exportOptions} = inspector(t)
  const option = control('export-instagram'), button = control('export-photo')
  const photo = {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo',
    x: 100, y: 20, width: 300, height: 200}
  show(photo, {canExportPhoto: true})
  assert.equal(option.checked, false)
  assert.equal(option.disabled, false)
  button.dispatchEvent(new Event('click'))
  assert.deepEqual(exportOptions.at(-1), {format: 'original'})

  option.checked = true
  button.dispatchEvent(new Event('click'))
  assert.deepEqual(exportOptions.at(-1), {format: 'instagram'})
  show(photo, {canExportPhoto: true, exporting: true})
  assert.equal(option.checked, true)
  assert.equal(option.disabled, true, 'the active export format cannot be changed while preparing')
  show(layer)
  assert.equal(option.checked, true, 'selecting another layer must not discard the preference')
  show({...photo, id: 'other-photo'}, {canExportPhoto: true})
  assert.equal(option.checked, true)
  assert.equal(option.disabled, false)
  button.dispatchEvent(new Event('click'))
  assert.deepEqual(exportOptions.at(-1), {format: 'instagram'})

  option.checked = false
  show(photo, {canExportPhoto: true})
  button.dispatchEvent(new Event('click'))
  assert.deepEqual(exportOptions.at(-1), {format: 'original'})
  assert.equal(exportOptions.length, 4)
})

test('photo export control follows selection eligibility, invokes export, and reports preparation', t => {
  const {control, show, layer, exportCalls} = inspector(t)
  const section = control('photo-export'), button = control('export-photo')
  assert.equal(section.hidden, true, 'text-only selection has no photo export action')
  const photo = {id: 'photo', type: 'image', imageId: 'photo.png', name: 'Photo',
    x: 100, y: 20, width: 300, height: 200}
  show(photo, {canExportPhoto: true})
  assert.equal(section.hidden, false)
  assert.equal(button.disabled, false)
  assert.equal(button.attributes.get('aria-busy'), 'false')
  assert.equal(button.textContent, 'Save photo + overlays')
  button.dispatchEvent(new Event('click'))
  assert.equal(exportCalls(), 1)
  show(photo, {items: [photo, layer], selected: null, selectedItems: [photo, layer],
    selectedIds: [photo.id, layer.id], canExportPhoto: true})
  assert.equal(section.hidden, false, 'selected text overlays do not hide the export action')
  show(photo, {canExportPhoto: true, exporting: true})
  assert.equal(button.disabled, true)
  assert.equal(button.attributes.get('aria-busy'), 'true')
  assert.equal(button.textContent, 'Preparing PNG…')
  show(photo, {canExportPhoto: true})
  assert.equal(button.disabled, false)
  assert.equal(button.attributes.get('aria-busy'), 'false')
  assert.equal(button.textContent, 'Save photo + overlays')
  show(photo, {canExportPhoto: false})
  assert.equal(section.hidden, true)
})

test('italic control reflects selected text and toggles emphasis on each click', t => {
  const {calls, control, show, layer} = inspector(t)
  const italic = control('font-italic')
  assert.equal(italic.attributes.get('aria-pressed'), 'false')
  italic.dispatchEvent(new Event('click'))
  assert.deepEqual(calls.at(-1).props, {italic: true})
  assert.equal(italic.attributes.get('aria-pressed'), 'true')
  italic.dispatchEvent(new Event('click'))
  assert.deepEqual(calls.at(-1).props, {italic: false})
  assert.equal(italic.attributes.get('aria-pressed'), 'false')
  show({...layer, id: 'text-b', italic: true})
  assert.equal(italic.attributes.get('aria-pressed'), 'true')
  show(layer)
  assert.equal(italic.attributes.get('aria-pressed'), 'false')
})

test('color input updates the selected text live and groups a picker session through its final change', t => {
  const {calls, control, emit} = inspector(t)
  const first = emit('input', '#123456')
  assert.equal(calls.length, 1, 'input must update the layer before the picker closes')
  assert.deepEqual(first.props, {color: '#123456'})
  assert.ok(first.options.historyGroup)
  assert.equal(control('hex-value').textContent, '#123456')
  const next = emit('input', '#abcdef')
  assert.deepEqual(next.props, {color: '#abcdef'})
  assert.equal(next.options.historyGroup, first.options.historyGroup)
  const final = emit('change', '#fedcba')
  assert.deepEqual(final.props, {color: '#fedcba'})
  assert.equal(final.options.historyGroup, first.options.historyGroup)
  assert.equal(calls.length, 3)
  const fresh = emit('input', '#654321')
  assert.notEqual(fresh.options.historyGroup, first.options.historyGroup)
})

test('reopening or blurring the color picker and changing layers start fresh color undo groups', t => {
  const {emit, show, layer} = inspector(t)
  let previous = emit('input', '#111111').options.historyGroup
  for (const event of ['pointerdown', 'blur']) {
    emit(event)
    const current = emit('input', '#222222').options.historyGroup
    assert.notEqual(current, previous, event + ' must end the previous color session')
    previous = current
  }
  show({...layer, id: 'text-b'})
  const otherLayer = emit('input', '#333333').options.historyGroup
  assert.notEqual(otherLayer, previous)
  emit('change', '#333333')
  const changeOnly = emit('change', '#444444')
  assert.deepEqual(changeOnly.props, {color: '#444444'})
  assert.notEqual(changeOnly.options.historyGroup, otherLayer, 'change-only pickers still save a new session')
})
