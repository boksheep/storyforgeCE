import type { AIConfig, ChatMessage } from '../types'
import { AIError } from '../types'
import { createLog, updateLog, type TokenUsage } from './logger'
import { recordUsage } from './usage-log'
import { trimMessagesToFit } from './context-budget'
import { buildOpenAIEndpoint } from './openai-endpoint'
import { useAIConfigStore } from '../../stores/ai-config'
import { classifyAITask, resolveAIConfigForTask, TASK_ROUTE_META, type AITaskKind } from './task-routing'
import { log, logEvent, newCorrelationId } from '../logging/logger'

/** 只留主机与路径，去掉可能带 key 的查询串（日志要能发给别人排错）。 */
function safeUrl(url: string): string {
  const cut = url.indexOf('?')
  return cut >= 0 ? url.slice(0, cut) : url
}

/** 调用元信息（用于消耗统计分类） */
export interface AICallMeta {
  /** 消耗类型标识（moduleKey 或显式 category，如 'chapter.content'） */
  category?: string
  projectId?: number | null
  /** 调用方显式要求保留的临时生成参数，不参与持久化。 */
  configOverrides?: Partial<AIConfig>
  /**
   * 默认沿用既有生成链的自动裁剪；协议型调用可要求拒绝裁剪，
   * 避免系统指令、用户目标或工具证据被静默移除后继续执行。
   */
  contextOverflowPolicy?: 'trim' | 'reject'
}

export function resolveRequestConfig(config: AIConfig, meta?: AICallMeta) {
  const state = useAIConfigStore.getState()
  return resolveAIConfigForTask({
    category: meta?.category,
    requestedConfig: config,
    globalConfig: state.config,
    presets: state.presets,
    routes: state.taskRoutes,
    explicitOverrides: meta?.configOverrides,
  })
}

/** 从服务端 usage 里解析 token 与缓存命中。缓存字段各家命名不同，缺失即未知（不是 0）。 */
function parseTokenUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
  }
}

function warnRouteFallback(resolved: ReturnType<typeof resolveRequestConfig>, meta?: AICallMeta): void {
  if (resolved.fallbackReason) {
    log.warn('AI', 'ai', `[AI] task route fallback (${resolved.fallbackReason}): ${meta?.category ?? 'uncategorized'}`)
  }
}

function usageEntry(
  meta: AICallMeta | undefined,
  config: AIConfig,
  taskKind: AITaskKind | null,
  usage: TokenUsage,
  /** LOG-1：与连接日志/运行日志共用，用来把"花了多少"和"错在哪"对上。 */
  correlationId?: string,
) {
  return {
    projectId: meta?.projectId ?? null,
    timestamp: Date.now(),
    category: meta?.category ?? '',
    provider: config.provider,
    model: config.model,
    taskKind: taskKind ?? undefined,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens != null ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    correlationId,
  }
}

/** 可变容器，streamChat 写入 usage，调用方读取 */
export interface StreamResult {
  usage?: TokenUsage
  finishReason?: string
}

/** 可变容器，chat 写入非流式调用返回的真实 token 用量。 */
export interface ChatResult {
  usage?: TokenUsage
  finishReason?: string
}

/**
 * 根据 provider 构造请求 URL 和 headers
 */
