/**
 * LOG-1 · 日志事件形状与隐私契约（纯逻辑，无副作用）。
 *
 * 为什么先固定形状：现有三套日志（`ai/logger.ts` 内存环形、`ai/usage-log.ts` → `aiUsageLog`、
 * `diagnostics/local-diagnostic-report.ts`）各写各的，作者想查一次生成到底发生了什么，
 * 得在三个界面之间拼线索。统一形状 + 单一 sink 之后，"另存 txt"与"应用内查看"才可能一致。
 *
 * **隐私契约（与既有诊断报告同一立场）**：
 * - 不写正文、不写提示词、不写模型响应体、不写 API key；
 * - `meta` 只接受原始类型（string / number / boolean），对象与数组一律丢弃；
 * - 字符串值按 `META_VALUE_MAX_CHARS` 截断（长文本用长度/哈希代替，这一约定写在类型注释里）；
 * - 单行上限 `LOG_LINE_MAX_CHARS`，换行转义，保证"一行一个事件"可 grep。
 */
import { isLogTag, type LogTag } from './log-tags'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export const LOG_LINE_MAX_CHARS = 2_000
export const META_VALUE_MAX_CHARS = 200
export const LOG_MESSAGE_MAX_CHARS = 500
export const LOG_ERROR_FRAME_LIMIT = 8

export interface LogErrorInfo {
  name: string
  frames: string[]
}

export interface LogEvent {
  ts: number
  /**
   * 机器可读的本地 ISO 串（含毫秒与时区偏移），保留给后续可能的机器消费方；
   * **txt 行头用的是 `formatLogStamp(ts)`**（`[YYYY/MM/DD HH:mm:ss]`），不用这个字段。
   */
  iso: string
  level: LogLevel
  tag: LogTag
  /** 机器键，如 `ai.request.failed` / `chapter.saved`（点号分层，便于过滤与统计）。 */
  event: string
  message: string
  projectId?: number
  chapterId?: number
  /** 关联 id：同一次调用的连接日志与用量记录共用它，便于把两条通道串起来。 */
  correlationId?: string
  meta?: Record<string, string | number | boolean>
  error?: LogErrorInfo
}

export interface LogEventInput {
  level: LogLevel
  tag: LogTag | string
  event: string
  message?: string
  projectId?: number | null
  chapterId?: number | null
  correlationId?: string
  meta?: Record<string, unknown>
  error?: unknown
  /**
   * 只进内存环形、**不排队落盘**。
   * 用途：落盘自身失败的记录 —— 否则"写不出去"会生成新日志再失败，形成自我放大的循环。
   */
  skipQueue?: boolean
}

