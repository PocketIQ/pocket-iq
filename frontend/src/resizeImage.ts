// Phone photos are 3-5 MB at ~4000px. We shrink before upload for speed, but NOT too
// far: the corner markers are small, and the far ones need ~24+ pixels across to be
// detected. 3000px at 85% JPEG is ~0.8-1.2 MB and keeps 5 cm markers readable.
// If far markers keep going undetected, raise maxSide (up to the phone's native size).
export async function resizeImage(file: File, maxSide = 3000, quality = 0.85): Promise<Blob> {
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
