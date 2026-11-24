import { validItem } from './layers.js'

const LAYER_TYPE = 'application/x-everything-layer+json'
const LAYER_ATTRIBUTE = 'data-everything-layer-v1'
const MAX_CLIPBOARD_LENGTH = 4_000_000

function serialize(item) {
  const json = JSON.stringify(item)
  const text = item.type === 'text' ? item.text : item.type === 'image' ? item.name : item.shape
  // HTML also carries the layer through browsers that only keep standard clipboard types.
  const span = document.createElement('span')
  span.setAttribute(LAYER_ATTRIBUTE, json)
  span.textContent = text
  return {json, html: span.outerHTML, text}
}

export function parseLayer(json) {
  if (!json || json.length > MAX_CLIPBOARD_LENGTH) return null
  try {
    const item = JSON.parse(json)
    if (!validItem(item)) return null
    const {id, type, x, y, width, height} = item
    const base = {id, type, x, y, width, height}
    if (type === 'image') return {...base, name: item.name, imageId: item.imageId}
    if (type === 'shape') return {...base, shape: item.shape, color: item.color}
    return {...base, text: item.text, color: item.color, font: item.font, fontSize: item.fontSize}
  } catch {
    return null
  }
}

function parseLayerHTML(html) {
  if (!html || html.length > MAX_CLIPBOARD_LENGTH || !html.includes(LAYER_ATTRIBUTE)) return null
  const template = document.createElement('template')
  template.innerHTML = html
  return parseLayer(template.content.querySelector('span[' + LAYER_ATTRIBUTE + ']')?.getAttribute(LAYER_ATTRIBUTE))
}

export function copyLayerToEvent(item, transfer) {
  const data = serialize(item)
  transfer.setData('text/plain', data.text)
  transfer.setData('text/html', data.html)
  try { transfer.setData(LAYER_TYPE, data.json) } catch { /* Standard types are already set. */ }
}

export function readLayerFromEvent(transfer) {
  return parseLayer(transfer.getData(LAYER_TYPE)) || parseLayerHTML(transfer.getData('text/html'))
}

export function writeSystemLayer(item) {
  const {html, text} = serialize(item)
  return navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([text], {type: 'text/plain'}),
    'text/html': new Blob([html], {type: 'text/html'}),
  })])
}

export async function readSystemClipboard() {
  const entries = await navigator.clipboard.read()
  let text = ''
  const files = []
  for (const entry of entries) {
    if (entry.types.includes('text/html')) {
      const blob = await entry.getType('text/html')
      if (blob.size <= MAX_CLIPBOARD_LENGTH) {
        const layer = parseLayerHTML(await blob.text())
        if (layer) return {layer}
      }
    }
    const imageType = entry.types.find(type => type.startsWith('image/'))
    if (imageType) files.push(await entry.getType(imageType))
    else if (!text && entry.types.includes('text/plain')) text = await (await entry.getType('text/plain')).text()
  }
  return {files, text}
}
