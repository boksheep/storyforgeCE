export interface NormalizedOpenAIBaseUrl {
  baseUrl: string
  changed: boolean
  warnings: string[]
}

const COMMON_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/models',
  '/embeddings',
]

export function normalizeOpenAIBaseUrl(rawBaseUrl: string): NormalizedOpenAIBaseUrl {
  const input = (rawBaseUrl || '').trim()
  let baseUrl = input.replace(/\/+$/, '')
  const warnings: string[] = []

  for (const suffix of COMMON_ENDPOINT_SUFFIXES) {
    if (baseUrl.toLowerCase().endsWith(suffix)) {
      baseUrl = baseUrl.slice(0, -suffix.length).replace(/\/+$/, '')
      warnings.push(`Base URL 已包含 ${suffix} 端点，已按 OpenAI 兼容根路径自动修正。`)
      break
    }
  }

  const beforeDedupe = baseUrl
  baseUrl = baseUrl.replace(/(\/v1)+\/v1$/i, '/v1')
  if (baseUrl !== beforeDedupe) {
    warnings.push('Base URL 含重复 /v1，已自动合并。')
  }

  return {
    baseUrl,
    changed: baseUrl !== input.replace(/\/+$/, ''),
    warnings,
  }
}

export function buildOpenAIEndpoint(rawBaseUrl: string, endpoint: 'chat/completions' | 'models' | 'embeddings'): string {
  const normalized = normalizeOpenAIBaseUrl(rawBaseUrl)
  return `${normalized.baseUrl}/${endpoint}`
}
