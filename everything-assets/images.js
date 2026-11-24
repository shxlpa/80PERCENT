const MAX_UPLOAD_BYTES = 4_000_000
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
}
const supportedTypes = new Set([...Object.values(MIME_BY_EXTENSION), 'image/vnd.microsoft.icon'])

export async function prepareImage(file) {
  const extension = file.name?.split('.').pop().toLowerCase()
  const type = file.type || MIME_BY_EXTENSION[extension]
  if (!supportedTypes.has(type)) {
    throw new Error('Choose a PNG, JPEG, WebP, GIF, AVIF, BMP, or ICO image.')
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    try {
      await image.decode()
    } catch {
      throw new Error('This browser could not open the image.')
    }

    const {naturalWidth: width, naturalHeight: height} = image
    if (file.size <= MAX_UPLOAD_BYTES) {
      return {file: file.type ? file : file.slice(0, file.size, type), width, height}
    }
    // Preserve animation and transparency when an oversized file cannot be uploaded as-is.
    if (type === 'image/gif' || await hasAnimation(file, type)) {
      throw new Error('Animated images must be 4 MB or smaller.')
    }
    const canvas = document.createElement('canvas')
    let scale = Math.min(1, 3200 / Math.max(width, height))
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .88))
      if (blob && blob.size <= MAX_UPLOAD_BYTES) return {file: blob, width, height}
      scale *= .7
    }
    throw new Error('This image could not be reduced below 4 MB.')
  } finally {
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
