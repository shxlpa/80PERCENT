const SNAP_PIXELS = 6
const POSITION_LIMIT = 1e9
const SIZE_LIMIT = 1e7
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const tolerance = zoom => SNAP_PIXELS / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
const start = (item, axis) => axis === 'x' ? item.x : item.y
const size = (item, axis) => axis === 'x' ? item.width : item.height
const end = (item, axis) => start(item, axis) + size(item, axis)
const middle = (item, axis) => start(item, axis) + size(item, axis) / 2
const perpendicular = axis => axis === 'x' ? 'y' : 'x'

function valid(item) {
  return item && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key])) &&
    Math.abs(item.x) <= POSITION_LIMIT && Math.abs(item.y) <= POSITION_LIMIT &&
    item.width >= .01 && item.height >= .01 && item.width <= SIZE_LIMIT && item.height <= SIZE_LIMIT
}

function bounds(items) {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const item of items) {
    x = Math.min(x, item.x)
    y = Math.min(y, item.y)
    right = Math.max(right, item.x + item.width)
    bottom = Math.max(bottom, item.y + item.height)
  }
  return {x, y, width: right - x, height: bottom - y}
}

function gap(a, b, axis) {
  return Math.max(0, start(a, axis) - end(b, axis), start(b, axis) - end(a, axis))
}

function nearby(a, b, axis, threshold) {
  const cross = perpendicular(axis)
  return gap(a, b, cross) <= Math.max(threshold * 20, Math.min(size(a, cross), size(b, cross)) / 2)
}

function guide(axis, value, a, b, label) {
  const cross = perpendicular(axis)
  return {axis, value, from: Math.min(start(a, cross), start(b, cross)),
    to: Math.max(end(a, cross), end(b, cross)), ...(label ? {label} : {})}
}

function containsCenter(image, text) {
  return ['x', 'y'].every(axis => middle(text, axis) >= start(image, axis) && middle(text, axis) <= end(image, axis))
}

function anchors(item, axis) {
  return [start(item, axis), middle(item, axis), end(item, axis)]
}

function best(candidates) {
  return candidates.reduce((chosen, candidate) => !chosen || candidate.priority > chosen.priority ||
    (candidate.priority === chosen.priority && Math.abs(candidate.delta) < Math.abs(chosen.delta))
    ? candidate : chosen, null)
}

// Match placement within nearby images, even when the images have different sizes.
// Limit reference images before looking for their text, keeping large boards cheap.
function contextualText(text, targets, threshold, add) {
  const images = targets.filter(item => item.type === 'image')
  const host = images.filter(image => containsCenter(image, text))
    .reduce((chosen, image) => !chosen || image.width * image.height < chosen.width * chosen.height ? image : chosen, null)
  if (!host) return
  const neighbors = images.filter(image => image !== host && ['x', 'y'].some(axis => {
    const cross = perpendicular(axis)
    const separate = end(image, axis) <= start(host, axis) + threshold ||
      start(image, axis) >= end(host, axis) - threshold
    const aligned = anchors(image, cross).some((value, i) => Math.abs(value - anchors(host, cross)[i]) <= threshold)
    return separate && aligned && gap(image, host, axis) <=
      Math.max(threshold * 20, Math.min(size(image, axis), size(host, axis)) / 2)
  })).sort((a, b) => Math.hypot(middle(a, 'x') - middle(host, 'x'), middle(a, 'y') - middle(host, 'y')) -
    Math.hypot(middle(b, 'x') - middle(host, 'x'), middle(b, 'y') - middle(host, 'y'))).slice(0, 4)
  for (const reference of targets) {
    if (reference.type !== 'text') continue
    for (const neighbor of neighbors) {
      if (!containsCenter(neighbor, reference)) continue
      for (const axis of ['x', 'y']) {
        const ownAnchors = anchors(text, axis)
        anchors(reference, axis).forEach((value, i) => {
          const projected = start(host, axis) + (value - start(neighbor, axis)) / size(neighbor, axis) * size(host, axis)
          add(axis, projected - ownAnchors[i], guide(axis, projected, text, host, 'Match text placement'), 1)
        })
      }
    }
  }
}

