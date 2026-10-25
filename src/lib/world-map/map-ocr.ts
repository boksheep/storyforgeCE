import { readMapImage } from './map-data'
import type { MapVisionRegion } from './map-tiles'
import { cropForVision } from './map-vision'

/** Local-only OCR. The caller reviews text; no OCR output becomes a map fact here. */
export async function recognizeMapText(input: {
  projectId: number; assetKey: string; region: MapVisionRegion; signal?: AbortSignal
}): Promise<string> {
  if (input.signal?.aborted) throw new Error('地图识字已取消')
  const { createWorker, OEM } = await import('tesseract.js')
  const localAssets = `${import.meta.env.BASE_URL}map-ocr/`
  const image = await cropForVision(await readMapImage(input.projectId, input.assetKey), input.region, 3000)
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  const onAbort = () => { void worker?.terminate() }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    worker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      workerPath: `${localAssets}worker.min.js`, corePath: localAssets,
      langPath: localAssets, gzip: false, workerBlobURL: false,
    })
    if (input.signal?.aborted) throw new Error('地图识字已取消')
    const result = await worker.recognize(image)
    if (input.signal?.aborted) throw new Error('地图识字已取消')
    return result.data.text.trim().slice(0, 12_000)
  } catch (error) {
    if (input.signal?.aborted) throw new Error('地图识字已取消')
    throw error
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    if (worker) await worker.terminate().catch(() => undefined)
  }
}
