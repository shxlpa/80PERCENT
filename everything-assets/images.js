const MAX_UPLOAD_BYTES = 4_000_000
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif',
}
const heifTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])
const supportedTypes = new Set([...Object.values(MIME_BY_EXTENSION), ...heifTypes, 'image/vnd.microsoft.icon'])
export const IMAGE_FILE_ACCEPT = [
  ...Object.keys(MIME_BY_EXTENSION).map(extension => '.' + extension), ...supportedTypes,
].join(',')

async function imageType(file) {
  const mime = file.type.split(';', 1)[0].trim().toLowerCase()
  const extension = file.name?.split('.').pop().toLowerCase()
  const byName = Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : undefined
  if (heifTypes.has(byName)) return byName
  if (supportedTypes.has(mime)) return mime
  if (byName) return byName
  // Some clipboard providers supply a generic name and no media type.
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer())
  if (String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') return
  const endsAt = Math.min(header.length, new DataView(header.buffer).getUint32(0) || header.length)
  const brands = []
  for (let offset = 8; offset + 4 <= endsAt; offset += 4) {
    if (offset !== 12) brands.push(String.fromCharCode(...header.slice(offset, offset + 4)))
  }
  if (brands.some(brand => ['avif', 'avis'].includes(brand))) return 'image/avif'
  if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) return 'image/heif'
}

function decodeHeif(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heif-worker.js', import.meta.url), {type: 'module'})
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('The HEIC decoder could not open the photo.'))
    }
    worker.onmessage = async ({data}) => {
      worker.terminate()
      if (data.error) { reject(new Error(data.error)); return }
      try {
        const pixels = new ImageData(new Uint8ClampedArray(data.pixels), data.width, data.height)
        const bitmap = await createImageBitmap(pixels)
        resolve(bitmap)
      } catch {
        reject(new Error('The decoded photo is too large for this browser.'))
      }
    }
    worker.postMessage(file)
  })
}

async function encodeStill(image, width, height) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let scale = Math.min(1, 3200 / Math.max(width, height))
  let format = 'image/webp'
  const encode = () => new Promise(resolve => canvas.toBlob(resolve, format, .88))
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      let blob = await encode()
      // WebKit may return lossless PNG for a WebP request. Keep full-size opaque
      // photos by switching to JPEG, and keep alpha on transparent artwork.
      if (format === 'image/webp' && blob?.type === 'image/png' && blob.size > MAX_UPLOAD_BYTES) {
        const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height)
        format = 'image/jpeg'
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 255) { format = 'image/png'; break }
        }
        if (format === 'image/jpeg') blob = await encode()
      }
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return {file: blob, width, height}
      scale *= .7
    }
    throw new Error('This image could not be reduced below 4 MB.')
  } finally {
    canvas.width = canvas.height = 1
  }
}

export async function prepareImage(file) {
  const type = await imageType(file)
  if (!type) throw new Error('Choose a HEIC, HEIF, PNG, JPEG, WebP, GIF, AVIF, BMP, or ICO image.')
  const input = file.type === type ? file : file.slice(0, file.size, type)
  const url = URL.createObjectURL(input)
  const isHeif = heifTypes.has(type)
  let bitmap
  try {
    const image = new Image()
    image.src = url
    try {
      await image.decode()
    } catch {
      if (!isHeif) throw new Error('This browser could not open the image.')
      bitmap = await decodeHeif(input)
    }
    const width = bitmap?.width || image.naturalWidth
    const height = bitmap?.height || image.naturalHeight
    if (!isHeif && file.size <= MAX_UPLOAD_BYTES) return {file: input, width, height}
    if (!isHeif && (type === 'image/gif' || await hasAnimation(file, type))) {
      throw new Error('Animated images must be 4 MB or smaller.')
    }
    // Every device can display the stored rendition, including devices without HEIC codecs.
    return await encodeStill(bitmap || image, width, height)
  } finally {
    bitmap?.close()
    URL.revokeObjectURL(url)
  }
}

async function hasAnimation(file, type) {
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const header = String.fromCharCode(...bytes)
  return (type === 'image/png' && header.includes('acTL')) ||
    (type === 'image/webp' && header.includes('ANIM')) ||
    (type === 'image/avif' && header.includes('avis'))
}
