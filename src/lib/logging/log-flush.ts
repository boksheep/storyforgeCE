/**
 * LOG-1 · 落盘调度（定时 / 阈值 / 隐藏页 / 出错立即写）。
 *
 * 为什么需要调度而不是"每条都写"：浏览器写文件是异步且可能弹权限，逐条写会把生成流程拖慢；
 * 但只靠定时又会让"刚崩掉那一刻"的日志丢失。因此四条触发条件并存：
 *   ① 队列 ≥ `LOG_FLUSH_THRESHOLD` 行 → 立即写；
 *   ② 每 `LOG_FLUSH_INTERVAL_MS` 兜底写一次；
 *   ③ 页面转隐藏 / 卸载（`visibilitychange` / `pagehide`）→ 写一次；
 *   ④ `error` 级事件 → 立即写（错误永不等待定时器）。
 *
 * 并发：同一时刻只允许一个写入 Promise（`inFlight`），避免两个 flush 争抢同一文件句柄。
 * 失败：保留队列原样、记一条**只进内存不排队**的系统事件，并让状态卡显示失败原因 ——
 * 绝不假装写成功（`noneLogSink.append` 直接返回 false，调用方由此得知）。
 */
import { logEvent, peekPendingLines, dropPendingLines, shouldLog, subscribeLogEvents } from './logger'
import { LOG_RETENTION_DAYS_DEFAULT, noneLogSink, type LogSink, type LogSinkDescription } from './log-sink'
import { desktopLogSink, hasDesktopLogBridge } from './sinks/desktop-log-sink'
import { fsaLogSink, isFsaLogSinkAvailable } from './sinks/fsa-log-sink'
import { loadLogSettings } from './log-settings'

export const LOG_FLUSH_INTERVAL_MS = 60_000

export interface LogFlushResult {
  ok: boolean
  lines: number
  sink: LogSink['id']
  reason?: string
}

let inFlight: Promise<LogFlushResult> | null = null
let lastResult: LogFlushResult | null = null
let cleanup: (() => void) | null = null
/**
 * 没有可用 sink（浏览器未绑定文件夹、非桌面）时的"安静模式"。
 *
 * 作者反馈："日志内有大量写入失败，不知道什么情况"。原因是每 60 秒的定时 flush 都会失败一次、
 * 每次都写一条 `log.flush.failed`，于是一屏全是它 —— 而状态卡里早就写着"当前不可写"。
 * 现在这种情形**只报一次**（info 级，说明原因与解法），之后安静地把行留在队列里；
 * 一旦真的绑定了文件夹（sink 变了），立刻恢复正常的失败重试与报告。
 */
let noSinkReported = false

export function getLastFlushResult(): LogFlushResult | null {
  return lastResult
}

/** 环境决定用哪个 sink：桌面桥优先，其次绑定文件夹，最后"可见地什么都不做"。 */
export async function resolveLogSink(): Promise<LogSink> {
  if (hasDesktopLogBridge()) return desktopLogSink
  if (await isFsaLogSinkAvailable()) return fsaLogSink
  return noneLogSink
}

export async function describeLogSink(): Promise<LogSinkDescription> {
  const sink = await resolveLogSink()
  return await sink.describe()
}

/**
 * 写入一批日志（默认写当前队列全部行）。串行、失败保留队列。
 */
export async function flushLogs(): Promise<LogFlushResult> {
  if (inFlight) return await inFlight
  inFlight = (async (): Promise<LogFlushResult> => {
    const sink = await resolveLogSink()
    const lines = peekPendingLines()
    if (lines.length === 0) {
      const empty: LogFlushResult = { ok: true, lines: 0, sink: sink.id }
      lastResult = empty
      return empty
    }
    const ok = await sink.append(lines)
    if (ok) {
      dropPendingLines(lines.length)
      noSinkReported = false   // 能写了就恢复正常的失败报告
      const settings = loadLogSettings()
      // 清理失败不改变"写入成功"的事实，但会记一条内存事件便于排查
      try {
        await sink.prune(settings.retentionDays)
      } catch {
        // 忽略：prune 内部已逐文件 try/catch
      }
      const result: LogFlushResult = { ok: true, lines: lines.length, sink: sink.id }
      lastResult = result
      return result
    }
    // 失败：只记内存事件（skipQueue），否则"写不出去"会生成新日志再失败。
    const noSink = sink.id === 'none'
    if (!noSink || !noSinkReported) {
      if (noSink) noSinkReported = true
      logEvent({
        level: noSink ? 'info' : 'warn',
        tag: 'Logging',
        event: 'log.flush.failed',
        message: noSink
          ? `当前环境没有可写的日志位置（未绑定本地文件夹、也不是桌面版）：已保留 ${lines.length} 行在内存队列里，绑定文件夹后会自动写入。此后不再重复提示。`
          : `日志写入失败（sink=${sink.id}），已保留 ${lines.length} 行待重试`,
        skipQueue: true,
      })
    }
    const result: LogFlushResult = {
      ok: false,
      lines: 0,
      sink: sink.id,
      reason: noSink ? '未配置日志文件夹' : '写入被拒绝或失败',
    }
    lastResult = result
    return result
  })().finally(() => { inFlight = null })
  return await inFlight
}

/**
 * 安装调度器。返回卸载函数（测试与热更新都会用）。
 */
export function installLogFlush(options: { intervalMs?: number; now?: () => number } = {}): () => void {
  if (cleanup) return cleanup
  const intervalMs = options.intervalMs ?? LOG_FLUSH_INTERVAL_MS

  const timer = setInterval(() => { void flushLogs() }, intervalMs)

  const onHidden = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void flushLogs()
  }
  const onPageHide = () => { void flushLogs() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden)
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  // error 级事件立即写（阈值之上由 logger 侧维护，这里只处理级别）
  const unsubscribe = subscribeLogEvents(() => {
    // 只在"确实有 error 级行在队列里"时触发，避免每条日志都打一次 flush。
    // 级别列格式是 `[error]`（见 log-event.formatLogLine）—— 两处必须同步改。
    const pending = peekPendingLines()
    if (pending.some(line => line.includes('\t[error]\t')) && shouldLog('error')) void flushLogs()
  })

  cleanup = () => {
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden)
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    unsubscribe()
    cleanup = null
  }
  return cleanup
}

/** 手动"立即写入"（状态卡按钮）。 */
export async function flushLogsNow(): Promise<LogFlushResult> {
  return await flushLogs()
}

/** 保留天数（状态卡显示用）。 */
export function currentRetentionDays(): number {
  return loadLogSettings().retentionDays || LOG_RETENTION_DAYS_DEFAULT
}
