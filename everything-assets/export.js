const MAX_EDGE = 32767
const MAX_PIXELS = 64 * 1024 * 1024
const tooLarge = () => new Error('This photo is too large to export at full resolution in this browser. Its saved image has not been changed.')
const validBox = item => item && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key])) && item.width > 0 && item.height > 0

function checkFormat(format) {
  if (!['original', 'instagram'].includes(format)) throw new Error('Choose an Original or Instagram export format.')
}

function checkSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) throw tooLarge()
}

export function planPhotoExport(photo, items) {
  const index = items.findIndex(item => item.id === photo?.id)
  const source = items[index]
  if (index < 0 || source.type !== 'image' || !validBox(source)) throw new Error('Select a photo to export.')
  const overlaps = item => validBox(item) &&
    Math.max(source.x, item.x) < Math.min(source.x + source.width, item.x + item.width) &&
    Math.max(source.y, item.y) < Math.min(source.y + source.height, item.y + item.height)
  return {photo: source, layers: [source, ...items.slice(index + 1).filter(overlaps)]}
}

export function photoExportDimensions(photo, sourceWidth, sourceHeight) {
  if (!validBox(photo) || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('The saved photo dimensions could not be read.')
  }
  // Keep the displayed composition's proportions without shrinking either source axis.
  const scale = Math.max(sourceWidth / photo.width, sourceHeight / photo.height)
  const width = Math.round(photo.width * scale), height = Math.round(photo.height * scale)
  checkSize(width, height)
  return {width, height, scale}
}

export function photoExportFrame(contentWidth, contentHeight, format = 'original') {
  checkFormat(format)
  checkSize(contentWidth, contentHeight)
  const unit = Math.ceil(Math.max(contentWidth / 3, contentHeight / 4))
  const width = format === 'instagram' ? unit * 3 : contentWidth
  const height = format === 'instagram' ? unit * 4 : contentHeight
  checkSize(width, height)
  // Keep source pixels on integer coordinates; odd padding differs by one pixel.
  return {width, height, left: Math.floor((width - contentWidth) / 2), top: Math.floor((height - contentHeight) / 2)}
}

function exportName(name, format) {
  const stem = (name || 'Photo').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 150) || 'Photo'
  return stem + (format === 'instagram' ? '-instagram-3x4.png' : '-with-overlays.png')
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const source = await createImageBitmap(blob)
      return {source, width: source.width, height: source.height, dispose: () => source.close()}
    } catch { /* Some image formats are supported by Image but not ImageBitmap. */ }
  }
  const url = URL.createObjectURL(blob)
  const source = new Image()
  try {
    source.src = url
    await source.decode()
    return {source, width: source.naturalWidth, height: source.naturalHeight,
      dispose() { source.removeAttribute('src'); URL.revokeObjectURL(url) }}
  } catch {
    URL.revokeObjectURL(url)
    throw new Error('A saved image could not be decoded for export.')
  }
}

function fontFor(item) {
  return (item.italic ? 'italic ' : 'normal ') + item.fontSize + 'px ' + JSON.stringify(item.font) + ', sans-serif'
}

function textStyles(element, item) {
  Object.assign(element.style, {
    display: 'block', position: 'relative', margin: '0', padding: '0', border: '0',
    boxSizing: 'content-box', width: item.width + 'px', height: 'auto',
    font: fontFor(item), lineHeight: '1.22', textAlign: 'left', whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', wordBreak: 'normal', letterSpacing: 'normal',
    textTransform: 'none', tabSize: '4', direction: 'ltr',
  })
}