function buildRequest(config: AIConfig, messages: ChatMessage[], stream: boolean) {
  // 基础请求体：所有 provider 都需要的字段
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
  }

  // 流式请求时要求返回 token 用量
  // stream_options 仅 OpenAI / DeepSeek / Qwen 等兼容 provider 支持
  // 智谱 GLM / 文心 / Poe / Gemini 等不支持，传了会报参数错误
  const NO_STREAM_OPTIONS: Set<string> = new Set(['glm', 'wenxin', 'poe', 'gemini', 'ollama', 'longcat'])
  if (stream && !NO_STREAM_OPTIONS.has(config.provider)) {
    body.stream_options = { include_usage: true }
  }

  // Poe 官方文档明确只需 model + messages，不要传额外参数
  // （Claude 模型在 Poe 上自动启用 thinking，传 max_tokens/temperature 会冲突报 400）
  if (config.provider === 'poe') {
    // Poe: 不传额外参数
  } else if (config.provider === 'deepseek') {
    const isThinkingModel = config.model.includes('v4-pro')
    if (isThinkingModel) {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = 'high'
    } else {
      if (config.temperature !== undefined) body.temperature = config.temperature
    }
    // maxTokens > 0 才传，0 = 不限制（由模型自身决定）
    if (config.maxTokens && config.maxTokens > 0) body.max_tokens = config.maxTokens
  } else if (config.provider === 'glm') {
    // 智谱 GLM：temperature 范围 (0, 1]，超出会报 1210
    if (config.temperature !== undefined) {
      body.temperature = Math.min(Math.max(config.temperature, 0.01), 1.0)
    }
    if (config.maxTokens && config.maxTokens > 0) body.max_tokens = config.maxTokens
  } else if (config.provider === 'longcat') {
    // LongCat OpenAI 兼容端点：temperature 范围 0~1，且不声明 stream_options。
    if (config.temperature !== undefined) {
      body.temperature = Math.min(Math.max(config.temperature, 0), 1.0)
    }
    if (config.maxTokens && config.maxTokens > 0) body.max_tokens = config.maxTokens
  } else {
    if (config.temperature !== undefined) body.temperature = config.temperature
    // maxTokens > 0 才传，0 = 不限制（由模型自身决定）
    if (config.maxTokens && config.maxTokens > 0) body.max_tokens = config.maxTokens
  }

  return {
    url: buildOpenAIEndpoint(config.baseUrl, 'chat/completions'),
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  }
}

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504])

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers?.get('Retry-After')
  const seconds = retryAfter == null ? NaN : Number(retryAfter)
  const fromHeader = Number.isFinite(seconds) ? seconds * 1000
    : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  return Number.isFinite(fromHeader) ? Math.max(0, Math.min(fromHeader, 8_000))
    : Math.min(2_000 * (attempt + 1), 8_000)
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 仅在收到响应体之前重试；已开始输出的流绝不重放，避免重复内容。 */
async function fetchChatResponse(
  req: ReturnType<typeof buildRequest>,
  signal: AbortSignal | undefined,
  maxRetries: number,
  onRetry: (reason: string, attempt: number, delayMs: number) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null
    try {
      response = await fetch(req.url, {
        method: 'POST', headers: req.headers, body: req.body, signal,
      })
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError) || attempt >= maxRetries) throw error
      const delayMs = retryDelay(null, attempt)
      onRetry('network', attempt + 1, delayMs)
      await waitForRetry(delayMs, signal)
      continue
    }
    if (!RETRYABLE_HTTP_STATUS.has(response.status) || attempt >= maxRetries) return response
    const delayMs = retryDelay(response, attempt)
    onRetry(`HTTP ${response.status}`, attempt + 1, delayMs)
    void response.body?.cancel().catch(() => {})
    await waitForRetry(delayMs, signal)
  }
}

/**
 * 统一的流式聊天接口
 * 使用 AsyncGenerator 逐块 yield 文本内容
 */
