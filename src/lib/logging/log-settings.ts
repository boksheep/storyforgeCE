/**
 * LOG-1 · 日志设置（机器级偏好，localStorage）。
 *
 * 为什么不进 IndexedDB / 项目 JSON：与上下文预算策略（`storyforge-context-budget-policy`）、
 * 汇率（`sf-usd-cny-rate`）同一类 —— **本机偏好**，不是作品数据：
 * 不进导出、不迁移、换机器重新设一次即可。
 */
import { LOG_LEVELS, type LogLevel } from './log-event'
import { LOG_RETENTION_DAYS_DEFAULT } from './log-sink'

export const LOG_SETTINGS_KEY = 'storyforge-logging-settings'

export interface LogSettings {
  enabled: boolean
  level: LogLevel
  retentionDays: number
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  enabled: true,
  level: 'info',
  retentionDays: LOG_RETENTION_DAYS_DEFAULT,
}

function clampRetention(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return LOG_RETENTION_DAYS_DEFAULT
  return Math.min(365, Math.max(1, Math.floor(parsed)))
}

function clampLevel(value: unknown): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel) ? value as LogLevel : DEFAULT_LOG_SETTINGS.level
}

/** 读设置；损坏/缺失时回落默认值（不抛错，日志系统不该成为启动失败的原因）。 */
export function loadLogSettings(): LogSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_LOG_SETTINGS }
  try {
    const raw = localStorage.getItem(LOG_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_LOG_SETTINGS }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      enabled: parsed.enabled === undefined ? DEFAULT_LOG_SETTINGS.enabled : parsed.enabled !== false,
      level: clampLevel(parsed.level),
      retentionDays: clampRetention(parsed.retentionDays),
    }
  } catch {
    return { ...DEFAULT_LOG_SETTINGS }
  }
}

export function saveLogSettings(settings: LogSettings): void {
  if (typeof localStorage === 'undefined') return
  const next: LogSettings = {
    enabled: settings.enabled !== false,
    level: clampLevel(settings.level),
    retentionDays: clampRetention(settings.retentionDays),
  }
  try {
    localStorage.setItem(LOG_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式/配额满：忽略，保持默认行为
  }
}
