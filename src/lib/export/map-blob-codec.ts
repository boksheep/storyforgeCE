/** Portable JSON codec for WORLD-1 images. The field is explicit so missing bytes fail import. */
export async function encodeMapBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return encodeMapBytes(bytes)
}

export function encodeMapBytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
  }
  return btoa(chunks.join(''))
}

export function decodeMapBytes(base64: unknown): Uint8Array {
  if (typeof base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('地图备份缺少有效图片内容')
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function blobFromMapBytes(bytes: Uint8Array, mimeType = ''): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: mimeType })
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