// Let the browser perform the same wrapping as .ec-text. Canvas then paints each
// visual line at its measured position, with tabs split into positioned runs.
function drawText(context, item, photo, measurements) {
  if (!item.text) return
  const layout = document.createElement('div')
  const probe = document.createElement('div')
  textStyles(layout, item)
  textStyles(probe, item)
  const text = document.createTextNode(item.text)
  const probeText = document.createTextNode('M')
  const baseline = document.createElement('span')
  Object.assign(baseline.style, {display: 'inline-block', width: '0', height: '0', margin: '0', padding: '0', border: '0', verticalAlign: 'baseline'})
  layout.append(text)
  probe.append(probeText, baseline)
  measurements.append(layout, probe)
  const range = document.createRange()
  try {
    range.selectNodeContents(probeText)
    const baselineOffset = baseline.getBoundingClientRect().top - range.getBoundingClientRect().top
    const origin = layout.getBoundingClientRect()
    const visibleBottom = Math.min(item.height, photo.y + photo.height - item.y)
    context.save()
    context.beginPath()
    context.rect(item.x, item.y, item.width, item.height)
    context.clip()
    context.font = fontFor(item)
    context.fillStyle = item.color
    context.textAlign = 'left'
    context.textBaseline = 'alphabetic'
    context.direction = 'ltr'
    context.fontKerning = 'normal'
    let run = null
    const flush = () => {
      if (run) context.fillText(run.text, item.x + run.left - origin.left, item.y + run.top - origin.top + baselineOffset)
      run = null
    }
    const segments = typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(item.text)
      : Array.from(item.text, segment => ({segment}))
    let index = 0
    for (const {segment} of segments) {
      const next = index + segment.length
      range.setStart(text, index)
      range.setEnd(text, next)
      index = next
      if (/[\t\r\n]/.test(segment)) { flush(); continue }
      const rect = range.getBoundingClientRect()
      if (rect.top - origin.top > visibleBottom) break
      if (!rect.height) continue
      if (run && Math.abs(rect.top - run.top) > .1) flush()
      if (!run) run = {text: segment, left: rect.left, top: rect.top}
      else { run.text += segment; run.left = Math.min(run.left, rect.left) }
    }
    flush()
    context.restore()
  } finally {
    range.detach?.()
    layout.remove()
    probe.remove()
  }
}

function drawShape(context, item) {
  context.fillStyle = item.color
  context.beginPath()
  if (item.shape === 'ellipse') context.ellipse(item.x + item.width / 2, item.y + item.height / 2, item.width / 2, item.height / 2, 0, 0, Math.PI * 2)
  else if (item.shape === 'triangle') {
    context.moveTo(item.x + item.width / 2, item.y)
    context.lineTo(item.x + item.width, item.y + item.height)
    context.lineTo(item.x, item.y + item.height)
    context.closePath()
  } else context.rect(item.x, item.y, item.width, item.height)
  context.fill()
}

export async function exportPhoto({photo, items, loadImage, format = 'original'}) {
  checkFormat(format)
  const plan = planPhotoExport(photo, items)
  photo = plan.photo
  const sources = new Map()
  let canvas, measurements
  try {
    const base = await decodeImage(await loadImage(photo.imageId))
    sources.set(photo.imageId, base)
    const content = photoExportDimensions(photo, base.width, base.height)
    const {width, height, left, top} = photoExportFrame(content.width, content.height, format)
    const imageIds = [...new Set(plan.layers.filter(item => item.type === 'image').map(item => item.imageId))]
    const loads = imageIds.filter(id => !sources.has(id)).map(async id => {
      sources.set(id, await decodeImage(await loadImage(id)))
    })
    for (const item of plan.layers) {
      if (item.type === 'text') loads.push(document.fonts.load(fontFor(item), item.text || 'M'))
    }
    // Wait for every load before cleanup, including when one resource fails.
    const results = await Promise.allSettled(loads)
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw tooLarge()
    // Some browsers retain requested dimensions even when backing allocation fails.
    context.fillStyle = '#010203'
    context.fillRect(width - 1, height - 1, 1, 1)
    if (context.getImageData(width - 1, height - 1, 1, 1).data[3] !== 255) throw tooLarge()
    context.clearRect(0, 0, width, height)
    if (format === 'instagram') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    // The axes differ only by final integer-pixel rounding, keeping the canvas filled.
    context.setTransform(content.width / photo.width, 0, 0, content.height / photo.height, left, top)
    context.beginPath()
    context.rect(0, 0, photo.width, photo.height)
    context.clip()
    measurements = document.createElement('div')
    measurements.setAttribute('aria-hidden', 'true')
    Object.assign(measurements.style, {position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none', zIndex: '-1'})
    document.body.append(measurements)
    const localPhoto = {...photo, x: 0, y: 0}
    for (const layer of plan.layers) {
      // Rebase before rendering so extreme board coordinates retain their precision.
      const item = {...layer, x: layer.x - photo.x, y: layer.y - photo.y}
      if (item.type === 'image') context.drawImage(sources.get(item.imageId).source, item.x, item.y, item.width, item.height)
      else if (item.type === 'shape') drawShape(context, item)
      else if (item.type === 'text') drawText(context, item, localPhoto, measurements)
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob || blob.type !== 'image/png') throw tooLarge()
    return {blob, width, height, filename: exportName(photo.name, format)}
  } finally {
    measurements?.remove()
    if (canvas) canvas.width = canvas.height = 1
    for (const source of sources.values()) source.dispose()
  }
}
