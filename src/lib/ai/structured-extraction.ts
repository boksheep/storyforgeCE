/**
 * 结构化 AI 提取的通用基础。
 *
 * 只负责长文本分块与 JSON 结构定位；不使用正则判断小说语义。
 */

export function splitExtractionText(
  text: string,
  maxChars = 5200,
  overlapChars = 320,
): string[] {
  const source = text.trim()
  if (!source) return []
  if (source.length <= maxChars) return [source]

  const chunks: string[] = []
  let start = 0
  while (start < source.length) {
    let end = Math.min(source.length, start + maxChars)
    if (end < source.length) {
      const paragraphBreak = source.lastIndexOf('\n\n', end)
      const sentenceBreak = Math.max(
        source.lastIndexOf('。', end),
        source.lastIndexOf('！', end),
        source.lastIndexOf('？', end),
      )
      const preferred = Math.max(paragraphBreak, sentenceBreak)
      if (preferred > start + Math.floor(maxChars * 0.65)) end = preferred + 1
    }
    chunks.push(source.slice(start, end))
    if (end >= source.length) break
    start = Math.max(start + 1, end - overlapChars)
  }
  return chunks
}

export function parseJsonArray<T>(raw: string): T[] {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  let json = fence ? fence[1].trim() : trimmed
  const start = json.indexOf('[')
  const end = json.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  json = json.slice(start, end + 1)
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = keyOf(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
