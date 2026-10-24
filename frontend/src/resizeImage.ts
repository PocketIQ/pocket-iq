// The far corner markers are tiny in the photo, and every pixel counts for reading them.
// So we keep phone photos at (almost) full resolution: 4096px covers a 12MP phone's
// native 4032px, meaning no downscaling at all on most phones. JPEG 0.9 keeps the
// marker edges sharp. Uploads are ~2-3 MB; slower, but missed markers are worse.
export async function resizeImage(file: File, maxSide = 4096, quality = 0.9): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Image compression failed'))), 'image/jpeg', quality),
  )
}
