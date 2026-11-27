import { FONT_FAMILIES } from './fonts.js';
import { IMAGE_FILE_ACCEPT } from './images.js';

const el = id => document.getElementById(id);
const shapeNames = {rectangle: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle'};
const ns = 'http://www.w3.org/2000/svg';
let currentState;
let lastLayerItems;
let lastLayerSelection;

function itemIcon(item) {
  return item.type === 'shape' ? item.shape : item.type;
}

function itemName(item) {
  if (item.type === 'shape') return shapeNames[item.shape];
  if (item.type === 'image') return item.name || 'Image';
  return item.text?.trim().split('\n')[0].slice(0, 75) || 'Text';
}

function icon(name) {
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '/everything-assets/icons.svg#' + name);
  svg.append(use);
  return svg;
}

function renderLayers() {
  if (!currentState || el('layers-panel').hidden) return;
  const {items, selectedIds} = currentState;
  const selectionKey = selectedIds.join(',');
  if (lastLayerItems === items && lastLayerSelection === selectionKey) return;
  const selectedSet = new Set(selectedIds);
  const list = el('layer-list');
  const activeId = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const fragment = document.createDocumentFragment();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = item.id;
    button.setAttribute('aria-pressed', String(selectedSet.has(item.id)));
    const name = document.createElement('span');
    name.textContent = itemName(item);
    button.append(icon(itemIcon(item)), name);
    const li = document.createElement('li');
    li.append(button);
    fragment.append(li);
  }
  list.replaceChildren(fragment);
  if (activeId) {
    const focused = Array.from(list.querySelectorAll('button')).find(button => button.dataset.id === activeId);
    focused?.focus({preventScroll: true});
  }
  el('no-layers').hidden = items.length > 0;
  lastLayerItems = items;
  lastLayerSelection = selectionKey;
}

function setShapeButton(shape) {
  const button = el('tool-shape');
  if (shape === button.dataset.tool) return;
  button.dataset.tool = shape;
  button.replaceChildren(icon(shape));
  const label = shapeNames[shape] + ({rectangle: ' (R)', ellipse: ' (O)', triangle: ''}[shape]);
  button.title = label;
  button.setAttribute('aria-label', label);
}

function displayValue(input, value) {
  if (document.activeElement !== input && input.value !== String(value)) input.value = value;
}

