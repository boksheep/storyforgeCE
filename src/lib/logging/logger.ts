/**
 * LOG-1 · 统一日志入口（内存环形 + 待落盘队列 + 级别过滤）。
 *
 * 分工：
 * - 本文件**只管收集**：级别过滤 → 事件归一 → 环形缓冲（应用内查看）→ 待落盘队列（txt）。
 * - 落盘由 `log-flush.ts` + `log-sink.ts` 负责（环境决定写到桌面应用目录还是绑定文件夹）。
 * - 旧 `ai/logger.ts` 保留为"AI 连接日志"的薄适配层（它的面板与 `AIConnectionLogPanel` 不变），
 *   但它写下的每条记录同时进这里，于是"另存 txt"与"连接日志面板"不再是两份互不相干的事实。
 *
 * 这不是第四套日志：`aiUsageLog` 表继续存用量（消耗统计页不变），诊断 JSON 导出继续用它自己的
 * 隐私块；它们都改成**同时**产出这里的 LogEvent。
 */
import { createLogEvent, formatLogLine, type LogEvent, type LogEventInput, type LogLevel } from './log-event'
import type { LogTag } from './log-tags'

/** 应用内可回看的事件条数（旧 `ai/logger.ts` 只有 50，且只覆盖 AI 连接）。 */
export const LOG_RING_MAX = 500
/** 待落盘队列上限：写不出去时（未绑定文件夹）也不会无限涨。 */
export const LOG_QUEUE_MAX = 5_000
/** 达到这个行数就立刻 flush（正常情况下由定时器兜底）。 */
export const LOG_FLUSH_THRESHOLD = 50

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let ring: LogEvent[] = []
let queue: string[] = []
let listeners = new Set<() => void>()
let minLevel: LogLevel = 'info'
let enabled = true

export interface LoggingStatus {
  enabled: boolean
  level: LogLevel
  ringSize: number
  queuedLines: number
}

export function getLoggingStatus(): LoggingStatus {
  return { enabled, level: minLevel, ringSize: ring.length, queuedLines: queue.length }
}

export function setLoggingEnabled(next: boolean): void {
  enabled = next
  notify()
}

export function isLoggingEnabled(): boolean {
  return enabled
}

export function setLogLevel(next: LogLevel): void {
  minLevel = next
  notify()
}

export function getLogLevel(): LogLevel {
  return minLevel
}

export function shouldLog(level: LogLevel, threshold: LogLevel = minLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[threshold]
}

/** 收集一个事件。返回被接受的事件；未通过级别过滤或被关闭时返回 null。 */
export function logEvent(input: LogEventInput): LogEvent | null {
  if (!enabled) return null
  if (!shouldLog(input.level)) return null
  const event = createLogEvent(input)
  ring = [event, ...ring].slice(0, LOG_RING_MAX)
  if (!input.skipQueue) {
    queue.push(formatLogLine(event))
    if (queue.length > LOG_QUEUE_MAX) queue = queue.slice(queue.length - LOG_QUEUE_MAX)
  }
  notify()
  return event
}

/** 关联 id：把"同一次调用"在连接日志 / 运行日志 / 用量记录三条通道上串起来。 */
export function newCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 便捷 API：`log.info('AI', 'ai.request.ok', '完成', { model })`。 */
export const log = {
  debug: (tag: LogTag, event: string, message?: string, meta?: Record<string, unknown>) =>
    logEvent({ level: 'debug', tag, event, message, meta }),
  info: (tag: LogTag, event: string, message?: string, meta?: Record<string, unknown>) =>
    logEvent({ level: 'info', tag, event, message, meta }),
  warn: (tag: LogTag, event: string, message?: string, meta?: Record<string, unknown>) =>
    logEvent({ level: 'warn', tag, event, message, meta }),
  error: (tag: LogTag, event: string, message?: string, meta?: Record<string, unknown>, error?: unknown) =>
    logEvent({ level: 'error', tag, event, message, meta, error }),
}

export function getLogEvents(): readonly LogEvent[] {
  return ring
}

export function subscribeLogEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function clearLogEvents(): void {
  ring = []
  notify()
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 监听器自身出错不应影响写日志（否则日志系统会变成故障放大器）
    }
  }
}

/** 取出当前全部待落盘行（sink 写入成功后由调用方 commit；失败则原样保留）。 */
export function peekPendingLines(): string[] {
  return [...queue]
}

/** 丢弃已成功写入的前 N 行。 */
export function dropPendingLines(count: number): void {
  if (count <= 0) return
  queue = queue.slice(count)
  notify()
}

/** 清空待落盘队列（仅用于测试与"放弃本次日志"）。 */
export function clearPendingLines(): void {
  queue = []
  notify()
}

/** 仅测试用：把模块状态复位到默认值。 */
export function resetLoggingForTest(): void {
  ring = []
  queue = []
  listeners = new Set()
  minLevel = 'info'
  enabled = true
}
