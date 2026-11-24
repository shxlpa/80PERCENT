// A fresh worker for each conversion releases the decoder's large heap after use.
import buildLibheif from './vendor/heif/libheif.js'

function reportFailure() {
  self.postMessage({error: 'This HEIC or HEIF photo could not be decoded.'})
}

// Surface asynchronous decoder failures as well as errors from the message handler.
self.addEventListener('unhandledrejection', event => {
  event.preventDefault()
  reportFailure()
})

self.onmessage = async ({data: file}) => {
  try {
    const lib = buildLibheif()
    const decoder = new lib.HeifDecoder()
    const frames = decoder.decode(await file.arrayBuffer())
    const frame = frames.find(image => image.is_primary()) || frames[0]
    if (!frame) throw new Error()
    const width = frame.get_width()
    const height = frame.get_height()
    const pixels = await new Promise((resolve, reject) => {
      frame.display(new ImageData(width, height), decoded => decoded ? resolve(decoded) : reject())
    })
    // Transfer the backing store directly. The owner can encode a smaller rendition.
    self.postMessage({width, height, pixels: pixels.data.buffer}, [pixels.data.buffer])
  } catch {
    reportFailure()
  }
}