export function renderShell(state) {
  currentState = state;
  const {tool, items, selected, selectedItems, selectedIds, zoom} = state;
  if (shapeNames[tool]) setShapeButton(tool);
  for (const button of document.querySelectorAll('button[data-tool]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  }
  el('empty-board').hidden = items.length > 0 || state.busy || !['select', 'hand'].includes(tool);
  el('action-undo').disabled = !state.canUndo;
  el('action-redo').disabled = !state.canRedo;
  el('tool-image').setAttribute('aria-busy', String(state.busy));
  el('zoom-value').textContent = zoom < 0.01 ? '<1%' : Math.round(zoom * 100) + '%';
  const count = selectedItems.length;
  el('inspector').hidden = count === 0;
  el('object-options').hidden = !selected;
  el('layer-copy').hidden = !selected;
  el('layer-copy').disabled = !selected;
  el('type-fields').hidden = selected?.type !== 'text';
  el('fill-field').hidden = !selected || selected.type === 'image';
  el('photo-export').hidden = !state.canExportPhoto;
  el('export-instagram').disabled = !!state.exporting;
  el('export-instagram').setAttribute('aria-busy', String(!!state.exporting));
  el('export-instagram').textContent = state.exporting ? 'Preparing PNG…' : 'Save for Instagram';
  el('export-photo').disabled = !!state.exporting;
  el('export-photo').setAttribute('aria-busy', String(!!state.exporting));
  el('export-photo').textContent = state.exporting ? 'Preparing PNG…' : 'Save photo + overlays';
  if (count) {
    const selectedSet = new Set(selectedIds);
    el('layer-back').disabled = items.slice(0, count).every(item => selectedSet.has(item.id));
    el('layer-front').disabled = items.slice(-count).every(item => selectedSet.has(item.id));
    const deleteLabel = count === 1 ? 'Delete layer' : 'Delete selected layers';
    el('layer-delete').title = deleteLabel;
    el('layer-delete').setAttribute('aria-label', deleteLabel);
  }
  if (count > 1) {
    el('object-heading').textContent = count + ' layers selected';
    el('object-icon').querySelector('use').setAttribute('href', '/everything-assets/icons.svg#layers');
  }
  if (selected) {
    el('object-heading').textContent = selected.type === 'shape' ? itemName(selected) : selected.type === 'image' ? 'Image' : 'Text';
    el('object-icon').querySelector('use').setAttribute('href', '/everything-assets/icons.svg#' + itemIcon(selected));
    displayValue(el('object-width'), Math.round(selected.width * 10) / 10);
    displayValue(el('object-height'), Math.round(selected.height * 10) / 10);
    if (selected.type === 'text') {
      displayValue(el('font-family'), selected.font);
      displayValue(el('font-size'), selected.fontSize);
      el('font-italic').setAttribute('aria-pressed', String(Boolean(selected.italic)));
    }
    if (selected.type !== 'image') {
      displayValue(el('object-color'), selected.color);
      el('hex-value').textContent = selected.color;
    }
  }
  renderLayers();
}

export function bindShell(canvas) {
  const popovers = [['shape-toggle','shape-menu'], ['layers-toggle','layers-panel'], ['help-toggle','help-panel']];
  function showPanel(triggerId, panelId, open) {
    el(panelId).hidden = !open;
    el(triggerId).setAttribute('aria-expanded', String(open));
    if (open && panelId === 'layers-panel') renderLayers();
  }
  function dismiss() {
    for (const [triggerId, panelId] of popovers) showPanel(triggerId, panelId, false);
  }
  for (const [triggerId, panelId] of popovers) {
    el(triggerId).addEventListener('click', () => {
      const open = el(panelId).hidden;
      dismiss();
      showPanel(triggerId, panelId, open);
      if (open && panelId === 'shape-menu') el(panelId).querySelector('button').focus();
    });
  }
  for (const [closeId, trigger, panel] of [['help-close','help-toggle','help-panel'], ['layers-close','layers-toggle','layers-panel']]) {
    el(closeId).addEventListener('click', () => { showPanel(trigger, panel, false); el(trigger).focus(); });
  }
  document.addEventListener('pointerdown', event => {
    if (popovers.some(([trigger, panel]) => el(trigger).contains(event.target) || el(panel).contains(event.target))) return;
    dismiss();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const active = popovers.find(([, panel]) => !el(panel).hidden);
    if (active) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
      el(active[0]).focus();
    }
  }, true);

  for (const button of document.querySelectorAll('button[data-tool]')) {
    button.addEventListener('click', () => { canvas.setTool(button.dataset.tool); el('viewport').focus({preventScroll:true}); });
  }
  for (const button of document.querySelectorAll('button[data-shape]')) {
    button.addEventListener('click', () => {
      canvas.setTool(button.dataset.shape);
      dismiss();
      el('viewport').focus({preventScroll:true});
    });
  }
  el('image-picker').accept = IMAGE_FILE_ACCEPT;
  el('tool-image').addEventListener('click', () => el('image-picker').click());
  el('image-picker').addEventListener('change', event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (files.length) canvas.addFiles(files);
  });
  el('layer-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (button) {
      canvas.select(button.dataset.id, {toggle: event.shiftKey});
      if (matchMedia('(max-width: 620px)').matches) {
        dismiss();
        el('viewport').focus({preventScroll:true});
      }
    }
  });
  for (const [id, action] of Object.entries({
    'clear-selection': () => { canvas.select(null); el('viewport').focus({preventScroll:true}); },
    'layer-copy': () => canvas.copySelected(), 'action-paste': () => canvas.pasteClipboard(),
    'export-photo': () => canvas.exportSelectedPhoto({format: 'original'}),
    'export-instagram': () => canvas.exportSelectedPhoto({format: 'instagram'}),
    'action-undo': () => canvas.undo(), 'action-redo': () => canvas.redo(),
    'layer-back': () => canvas.arrange('back'), 'layer-front': () => canvas.arrange('front'),
    'layer-delete': () => { canvas.remove(); el('viewport').focus({preventScroll:true}); },
    'zoom-in': () => canvas.zoomBy(1.25), 'zoom-out': () => canvas.zoomBy(.8),
    'zoom-fit': () => canvas.zoomToFit(), 'zoom-value': () => canvas.zoomToActual(),
  })) el(id).addEventListener('click', action);

  const select = el('font-family');
  for (const family of FONT_FAMILIES) select.add(new Option(family, family));
  select.addEventListener('change', () => canvas.updateSelected({font: select.value}));
  el('font-italic').addEventListener('click', () => {
    if (currentState?.selected?.type === 'text') {
      canvas.updateSelected({italic: !currentState.selected.italic});
    }
  });
  const color = el('object-color');
  let colorEdit;
  function updateColor() {
    const id = currentState?.selected?.id;
    if (!id) { colorEdit = undefined; return; }
    if (colorEdit?.id !== id) colorEdit = {id, historyGroup: {}};
    canvas.updateSelected({color: color.value}, {historyGroup: colorEdit.historyGroup});
  }
  // Native pickers emit input while adjusting, then change when dismissed.
  // Publish live colors while retaining one undo step for the picker interaction.
  color.addEventListener('input', updateColor);
  color.addEventListener('change', () => { updateColor(); colorEdit = undefined; });
  color.addEventListener('pointerdown', () => { colorEdit = undefined; });
  color.addEventListener('blur', () => { colorEdit = undefined; });
  color.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.code === 'Space') colorEdit = undefined;
  });
  for (const [id,key] of [['object-width','width'], ['object-height','height'], ['font-size','fontSize']]) {
    const input = el(id);
    input.addEventListener('change', () => {
      const value = input.valueAsNumber;
      if (Number.isFinite(value) && value > 0) canvas.updateSelected({[key]: value});
      if (currentState?.selected) input.value = Math.round(currentState.selected[key] * 10) / 10;
    });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
  }
}