export async function* streamChat(
  messages: ChatMessage[],
  config: AIConfig,
  signal?: AbortSignal,
  result?: StreamResult,
  meta?: AICallMeta,
): AsyncGenerator<string> {
  const resolved = resolveRequestConfig(config, meta)
  warnRouteFallback(resolved, meta)
  config = resolved.config
  const trimmed = trimMessagesToFit(messages, config.provider, config.model, config.maxTokens, config.contextWindow)
  if (trimmed.trimmed && meta?.contextOverflowPolicy === 'reject') {
    throw new Error(
      `当前模型上下文窗口不足以容纳完整请求（${trimmed.totalInputTokens}/${trimmed.inputBudget} tokens）；已拒绝静默裁剪。`,
    )
  }
  if (trimmed.trimmed) {
    logEvent({ level: 'warn', tag: 'AI', event: 'ai', message: `[AI] request messages trimmed to fit context window: ${trimmed.totalInputTokens}/${trimmed.inputBudget} tokens` })
  }
  if (!trimmed.protectedEnvelopePreserved) {
    throw new Error('当前模型上下文窗口无法容纳最低连续性保护块；请降低输出长度或改用更大上下文模型。')
  }
  const req = buildRequest(config, trimmed.messages, true)

  const log = createLog({
    type: 'stream',
    provider: config.provider,
    url: req.url,
    model: config.model,
    status: 'pending',
    category: meta?.category,
    taskKindLabel: classifyAITask(meta?.category) ? TASK_ROUTE_META[classifyAITask(meta?.category)!].label : undefined,
    routeApplied: Boolean(resolved.presetId),
  })

  const startTime = Date.now()

  try {
    const response = await fetchChatResponse(req, signal, 2, (reason, attempt, delayMs) => {
      logEvent({ level: 'warn', tag: 'AI', event: 'ai', message: `[AI] ${reason}，${delayMs / 1000}s 后重试（${attempt}/2）`,
        meta: { correlationId: log.correlationId, status: reason, attempt } })
    })

    if (!response.ok) {
      const errorText = await response.text()
      const duration = Date.now() - startTime
      updateLog(log.id, { status: 'error', statusCode: response.status, duration, errorMessage: errorText.slice(0, 200) })
      throw new AIError(response.status, errorText)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: TokenUsage | undefined
    let finishReason: string | undefined

    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = done ? '' : lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            const logUpdate: Record<string, unknown> = { status: 'success', statusCode: response.status, duration: Date.now() - startTime }
            if (usage) logUpdate.usage = usage
            if (result && usage) result.usage = usage
            if (result) result.finishReason = finishReason
            updateLog(log.id, logUpdate)
            if (usage) void recordUsage(usageEntry(meta, config, resolved.taskKind, usage, log.correlationId))
            return
          }
          try {
            const json = JSON.parse(data)
            const content = json.choices?.[0]?.delta?.content
            if (content) yield content
            if (typeof json.choices?.[0]?.finish_reason === 'string') {
              finishReason = json.choices[0].finish_reason
            }
            // 提取 token 用量（通常在最后一个 chunk 中）
            const parsedUsage = parseTokenUsage(json.usage)
            if (parsedUsage) usage = parsedUsage
          } catch {
            // 忽略解析错误
          }
        }
      }
      if (done) break
    }

    const logUpdate: Record<string, unknown> = { status: 'success', statusCode: response.status, duration: Date.now() - startTime }
    if (usage) logUpdate.usage = usage
    if (result && usage) result.usage = usage
    if (result) result.finishReason = finishReason ?? 'incomplete'
    updateLog(log.id, logUpdate)
    if (usage) void recordUsage(usageEntry(meta, config, resolved.taskKind, usage, log.correlationId))
  } catch (err) {
    if (err instanceof AIError) throw err
    const duration = Date.now() - startTime
    // 中止（用户点停止 / 被新的生成取代）不是失败：单独记为 aborted，
    // 否则界面与日志里会留下一条"模型请求失败：signal is aborted without reason"的红色错误，
    // 让作者以为模型或网络出了问题。真实事故：并发/重复点击时正是这条日志掩盖了"谁取代了谁"。
    if (signal?.aborted) {
      updateLog(log.id, { status: 'aborted', duration, errorMessage: '已取消' })
      throw err
    }
    updateLog(log.id, { status: 'error', duration, errorMessage: (err as Error).message })
    if (err instanceof TypeError) {
      throw new Error('模型连接失败：请检查网络、API 地址或浏览器跨域设置；瞬时连接错误已自动重试。')
    }
    throw err
  }
}

/**
 * 非流式聊天（用于简单调用如测试连接）
 */
/**
 * 非流式调用的兜底超时。
 *
 * 事故教训：协商三步（摘要/提问/申报）走的都是 `chat()`，而它**没有任何超时**，
 * 网络半死时 `fetch` 会挂到 TCP 超时 —— 面板一直停在"正在跑"，作者既看不出在等什么，
 * 也没有可信的取消入口（工具栏看的是流式状态，非流式阶段什么都显示不出来）。
 * 120 秒足够覆盖正常的长回答，又不会让人无限等。
 */