// `moving` already contains the raw pointer translation. Return only a correction.
export function snapMove(moving, targets, zoom) {
  if (!moving.length || !moving.every(valid)) return {dx: 0, dy: 0, guides: []}
  const ids = new Set(moving.map(item => item.id))
  targets = targets.filter(item => valid(item) && !ids.has(item.id))
  const area = bounds(moving), threshold = tolerance(zoom)
  const candidates = {x: [], y: []}
  const limits = {x: [-Infinity, Infinity], y: [-Infinity, Infinity]}
  for (const item of moving) {
    for (const axis of ['x', 'y']) {
      limits[axis][0] = Math.max(limits[axis][0], -POSITION_LIMIT - start(item, axis))
      limits[axis][1] = Math.min(limits[axis][1], POSITION_LIMIT - start(item, axis))
    }
  }
  const add = (axis, delta, line, priority = 0) => {
    if (Math.abs(delta) <= threshold + 1e-9 && delta >= limits[axis][0] && delta <= limits[axis][1]) {
      candidates[axis].push({delta, guide: line, priority})
    }
  }
  const text = moving.length === 1 && moving[0].type === 'text' ? moving[0] : null
  const imagesOnly = moving.every(item => item.type === 'image')
  for (const target of targets) {
    const priority = imagesOnly && target.type === 'image' ? 1 : 0
    for (const axis of ['x', 'y']) {
      if (!nearby(area, target, axis, threshold)) continue
      for (const own of [start(area, axis), end(area, axis)]) {
        for (const value of [start(target, axis), end(target, axis)]) {
          add(axis, value - own, guide(axis, value, area, target), priority)
        }
      }
      const value = middle(target, axis)
      const container = text && target.type === 'image' && containsCenter(target, text)
      add(axis, value - middle(area, axis), guide(axis, value, area, target, container ? 'Center' : undefined), container ? 2 : priority)
    }
  }
  if (text) contextualText(text, targets, threshold, add)
  const x = best(candidates.x), y = best(candidates.y)
  return {dx: x?.delta || 0, dy: y?.delta || 0, guides: [x?.guide, y?.guide].filter(Boolean)}
}

// The opposite corner stays fixed. A ratio-constrained resize chooses one snap
// axis and derives the other dimension; free resizes can snap both independently.
export function snapResize(original, candidate, handle, targets, zoom, preserveRatio = original?.type === 'image') {
  if (!valid(candidate) || !valid(original)) {
    const source = valid(original) ? original : candidate || {}
    const item = {...source}
    for (const key of ['x', 'y', 'width', 'height']) {
      const position = key === 'x' || key === 'y'
      item[key] = clamp(Number.isFinite(source[key]) ? source[key] : position ? 0 : 1,
        position ? -POSITION_LIMIT : .01, position ? POSITION_LIMIT : SIZE_LIMIT)
    }
    return {item, guides: []}
  }
  const west = handle.includes('w'), north = handle.includes('n')
  const fixed = {x: west ? end(original, 'x') : original.x, y: north ? end(original, 'y') : original.y}
  const sign = {x: west ? -1 : 1, y: north ? -1 : 1}
  const threshold = tolerance(zoom), ratio = original.width / original.height
  const candidates = {x: [], y: []}
  const makeItem = (width, height) => ({...candidate, width, height,
    x: west ? fixed.x - width : fixed.x, y: north ? fixed.y - height : fixed.y})
  function add(axis, dimension, target, label) {
    if (!Number.isFinite(dimension) || dimension < .01) return
    const delta = dimension - size(candidate, axis)
    if (Math.abs(delta) > threshold + 1e-9) return
    let width = axis === 'x' ? dimension : candidate.width
    let height = axis === 'y' ? dimension : candidate.height
    if (preserveRatio) {
      if (axis === 'x') height = width / ratio
      else width = height * ratio
      // A nearby height on a panorama can imply a large horizontal jump.
      if (Math.max(Math.abs(width - candidate.width), Math.abs(height - candidate.height)) > threshold + 1e-9) return
    }
    const item = makeItem(width, height)
    if (!valid(item)) return
    const value = fixed[axis] + sign[axis] * dimension
    const aligned = [start(target, axis), end(target, axis)].some(edge => Math.abs(edge - value) < 1e-6)
    const cross = perpendicular(axis)
    // Images beside one another should share a height; stacked images a width.
    const facingSpan = label && end(candidate, axis) > start(target, axis) && end(target, axis) > start(candidate, axis) &&
      (end(candidate, cross) <= start(target, cross) + threshold || end(target, cross) <= start(candidate, cross) + threshold)
    const priority = (original.type === 'image' && target.type === 'image' ? 1 : 0) + (facingSpan ? 1 : 0)
    candidates[axis].push({delta, item, priority, equalSize: Boolean(label),
      guide: guide(axis, value, item, label && !aligned ? item : target, label)})
  }
  for (const target of targets) {
    if (!valid(target) || target.id === original.id) continue
    for (const axis of ['x', 'y']) {
      if (!nearby(candidate, target, axis, threshold)) continue
      for (const value of [start(target, axis), end(target, axis)]) add(axis, (value - fixed[axis]) * sign[axis], target)
      if (original.type === 'image' && target.type === 'image') {
        add(axis, size(target, axis), target, axis === 'y' ? 'Match height' : 'Match width')
      }
    }
  }
  const closest = list => list.reduce((chosen, next) => !chosen || next.priority > chosen.priority ||
    (next.priority === chosen.priority && (Math.abs(next.delta) < Math.abs(chosen.delta) - 1e-9 ||
      (Math.abs(Math.abs(next.delta) - Math.abs(chosen.delta)) <= 1e-9 && next.equalSize && !chosen.equalSize))) ? next : chosen, null)
  if (preserveRatio) {
    const chosen = closest([...candidates.y, ...candidates.x])
    return chosen ? {item: chosen.item, guides: [chosen.guide]} : {item: candidate, guides: []}
  }
  const x = closest(candidates.x), y = closest(candidates.y)
  const item = makeItem(x?.item.width ?? candidate.width, y?.item.height ?? candidate.height)
  return valid(item) ? {item, guides: [x?.guide, y?.guide].filter(Boolean)} : {item: candidate, guides: []}
}