/**
 * 归一 `meta`：只留原始类型，字符串截断，键名也做长度保护。
 * 返回 undefined 表示"没有可写的元数据"（不写空对象，保持 txt 干净）。
 */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!meta) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [rawKey, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue
    const key = rawKey.slice(0, 40)
    if (typeof value === 'string') {
      out[key] = value.replace(/\s+/g, ' ').trim().slice(0, META_VALUE_MAX_CHARS)
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    }
    // 其它类型（对象/数组/函数/Error）一律丢弃：它们最容易夹带正文或密钥。
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 归一错误：只保留名字与有限数量的栈帧（与 `local-diagnostic-report.ts` 的既有立场一致），
 * 不保留 message —— 模型/解析错误的 message 里经常夹带正文片段。
 *
 * 帧也**只留文件名**：绝对路径里有用户名与目录结构（`C:\Users\<姓名>\…`），
 * 日志是要发给别人排错的，不该顺手把作者的机器信息带出去。
 */
export function sanitizeError(error: unknown): LogErrorInfo | undefined {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return { name: error.slice(0, 80), frames: [] }
  if (typeof error !== 'object') return { name: typeof error, frames: [] }
  const candidate = error as { name?: unknown; stack?: unknown }
  const name = typeof candidate.name === 'string' && candidate.name ? candidate.name.slice(0, 80) : 'Error'
  const frames = typeof candidate.stack === 'string'
    ? candidate.stack
      .split('\n')
      .slice(1, 1 + LOG_ERROR_FRAME_LIMIT)
      .map(shortenStackFrame)
      .filter(Boolean)
    : []
  return { name, frames }
}

/** `at fn (file:///C:/Users/x/src/a.ts:1:2)` → `at fn a.ts:1:2`（去掉绝对路径）。 */
function shortenStackFrame(rawLine: string): string {
  const line = rawLine.trim()
  if (!line) return ''
  const withoutAt = line.replace(/^at\s+/, '')
  const paren = withoutAt.lastIndexOf('(')
  const prefix = paren > 0 ? `${withoutAt.slice(0, paren).trim()} ` : ''
  const target = (paren > 0 ? withoutAt.slice(paren + 1).replace(/\)\s*$/, '') : withoutAt).trim()
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  const basename = (slash >= 0 ? target.slice(slash + 1) : target).replace(/[?#].*$/, '')
  return `at ${prefix}${basename}`.trim().slice(0, 160)
}

function normalizeTag(tag: LogTag | string): LogTag | string {
  return isLogTag(tag) ? tag : 'Unknown'
}

/**
 * 构造事件。`iso` 用本地时区的 ISO 串（日志是给人看的，不是给机器对时用的）。
 */
export function createLogEvent(input: LogEventInput, now = Date.now()): LogEvent {
  const date = new Date(now)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0')
  const iso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`

  return {
    ts: now,
    iso,
    level: input.level,
    tag: normalizeTag(input.tag),
    event: input.event.slice(0, 80),
    message: (input.message ?? '').replace(/\s+/g, ' ').trim().slice(0, LOG_MESSAGE_MAX_CHARS),
    projectId: input.projectId ?? undefined,
    chapterId: input.chapterId ?? undefined,
    correlationId: input.correlationId,
    meta: sanitizeMeta(input.meta),
    error: sanitizeError(input.error),
  }
}

/**
 * 行头时间戳：`[2026/09/30 20:17:58]`（本地时间、秒级、方括号包裹）。
 *
 * 为什么不是 ISO：日志是给人读的。`2026-09-30T20:17:58.983+08:00` 里的 `T`、毫秒与时区偏移
 * 对"几点几分发生了什么"没有任何帮助，反而让第一列难以扫读；毫秒与时区完全可以从 `ts` 还原，
 * 需要机器时间请读 `LogEvent.ts`（txt 只是人读副本）。
 */
export function formatLogStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `[${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`
}

/**
 * 渲染成 txt 的一行：`[YYYY/MM/DD HH:mm:ss] \t [level] \t TAG \t event \t message \t k=v …`
 *
 * 为什么用制表符而不是 JSON：作者的日志要能直接看、能 grep、能在 Excel 里分列；
 * JSON 一行也读不出来。字段顺序固定，缺少的字段留空但**不省略分隔符**（列位稳定）。
 *
 * 时间与级别都用方括号小写（`[2026/09/30 20:17:58] [warn]`）：两列都是"读日志时先扫到"的元信息，
 * 视觉上成一族，且小写不会在整行里抢戏。⚠️ 级别列的格式是**被依赖的**：
 * `log-flush.ts` 靠 `\t[error]\t` 判断"队列里有错误行 → 立即落盘"，改格式必须同步改那里。
 */
export function formatLogLine(event: LogEvent): string {
  const parts: string[] = [
    formatLogStamp(event.ts),
    `[${event.level}]`,
    String(event.tag),
    event.event,
    event.message,
  ]
  if (event.projectId != null) parts.push(`project=${event.projectId}`)
  if (event.chapterId != null) parts.push(`chapter=${event.chapterId}`)
  if (event.correlationId) parts.push(`cid=${event.correlationId}`)
  if (event.meta) {
    for (const [key, value] of Object.entries(event.meta)) parts.push(`${key}=${value}`)
  }
  if (event.error) {
    parts.push(`error=${event.error.name}`)
    for (const frame of event.error.frames) parts.push(`at=${frame}`)
  }
  const line = parts.join('\t').replace(/[\r\n]+/g, '\\n')
  return line.length > LOG_LINE_MAX_CHARS ? `${line.slice(0, LOG_LINE_MAX_CHARS)}…[截断]` : line
}