export const CHAT_TIMEOUT_MS = 120_000

/** 把外部 signal 与内部超时合并：任一触发都中止本次请求。 */
function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  timedOut: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort)
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/**
 * 从非流式响应里取出助手文本。
 *
 * 事故教训（"生成前协商无法正确输出"）：此前只看 `choices[0].message.content` 且假定它是字符串。
 * 但目标服务商有两种常见形态会被它漏掉：
 *   ① **推理模型**把正文放在 `reasoning_content`（有的服务商放 `reasoning`），`content` 为空
 *      → 以前返回空串，面板显示"模型没有返回可用的摘要"，看起来像"没调用 API"；
 *   ② **content 变成分段数组**（`[{type:'text',text:'…'}]`）→ 以前把它原样返回，
 *      调用方 `text.trim()` 直接 TypeError。
 * 现在统一取文本，并把"响应长什么样"记进日志，下次能一眼看出是哪种情况。
 */
export function extractAssistantText(message: Record<string, unknown> | undefined): {
  text: string
  source: 'content' | 'content-parts' | 'none'
  contentChars: number
  reasoningChars: number
} {
  const content = message?.content
  const reasoningRaw = message?.reasoning_content ?? message?.reasoning
  const reasoningChars = typeof reasoningRaw === 'string' ? reasoningRaw.length : 0

  if (typeof content === 'string' && content.trim()) {
    return { text: content, source: 'content', contentChars: content.length, reasoningChars }
  }
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
      .join('')
      .trim()
    if (joined) return { text: joined, source: 'content-parts', contentChars: joined.length, reasoningChars }
  }
  const contentChars = typeof content === 'string' ? content.length : 0
  return { text: '', source: 'none', contentChars, reasoningChars }
}

