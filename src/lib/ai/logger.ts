/**
 * AI 连接日志系统
 * 记录所有 API 调用的详细信息，方便排错
 *
 * LOG-1：本模块继续服务「连接日志」面板（含 `responseBody` 预览这种**面板专用**字段），
 * 但它不再是一座孤岛：每条记录同时产出统一 `LogEvent`（tag `AI`）并带 `correlationId`，
 * 于是"另存 txt 的运行日志"与"连接日志面板"、"用量记录"能按同一个 id 串起来。
 *
 * ⚠️ `responseBody` / 完整 `errorMessage` 只进面板，**永远不进 txt**（隐私契约见 docs/LOGGING-DESIGN.md）：
 * 它们可能整段是模型响应正文。落盘只写状态、耗时、token 与截断后的错误摘要。
 */
import { log, newCorrelationId } from '../logging/logger'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /**
   * 命中提示词缓存的输入 token 数（DeepSeek: prompt_cache_hit_tokens；
   * OpenAI 兼容: prompt_tokens_details.cached_tokens）。服务端不返回时为 undefined，
   * 表示"未知"，与 0（明确未命中）区分开。
   */
  cachedInputTokens?: number
}

export interface AILogEntry {
  id: string
  timestamp: number
  type: 'test' | 'chat' | 'stream'
  provider: string
  url: string
  model: string
  /**
   * `aborted` 是**独立状态**，不是 error：用户点「停止」或这次生成被新的生成取代时，
   * 客户端会抛 "signal is aborted without reason"，把它当错误会在界面上留下一条红色失败，
   * 让作者以为模型/网络出了问题（真实事故：中止被报成 ERROR，掩盖了"谁覆盖了谁"）。
   */
  status: 'pending' | 'success' | 'error' | 'aborted'
  statusCode?: number
  errorMessage?: string
  responseBody?: string
  duration?: number
  usage?: TokenUsage
  /** LOG-1：与用量记录/运行日志共用的关联 id。 */
  correlationId: string
  /** 调用类目（如 `chapter.plan.summary`）：让"协商到底跑没跑"在日志里可判读。 */
  category?: string
  /**
   * 这次实际走的是哪个模型槽位与哪套配置。
   * 作者的真实疑问是"它到底调的是不是我配的「创作生成」" —— 只记 provider/model 不够，
   * 还要记"任务种类 + 是否命中了路由预设"，否则路由没配好时看不出来（会静默跟随全局）。
   */
  taskKindLabel?: string
  routeApplied?: boolean
}

const MAX_LOGS = 50
let logs: AILogEntry[] = []
let listeners: Array<() => void> = []

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 只留主机与路径，去掉可能带 key 的查询串。 */
function safeUrl(url: string): string {
  const cut = url.indexOf('?')
  return cut >= 0 ? url.slice(0, cut) : url
}

/** 创建一条新日志 */
export function createLog(entry: Omit<AILogEntry, 'id' | 'timestamp' | 'correlationId'>): AILogEntry {
  const record: AILogEntry = {
    ...entry,
    id: generateId(),
    correlationId: newCorrelationId(),
    timestamp: Date.now(),
  }
  logs = [record, ...logs].slice(0, MAX_LOGS)
  notify()
  log2Start(record)
  return record
}

function log2Start(entry: AILogEntry) {
  log.info('AI', 'ai', `[AI] ${entry.type} 请求开始：${entry.provider} / ${entry.model}`, {
    type: entry.type,
    provider: entry.provider,
    model: entry.model,
    url: safeUrl(entry.url),
    category: entry.category ?? '',
    task: entry.taskKindLabel ?? '',
    route: entry.routeApplied === undefined ? '' : (entry.routeApplied ? 'preset' : 'global'),
    correlationId: entry.correlationId,
  })
}

/** 更新日志 */
export function updateLog(id: string, update: Partial<AILogEntry>) {
  logs = logs.map((l) => (l.id === id ? { ...l, ...update } : l))
  notify()
  const entry = logs.find(l => l.id === id)
  if (entry) log2Finish(entry)
}

function log2Finish(entry: AILogEntry) {
  const meta: Record<string, unknown> = {
    status: entry.status,
    type: entry.type,
    provider: entry.provider,
    model: entry.model,
    category: entry.category ?? '',
  }
  if (entry.statusCode != null) meta.statusCode = entry.statusCode
  if (entry.duration != null) meta.ms = entry.duration
  if (entry.usage) {
    meta.in = entry.usage.inputTokens
    meta.out = entry.usage.outputTokens
  }
  const event = { ...meta, correlationId: entry.correlationId }
  if (entry.status === 'success') {
    log.info('AI', 'ai', `[AI] ${entry.type} 请求完成：${entry.provider} / ${entry.model}`, event)
    return
  }
  if (entry.status === 'aborted') {
    // 中止不是失败：用户按了停止，或这次生成被新的生成取代。按 info 记，绝不写 ERROR。
    log.info('AI', 'ai', `[AI] ${entry.type} 请求中止（用户停止或已被新的生成取代）`, event)
    return
  }
  if (entry.status === 'error') {
    // 错误摘要截断到 200 字：够定位问题，又不足以整段搬运响应正文。
    const summary = (entry.errorMessage ?? '未知错误').replace(/\s+/g, ' ').slice(0, 200)
    log.error('AI', 'ai', `[AI] ${entry.type} 请求失败：${summary}`, event)
  }
}

/** 获取所有日志 */
export function getLogs(): AILogEntry[] {
  return logs
}

/** 清空日志 */
export function clearLogs() {
  logs = []
  notify()
}

/** 订阅日志变化 */
export function subscribeLogs(listener: () => void) {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function notify() {
  listeners.forEach((l) => l())
}

/** 格式化日志为可读文本 */
export function formatLog(entry: AILogEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
  const status = entry.status === 'success'
    ? '✅'
    : entry.status === 'error' ? '❌'
      : entry.status === 'aborted' ? '⏹' : '⏳'
  const dur = entry.duration ? ` (${entry.duration}ms)` : ''
  let line = `${status} [${time}] ${entry.type.toUpperCase()} → ${entry.provider} ${entry.url}${dur}`
  if (entry.statusCode) line += ` HTTP ${entry.statusCode}`
  if (entry.usage) line += `\n   Token: ↑${entry.usage.inputTokens} ↓${entry.usage.outputTokens} = ${entry.usage.totalTokens}`
  if (entry.errorMessage) line += `\n   错误: ${entry.errorMessage}`
  return line
}
