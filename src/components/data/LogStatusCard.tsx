/**
 * LOG-1 · 日志状态卡（数据管理面板内）。
 *
 * 这一块存在的唯一理由：**让日志去哪了、写没写成功、能不能写，全部如实可见**。
 * 之前的三种日志各写各的、谁都不说自己在哪，作者遇到问题时只能猜。
 *
 * 诚实边界（刻意不做的事）：
 * - 不显示正文/提示词（日志本身就不写它们）；
 * - sink 不可写时显示**原因**，不显示"已完成"；
 * - 下载按钮只导出**本次会话内存里的日志**（真·文件请按显示路径去打开），
 *   按钮文案照此写，不冒充"完整日志文件"。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Download, FileText, FolderOpen, Loader2, RefreshCw, ScrollText } from 'lucide-react'
import {
  clearLogEvents,
  getLogEvents,
  getLoggingStatus,
  setLogLevel,
  setLoggingEnabled,
  subscribeLogEvents,
} from '../../lib/logging/logger'
import { formatLogLine, LOG_LEVELS, type LogLevel } from '../../lib/logging/log-event'
import {
  currentRetentionDays,
  describeLogSink,
  flushLogsNow,
  getLastFlushResult,
  installLogFlush,
} from '../../lib/logging/log-flush'
import { currentLogFilename, bindLogFolder, isFsaLogSinkAvailable } from '../../lib/logging/sinks/fsa-log-sink'
import { hasDesktopLogBridge } from '../../lib/logging/sinks/desktop-log-sink'
import {
  DEFAULT_LOG_SETTINGS,
  loadLogSettings,
  saveLogSettings,
  type LogSettings,
} from '../../lib/logging/log-settings'
import type { LogSinkDescription } from '../../lib/logging/log-sink'
import { pruneAiUsageLog, usageLogStats } from '../../lib/ai/usage-log'
import { useDialog } from '../shared/Dialog'
import { downloadTextFile } from '../../lib/export/text-export'

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: '调试（最详细）',
  info: '常规',
  warn: '警告以上',
  error: '仅错误',
}

export default function LogStatusCard() {
  const dialog = useDialog()
  // 订阅日志事件：状态卡上的"内存 N 条 / 待写 M 行"必须跟着实时更新，
  // 否则作者刚点完"立即写入"看到的还是旧数字。
  useSyncExternalStore(subscribeLogEvents, getLogEvents, getLogEvents)
  const status = getLoggingStatus()
  const [sink, setSink] = useState<LogSinkDescription | null>(null)
  const [settings, setSettings] = useState<LogSettings>(() => loadLogSettings())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isFsa, setIsFsa] = useState(false)
  const [usage, setUsage] = useState<{ count: number; oldestTimestamp: number | null } | null>(null)
  const desktop = hasDesktopLogBridge()

  const refreshSink = useCallback(async () => {
    setSink(await describeLogSink())
    setIsFsa(await isFsaLogSinkAvailable())
  }, [])

  const refreshUsage = useCallback(async () => {
    setUsage(await usageLogStats())
  }, [])

  useEffect(() => {
    // 面板打开即安装调度器（幂等）：日志不至于等到卸载才落盘。
    installLogFlush()
    void refreshSink()
    void refreshUsage()
  }, [refreshSink, refreshUsage])

  const handlePruneUsage = async () => {
    const ok = await dialog.confirm({
      title: '清理用量记录',
      message: '将删除 6 个月前的 AI 用量记录（消耗统计会出现空档，导出内容也随之减少）。此操作不可撤销。',
      confirmText: '确认清理',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const deleted = await pruneAiUsageLog({ olderThanDays: 180 })
      setMessage(deleted ? `已清理 ${deleted} 条用量记录` : '没有早于 6 个月的用量记录')
      await refreshUsage()
    } finally {
      setBusy(false)
    }
  }

  const applySettings = (next: LogSettings) => {
    setSettings(next)
    saveLogSettings(next)
    setLoggingEnabled(next.enabled)
    setLogLevel(next.level)
  }

  const handleFlush = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await flushLogsNow()
      setMessage(result.ok
        ? `已写入 ${result.lines} 行（${result.sink}）`
        : `写入失败：${result.reason ?? '未知原因'}`)
      await refreshSink()
    } finally {
      setBusy(false)
    }
  }

  const handleBind = async () => {
    setBusy(true)
    setMessage('')
    try {
      const ok = await bindLogFolder()
      setMessage(ok ? '已绑定日志文件夹（写入其 log/ 子目录）' : '未绑定（取消或未授权）')
      await refreshSink()
    } finally {
      setBusy(false)
    }
  }

  const handleDownloadSession = () => {
    const text = getLogEvents().map(formatLogLine).join('\n')
    downloadTextFile(text || '（本次会话还没有日志）', `storyforge-log-session-${new Date().toISOString().slice(0, 10)}.txt`)
  }

  const lastFlush = getLastFlushResult()
  const writable = sink?.writable ?? false

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-bg-elevated p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-text-primary">
            <ScrollText className="h-3.5 w-3.5 text-teal-400" />运行日志
          </div>
          <span className={`text-[11px] ${writable ? 'text-text-muted' : 'text-warning'}`}>
            {writable ? '可写入' : '当前不可写'}
          </span>
        </div>

        <dl className="mt-2 space-y-1 text-[11px] text-text-muted">
          <div className="flex gap-2">
            <dt className="w-20 flex-shrink-0">写入位置</dt>
            <dd className="min-w-0 break-all text-text-secondary">
              {sink ? sink.label : '（读取中…）'}
              {sink?.reason ? ` · ${sink.reason}` : ''}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 flex-shrink-0">今日文件</dt>
            <dd className="text-text-secondary">{currentLogFilename()}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 flex-shrink-0">内存/待写</dt>
            <dd className="text-text-secondary">
              {status.ringSize} 条事件 · {status.queuedLines} 行待落盘 · 保留 {currentRetentionDays()} 天
            </dd>
          </div>
          {lastFlush && (
            <div className="flex gap-2">
              <dt className="w-20 flex-shrink-0">上次写入</dt>
              <dd className={lastFlush.ok ? 'text-text-secondary' : 'text-warning'}>
                {lastFlush.ok ? `成功 ${lastFlush.lines} 行` : `失败 · ${lastFlush.reason ?? '未知原因'}`}
              </dd>
            </div>
          )}
        </dl>

        {!writable && !desktop && (
          <p className="mt-2 flex items-start gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
            <AlertTriangle className="mt-[2px] h-3 w-3 flex-shrink-0" />
            浏览器无法自行创建目录：请先绑定一个本地文件夹，日志会写进它的 log/ 子目录。桌面版会写在应用目录下。
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleFlush()}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}立即写入
          </button>
          <button
            type="button"
            onClick={handleDownloadSession}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            <Download className="h-3 w-3" />下载本次会话日志
          </button>
          {!desktop && (
            <button
              type="button"
              onClick={() => void handleBind()}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <FolderOpen className="h-3 w-3" />{isFsa ? '更换日志文件夹' : '绑定日志文件夹'}
            </button>
          )}
          <button
            type="button"
            onClick={() => { clearLogEvents(); setMessage('已清空内存日志（不影响已写入的文件）') }}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            <FileText className="h-3 w-3" />清空内存
          </button>
        </div>

        {message && <p className="mt-2 text-[11px] text-text-secondary">{message}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2 text-[11px] text-text-muted">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={event => applySettings({ ...settings, enabled: event.target.checked })}
              className="accent-accent"
            />
            开启日志
          </label>
          <label className="flex items-center gap-1">
            级别
            <select
              value={settings.level}
              onChange={event => applySettings({ ...settings, level: event.target.value as LogLevel })}
              className="rounded border border-border bg-bg-base px-1 py-0.5 text-[11px] text-text-primary"
            >
              {LOG_LEVELS.map(level => (
                <option key={level} value={level}>{LEVEL_LABELS[level]}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            保留
            <input
              type="number"
              min={1}
              max={365}
              value={settings.retentionDays}
              onChange={event => applySettings({ ...settings, retentionDays: Number(event.target.value) || DEFAULT_LOG_SETTINGS.retentionDays })}
              className="w-14 rounded border border-border bg-bg-base px-1 py-0.5 text-[11px] text-text-primary"
            />
            天
          </label>
        </div>

        {/* 用量记录（aiUsageLog）：它是作品数据、导出包含它，**绝不自动裁剪**，
            只提供"我确认要删"的入口 —— 自动删历史就是静默丢用户数据。 */}
        <div className="mt-3 border-t border-border pt-2 text-[11px] text-text-muted">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              用量记录 {usage ? `${usage.count} 条` : '（读取中…）'}
              {usage?.oldestTimestamp ? `，最早 ${new Date(usage.oldestTimestamp).toLocaleDateString('zh-CN')}` : ''}
            </span>
            <button
              type="button"
              onClick={() => void handlePruneUsage()}
              disabled={busy || !usage?.count}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              清理 6 个月前的用量记录
            </button>
          </div>
          <p className="mt-1 text-[11px] text-text-muted/80">
            用量记录属于作品数据（消耗统计与导出都会用到），因此**不会自动删除**，只在这里手动清理。
          </p>
        </div>
      </div>
    </div>
  )
}
