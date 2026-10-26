import { buildLocalDiagnosticReport, type LocalDiagnosticReport } from './local-diagnostic-report'
import { explainCommonError } from './error-guide'
import { getLogEvents, getLoggingStatus } from '../logging/logger'
import { sanitizeError, type LogEvent } from '../logging/log-event'
import { getRecentOperations } from '../history/operation-trace'
import { APP_BUILD_ID } from '../version'

export interface SafeLogLine {
  time: string
  level: LogEvent['level']
  tag: string
  event: string
  numbers?: Record<string, number | boolean>
  error?: ReturnType<typeof sanitizeError>
}

/** 原始日志 message/meta 可能含书名、正文或密钥；下载包只取机器事件键和数值。 */
export function todaySafeLogTail(now = new Date(), events: readonly LogEvent[] = getLogEvents()): SafeLogLine[] {
  const sameDay = (ts: number) => {
    const date = new Date(ts)
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  }
  return events.filter(event => sameDay(event.ts)).slice(0, 100).reverse().map(event => {
    const numbers = Object.fromEntries(Object.entries(event.meta ?? {})
      .filter((entry): entry is [string, number | boolean] => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(entry[0])
        && (typeof entry[1] === 'number' || typeof entry[1] === 'boolean')))
    return {
      time: event.iso, level: event.level, tag: String(event.tag),
      event: /^[a-z][a-z0-9.-]{0,79}$/.test(event.event) ? event.event : 'unclassified',
      ...(Object.keys(numbers).length ? { numbers } : {}),
      ...(event.error ? { error: {
        name: /^[A-Za-z][A-Za-z0-9]*Error$/.test(event.error.name) ? event.error.name : 'Error',
        frames: event.error.frames.slice(0, 8),
      } } : {}),
    }
  })
}

export async function buildErrorDiagnosticBundle(error: unknown) {
  let diagnostics: LocalDiagnosticReport | null = null
  let diagnosticStatus: 'complete' | 'unavailable' = 'complete'
  try { diagnostics = await buildLocalDiagnosticReport() }
  catch { diagnosticStatus = 'unavailable' }
  const logs = todaySafeLogTail()
  const lastRescue = [...logs].reverse().find(line => line.tag === 'RescueVault' && line.event === 'rescue.write')
  return {
    format: 'storyforge-error-diagnostics',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    applicationVersion: APP_BUILD_ID,
    error: {
      ...sanitizeError(error),
      guide: explainCommonError(error)?.code ?? null,
    },
    diagnostics,
    diagnosticStatus,
    logging: getLoggingStatus(),
    todayLogs: logs,
    recentOperations: getRecentOperations(100),
    dataProtection: {
      storagePersisted: diagnostics?.storage.persisted ?? null,
      lastRescueWriteAt: lastRescue?.time ?? null,
      desktopBackupBridgePresent: typeof window !== 'undefined' && Boolean(window.__sfBackup),
      projectContentsIncluded: false,
    },
    sources: {
      todayLogs: '当前页面的统一日志内存环；刷新前较早日志可能不可用，最多最后100行',
      recentOperations: '当前标签页步骤操作轨迹；不包含输入值或正文，最多最后100步',
    },
    privacy: { includesRecordContents: false, includesApiKeys: false, automaticallyUploaded: false },
  }
}
