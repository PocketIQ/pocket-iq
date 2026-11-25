// The photo's pixels, at most maxSide px on the long side: enough for the detector (which
// sees each half of the table at 1024 px), without filling an older phone's memory.
export async function photoPixels(file: File, maxSide = 3000): Promise<ImageData> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('Couldn’t open that photo. Try a JPEG or PNG.')
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('This phone is out of memory for photos. Close other apps and try again.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.height = 0 // free it now: phones keep canvases around
  return pixels
}