export async function chat(
  messages: ChatMessage[],
  config: AIConfig,
  meta?: AICallMeta,
  signal?: AbortSignal,
  result?: ChatResult,
): Promise<string> {
  const resolved = resolveRequestConfig(config, meta)
  warnRouteFallback(resolved, meta)
  config = resolved.config
  const trimmed = trimMessagesToFit(messages, config.provider, config.model, config.maxTokens, config.contextWindow)
  if (trimmed.trimmed && meta?.contextOverflowPolicy === 'reject') {
    throw new Error(
      `当前模型上下文窗口不足以容纳完整请求（${trimmed.totalInputTokens}/${trimmed.inputBudget} tokens）；已拒绝静默裁剪。`,
    )
  }
  if (trimmed.trimmed) {
    log.warn('AI', 'ai', `[AI] request messages trimmed to fit context window: ${trimmed.totalInputTokens}/${trimmed.inputBudget} tokens`)
  }
  if (!trimmed.protectedEnvelopePreserved) {
    throw new Error('当前模型上下文窗口无法容纳最低连续性保护块；请降低输出长度或改用更大上下文模型。')
  }
  const req = buildRequest(config, trimmed.messages, false)

  /**
   * LOG-1 补强：非流式 `chat()` 此前**完全不进日志**，于是"生成前协商"的三步调用
   * （摘要/提问/申报）在运行日志里查不到任何痕迹 —— 真实事故里作者问"协商到底跑没跑"，
   * 日志无法回答。这里补上开始/结束事件，并带上 `category`，让同类问题下次可判读。
   */
  const correlationId = newCorrelationId()
  const callMeta = {
    type: 'chat',
    provider: config.provider,
    model: config.model,
    url: safeUrl(req.url),
    category: meta?.category ?? '',
    task: classifyAITask(meta?.category) ? TASK_ROUTE_META[classifyAITask(meta?.category)!].label : '',
    route: resolved.presetId ? 'preset' : 'global',
    correlationId,
  }
  log.info('AI', 'ai', `[AI] chat 请求开始：${config.provider} / ${config.model}`, callMeta)
  const startedAt = Date.now()

  // 兜底超时：非流式调用过去完全没有超时，挂住就等于界面卡在"正在跑"。
  const timeout = withRequestTimeout(signal, CHAT_TIMEOUT_MS)

  let response: Response
  let json: Awaited<ReturnType<Response['json']>> | undefined
  let errorText = ''
  try {
    response = await fetchChatResponse(req, timeout.signal, 1, (reason, attempt, delayMs) => {
      logEvent({ level: 'warn', tag: 'AI', event: 'ai', message: `[AI] chat ${reason}，${delayMs / 1000}s 后重试（${attempt}/1）`,
        meta: { ...callMeta, attempt, status: reason } })
    })
    if (response.ok) json = await response.json()
    else errorText = await response.text()
  } catch (err) {
    const timedOut = timeout.timedOut()
    const aborted = !timedOut && signal?.aborted === true
    if (timedOut) {
      logEvent({
        level: 'error',
        tag: 'AI',
        event: 'ai',
        message: `[AI] chat 请求超时（${Math.round(CHAT_TIMEOUT_MS / 1000)} 秒未返回）`,
        meta: { ...callMeta, ms: Date.now() - startedAt, timeout: true },
      })
      throw new Error(`模型请求超时（${Math.round(CHAT_TIMEOUT_MS / 1000)} 秒未返回）：请检查网络或换一个可用的服务商。`)
    }
    logEvent({
      level: aborted ? 'info' : 'error',
      tag: 'AI',
      event: 'ai',
      message: aborted
        ? '[AI] chat 请求中止（用户停止或已被新的生成取代）'
        : `[AI] chat 请求失败：${err instanceof Error ? err.name : 'unknown'}`,
      meta: { ...callMeta, ms: Date.now() - startedAt },
      error: aborted ? undefined : err,
    })
    if (!aborted && err instanceof TypeError) {
      throw new Error('模型连接失败：请检查网络、API 地址或浏览器跨域设置；瞬时连接错误已自动重试。')
    }
    throw err
  } finally {
    timeout.cleanup()
  }

  if (!response!.ok) {
    logEvent({
      level: 'error',
      tag: 'AI',
      event: 'ai',
      message: `[AI] chat 请求失败：HTTP ${response!.status}`,
      meta: { ...callMeta, statusCode: response!.status, ms: Date.now() - startedAt },
    })
    throw new AIError(response!.status, errorText)
  }

  if (!json) throw new Error('模型响应为空。')
  const message = json.choices?.[0]?.message as Record<string, unknown> | undefined
  const extracted = extractAssistantText(message)
  if (result && typeof json.choices?.[0]?.finish_reason === 'string') {
    result.finishReason = json.choices[0].finish_reason
  }
  // 「响应长什么样」必须留痕：否则"协商没输出"只能猜是没调 API、还是模型返回了空/别的字段。
  log.info('AI', 'ai', `[AI] chat 请求完成：${config.provider} / ${config.model}`, {
    ...callMeta,
    statusCode: response.status,
    ms: Date.now() - startedAt,
    choices: Array.isArray(json.choices) ? json.choices.length : 0,
    finishReason: json.choices?.[0]?.finish_reason ?? '',
    textFrom: extracted.source,
    contentChars: extracted.contentChars,
    reasoningChars: extracted.reasoningChars,
  })
  if (!extracted.text) {
    log.warn('AI', 'ai', '[AI] chat 返回了空文本（已记录响应结构，请对照 textFrom/contentChars 判断）', {
      ...callMeta,
      textFrom: extracted.source,
      contentChars: extracted.contentChars,
    })
  }
  const parsedUsage = parseTokenUsage(json.usage)
  if (parsedUsage) {
    if (result) result.usage = parsedUsage
    // 这条路径（非流式 chat）没有连接日志条目，因此用量事件自带上面生成的关联 id，
    // 仍能与本次调用的开始/结束事件对上。
    void recordUsage(usageEntry(meta, config, resolved.taskKind, parsedUsage, correlationId))
  }
  return extracted.text
}
