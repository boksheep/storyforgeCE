import { buildOpenAIEndpoint } from './openai-endpoint'

interface FetchOpenAIModelsOptions {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** `/v1/models` 的一条记录：模型 id + 服务端报告的上下文窗口（若有）。 */
export interface OpenAIModelInfo {
  id: string
  /**
   * 服务端报告的上下文窗口（token）。不同实现字段名不一：
   *   - OpenRouter / 部分聚合器：`context_length`
   *   - vLLM / TGI / LM Studio：`max_model_len`
   *   - 某些网关：`context_window` / `max_context_length` / `contextLength`
   * 也接受嵌在 `metadata` / `meta` 里的同名键。取不到时为 undefined（表示"未知"，不是 0）。
   */
  contextWindow?: number
}

/** 从任意对象里按常见字段名找上下文窗口。 */
function pickContextWindow(item: Record<string, unknown>): number | undefined {
  const keys = [
    'context_length',
    'contextLength',
    'max_model_len',
    'maxModelLen',
    'max_context_length',
    'maxContextLength',
    'context_window',
    'contextWindow',
    'context_size',
    'contextSize',
  ]
  const sources: Array<Record<string, unknown>> = [item]
  for (const nested of ['metadata', 'meta', 'model_info', 'modelInfo']) {
    const value = item[nested]
    if (value && typeof value === 'object') sources.push(value as Record<string, unknown>)
  }
  for (const source of sources) {
    for (const key of keys) {
      const raw = source[key]
      const parsed = typeof raw === 'string' ? Number(raw) : raw
      if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed)
      }
    }
  }
  return undefined
}

/**
 * 获取模型目录（含服务端报告的上下文窗口）。
 *
 * 这是"API 设置时自动获取并应用 AI 上下文"的数据来源：只有拿到真实窗口，
 * 才能避免把 1M 窗口的模型当 128K 用（底栏显示与裁剪预算都会跟着错）。
 */
export async function fetchOpenAIModelCatalog({
  baseUrl,
  apiKey = '',
  timeoutMs = 10_000,
  fetchImpl = fetch,
}: FetchOpenAIModelsOptions): Promise<OpenAIModelInfo[]> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(buildOpenAIEndpoint(baseUrl, 'models'), {
      method: 'GET',
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    })

    if (!response.ok) {
      throw new Error(`模型列表请求失败（HTTP ${response.status}）`)
    }

    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
      throw new Error('模型列表响应格式无效，服务需兼容 OpenAI /v1/models')
    }

    const catalog = new Map<string, OpenAIModelInfo>()
    for (const item of (body as { data: unknown[] }).data) {
      if (!item || typeof item !== 'object') continue
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string' || !id.trim()) continue
      const key = id.trim()
      const contextWindow = pickContextWindow(item as Record<string, unknown>)
      const existing = catalog.get(key)
      // 同一 id 重复时保留能给出窗口的那条
      if (!existing || (existing.contextWindow == null && contextWindow != null)) {
        catalog.set(key, contextWindow != null ? { id: key, contextWindow } : { id: key })
      }
    }

    return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('刷新模型列表超时，请确认本地模型服务已启动')
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接模型服务，请检查 Base URL、服务状态或 CORS 设置')
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

/** 兼容旧调用方：只要模型 id 列表（按字母序）。 */
export async function fetchOpenAIModels(options: FetchOpenAIModelsOptions): Promise<string[]> {
  const catalog = await fetchOpenAIModelCatalog(options)
  return catalog.map(entry => entry.id)
}
