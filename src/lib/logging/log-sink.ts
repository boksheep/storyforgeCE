/**
 * LOG-1 · 落盘契约与文件规则（纯逻辑）。
 *
 * 两个 sink（桌面应用目录 / 浏览器绑定文件夹）共用同一套文件名、轮转与保留规则，
 * 这样"同一份格式"不是靠人肉对齐，而是同一段代码。
 */
import { LOG_LINE_MAX_CHARS } from './log-event'

export type LogSinkId = 'desktop' | 'fsa' | 'none'

export interface LogSinkDescription {
  id: LogSinkId
  /** 人能看懂的位置描述（桌面：真实绝对路径；浏览器：绑定文件夹名或"未绑定"）。 */
  label: string
  /** 绝对路径（仅桌面有；浏览器出于安全不暴露）。 */
  path?: string
  /** 当前是否真的能写（未授权/只读时为 false，UI 必须如实显示）。 */
  writable: boolean
  /** 不可写时的原因（用于状态卡与日志自身）。 */
  reason?: string
}

export interface LogSink {
  id: LogSinkId
  describe(): Promise<LogSinkDescription>
  /** 按顺序追加若干行；返回是否全部写入成功。 */
  append(lines: readonly string[]): Promise<boolean>
  /** 删除早于保留窗口的日志文件，返回删除数量。 */
  prune(keepDays: number): Promise<number>
}

export const LOG_DIR_NAME = 'log'
export const LOG_FILE_PREFIX = 'storyforge-'
export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024
export const LOG_RETENTION_DAYS_DEFAULT = 14

/**
 * 当日文件名（含滚动序号）。`index` 从 1 开始；`index === 1` 时**不带后缀**，
 * 保持"今天就是 storyforge-YYYY-MM-DD.txt"这个直觉。
 */
export function buildLogFilename(date: Date, index = 1): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return index <= 1 ? `${LOG_FILE_PREFIX}${day}.txt` : `${LOG_FILE_PREFIX}${day}-${index}.txt`
}

/** 解析我方日志文件名 → 日期键；不是我们的文件返回 null（**绝不通配删除别人的文件**）。 */
export function parseLogFilename(name: string): { day: string; index: number } | null {
  const match = /^storyforge-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.txt$/.exec(name)
  if (!match) return null
  return { day: match[1], index: match[2] ? Number(match[2]) : 1 }
}

/** 是否早于保留窗口（按自然日比较，不做时区花活）。 */
export function isExpiredLogFile(name: string, now: Date, keepDays: number): boolean {
  const parsed = parseLogFilename(name)
  if (!parsed) return false
  const keep = Math.max(1, Math.floor(keepDays))
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keep - 1))
  const fileDate = new Date(`${parsed.day}T00:00:00`)
  if (Number.isNaN(fileDate.getTime())) return false
  return fileDate.getTime() < cutoff.getTime()
}

/** 估算一行写入后的字节数（UTF-8；中文 3 字节，用于滚动判断，不必绝对精确）。 */
export function estimateLineBytes(line: string): number {
  const clipped = line.length > LOG_LINE_MAX_CHARS ? LOG_LINE_MAX_CHARS : line.length
  // 粗略：非 ASCII 记 3 字节。宁可高估，避免文件超限。
  let bytes = 1
  for (let index = 0; index < clipped; index++) {
    bytes += line.charCodeAt(index) > 0x7f ? 3 : 1
  }
  return bytes
}

export function estimateLinesBytes(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + estimateLineBytes(line), 0)
}

/** 无能力环境下的兜底 sink：**可见地**什么都不做，绝不假装写过。 */
export const noneLogSink: LogSink = {
  id: 'none',
  describe: async () => ({
    id: 'none',
    label: '未配置日志文件夹',
    writable: false,
    reason: '当前环境既没有桌面日志桥，也没有绑定本地文件夹',
  }),
  append: async () => false,
  prune: async () => 0,
}
