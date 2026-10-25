import { encodeMapBlob } from '../export/map-blob-codec'
import type { MapAsset } from '../types'
import { scoreMapImageBitmapRegion } from './map-adaptive'
import { readMapImage } from './map-data'
import type { MapVisionRegion } from './map-tiles'

export interface MapCropOptions {
  maxScale?: number
  quality?: number
}

const MAX_CACHED_CROPS = 8
const MAX_CACHED_CHARS = 8_000_000

/** One scan owns one source blob. The bitmap is released during the confirmation dialog. */
export class MapImageSession {
  private bitmap: ImageBitmap | null = null
  private opening: Promise<ImageBitmap> | null = null
  private decodeFailure: unknown = null
  private closed = false
  private encoded = new Map<string, string>()
  private encodedChars = 0

  constructor(private readonly source: Blob, readonly asset?: MapAsset) {}

  private async getBitmap(): Promise<ImageBitmap> {
    if (this.closed) throw new Error('地图图片会话已关闭')
    if (this.bitmap) return this.bitmap
    if (this.decodeFailure) throw this.decodeFailure
    if (!this.opening) {
      this.opening = createImageBitmap(this.source).then(bitmap => {
        if (this.closed) { bitmap.close(); throw new Error('地图图片会话已关闭') }
        this.bitmap = bitmap
        return bitmap
      }).catch(error => {
        if (!this.closed) this.decodeFailure = error
        throw error
      }).finally(() => { this.opening = null })
    }
    return this.opening
  }

  assertAsset(asset: MapAsset): void {
    if (!this.asset || this.asset.projectId !== asset.projectId
      || this.asset.worldNodeId !== asset.worldNodeId
      || this.asset.assetKey !== asset.assetKey || this.asset.sha256 !== asset.sha256) {
      throw new Error('地图图片会话与当前原图不匹配')
    }
  }

  async score(region: MapVisionRegion): Promise<number> {
    return scoreMapImageBitmapRegion(await this.getBitmap(), region)
  }

  async crop(region: MapVisionRegion, maxDimension = 1600, options: MapCropOptions = {}): Promise<Blob> {
    let bitmap: ImageBitmap
    let croppedSource = false
    try { bitmap = await this.getBitmap() }
    catch (error) {
      if (this.closed || !this.asset) throw error
      // A full-size bitmap can exceed memory even when a single scan tile fits.
      const x = Math.floor(region.x * this.asset.width)
      const y = Math.floor(region.y * this.asset.height)
      const width = Math.max(1, Math.floor(region.width * this.asset.width))
      const height = Math.max(1, Math.floor(region.height * this.asset.height))
      bitmap = await createImageBitmap(this.source, x, y, width, height)
      croppedSource = true
    }
    try {
      const maxScale = Math.max(1, options.maxScale ?? 1)
      const quality = options.quality ?? 0.84
      const sourceX = croppedSource ? 0 : Math.floor(region.x * bitmap.width)
      const sourceY = croppedSource ? 0 : Math.floor(region.y * bitmap.height)
      const sourceWidth = croppedSource ? bitmap.width : Math.max(1, Math.floor(region.width * bitmap.width))
      const sourceHeight = croppedSource ? bitmap.height : Math.max(1, Math.floor(region.height * bitmap.height))
      const scale = Math.min(maxScale, maxDimension / Math.max(sourceWidth, sourceHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法裁剪地图图片')
      if (scale > 1) {
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
      }
      context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight,
        0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result
        ? resolve(result) : reject(new Error('图片转换失败')), 'image/jpeg', quality))
    } finally { if (croppedSource) bitmap.close() }
  }

  /** Repeated missions and feature pages can send the same encoded pixels. */
  async encodedCrop(region: MapVisionRegion, maxDimension = 1600, options: MapCropOptions = {}): Promise<string> {
    if (this.closed) throw new Error('地图图片会话已关闭')
    const key = JSON.stringify([region.x, region.y, region.width, region.height,
      maxDimension, options.maxScale ?? 1, options.quality ?? 0.84])
    const cached = this.encoded.get(key)
    if (cached != null) {
      this.encoded.delete(key)
      this.encoded.set(key, cached)
      return cached
    }
    const value = await encodeMapBlob(await this.crop(region, maxDimension, options))
    if (!this.closed && value.length <= MAX_CACHED_CHARS) {
      this.encoded.set(key, value)
      this.encodedChars += value.length
      while (this.encoded.size > MAX_CACHED_CROPS || this.encodedChars > MAX_CACHED_CHARS) {
        const oldest = this.encoded.keys().next().value
        if (oldest == null) break
        this.encodedChars -= this.encoded.get(oldest)!.length
        this.encoded.delete(oldest)
      }
    }
    return value
  }

  /** Frees the decoded pixels while the author considers the request confirmation. */
  async releaseBitmap(): Promise<void> {
    await this.opening?.catch(() => undefined)
    this.bitmap?.close()
    this.bitmap = null
  }

  close(): void {
    this.closed = true
    this.bitmap?.close()
    this.bitmap = null
    this.encoded.clear()
    this.encodedChars = 0
  }
}

export async function openMapImageSession(projectId: number, asset: MapAsset): Promise<MapImageSession> {
  if (asset.projectId !== projectId) throw new Error('地图原图不属于当前项目')
  return new MapImageSession(await readMapImage(projectId, asset.assetKey), asset)
}
