/**
 * 跨设备快照中的浏览器设置白名单。
 * 只收集应用设置，不把任意 localStorage 内容带出；API Key/PAT 等必须显式允许。
 */
import { log } from '../logging/logger'

export const SAFE_SETTING_KEYS = [
  'storyforge-ai-config',
  'storyforge-ai-presets',
  'storyforge-embedding-config',
  'storyforge-ai-task-routes',
  'storyforge-agent-context-profiles',
  'storyforge-agent-team-budget-profile',
  'storyforge-agent-team-budget-tokens',
  'storyforge-context-budget-policy',
  'storyforge-context-budget-presets',
  'storyforge-theme',
  'storyforge-editor-typography',
  'sf_lang',
  'storyforge-logging-settings',
  'sf-gist-auto',
] as const

export const SENSITIVE_SETTING_KEYS = [
  'storyforge-ai-api-key-session',
  'storyforge-embedding-key-session',
  'sf-gist-pat',
  'sf-gist-user',
  'storyforge-ai-config',
  'storyforge-embedding-config',
] as const

export type SettingsSnapshot = {
  safe: Record<string, string>
  sensitive?: Record<string, { storage: 'local' | 'session'; value: string }>
}

function isSensitiveProperty(key: string): boolean {
  return /api.?key|pat|token|secret|password/i.test(key)
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveProperty(key) ? '' : redact(item),
  ]))
}

function safeValue(key: string, raw: string): string {
  if (!SENSITIVE_SETTING_KEYS.includes(key as never)) return raw
  try { return JSON.stringify(redact(JSON.parse(raw))) }
  catch (error) {
    log.warn('ExportSettings', 'export.settings.redact.failed', '敏感设置无法解析，导出值置空', {
      key, valueLength: raw.length, errorName: error instanceof Error ? error.name : typeof error,
    })
    return ''
  }
}

function readStorage(storage: Storage, key: string): string | null {
  try { return storage.getItem(key) } catch (error) {
    log.warn('ExportSettings', 'export.settings.read.failed', '设置项读取失败，快照跳过该项', {
      key, errorName: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
}

export function exportSettingsSnapshot(includeSensitive = false): SettingsSnapshot {
  const safe: Record<string, string> = {}
  for (const key of SAFE_SETTING_KEYS) {
    const raw = readStorage(localStorage, key)
    if (raw != null) safe[key] = safeValue(key, raw)
  }

  if (!includeSensitive) {
    log.info(
      'ExportSettings',
      'export.settings.snapshot',
      `导出设置快照：收集 ${Object.keys(safe).length} 项（未包含敏感凭据）`,
      { safeKeys: Object.keys(safe).length, includeSensitive: false },
    )
    return { safe }
  }

  const sensitive: SettingsSnapshot['sensitive'] = {}
  for (const key of SENSITIVE_SETTING_KEYS) {
    for (const [storageName, storage] of [['local', localStorage], ['session', sessionStorage] ] as const) {
      const raw = readStorage(storage, key)
      if (raw != null) sensitive[key] = { storage: storageName, value: raw }
    }
  }
  // 记键名与存储位置，不记值 —— 这是"用户知道带出了什么"的最小必需信息。
  log.warn(
    'ExportSettings',
    'export.settings.snapshot.sensitive',
    `导出设置快照（含敏感凭据）：${Object.keys(sensitive).length} 项凭据将写入快照文件`,
    {
      sensitiveKeys: Object.keys(sensitive).join(','),
      storages: Object.values(sensitive).map(s => s.storage).join(','),
    },
  )
  return { safe, sensitive }
}

export function hasSensitiveSettings(snapshot: SettingsSnapshot): boolean {
  return Object.keys(snapshot.sensitive ?? {}).length > 0
}

function mergePreservingSensitive(key: string, incoming: string): string {
  if (!SENSITIVE_SETTING_KEYS.includes(key as never)) return incoming
  try {
    const next = JSON.parse(incoming) as Record<string, unknown>
    const currentRaw = localStorage.getItem(key)
    const current = currentRaw ? JSON.parse(currentRaw) as Record<string, unknown> : {}
    for (const property of ['apiKey', 'token', 'pat', 'secret', 'password']) {
      if (typeof current[property] === 'string' && current[property]) next[property] = current[property]
    }
    return JSON.stringify(next)
  } catch (error) {
    log.warn('ExportSettings', 'export.settings.merge.failed', '保留敏感设置时解析失败，使用导入值', {
      key, valueLength: incoming.length, errorName: error instanceof Error ? error.name : typeof error,
    })
    return incoming
  }
}

export function importSettingsSnapshot(snapshot: SettingsSnapshot, includeSensitive = false): void {
  const failedKeys: string[] = []
  let written = 0
  for (const key of SAFE_SETTING_KEYS) {
    const value = snapshot.safe?.[key]
    if (typeof value !== 'string') continue
    try {
      localStorage.setItem(key, mergePreservingSensitive(key, value))
      written++
    } catch (_err) {
      // 以前这里是静默 `catch { /* storage unavailable */ }`：
      // 导入"成功"返回但设置其实没落盘，用户换机后以为配置已迁移。
      failedKeys.push(key)
      // err.message 不写进日志：存储写入出错一般可自愈，且错误串可能夹带非预期文本。
      log.warn(
        'ExportSettings',
        'export.settings.write.failed',
        `设置快照导入：写入 ${key} 失败（存储不可用或配额已满）`,
        { key, valueLength: value.length },
      )
    }
  }
  if (!includeSensitive || !snapshot.sensitive) {
    log.info(
      'ExportSettings',
      'export.settings.imported',
      `设置快照导入完成：写入 ${written} 项，敏感项未包含`,
      { written, failed: failedKeys.length, includeSensitive: false },
    )
    return
  }
  let sensitiveWritten = 0
  for (const [key, item] of Object.entries(snapshot.sensitive)) {
    if (!SENSITIVE_SETTING_KEYS.includes(key as never)) continue
    try {
      const storage = item.storage === 'session' ? sessionStorage : localStorage
      storage.setItem(key, item.value)
      sensitiveWritten++
    } catch {
      failedKeys.push(key)
      log.warn(
        'ExportSettings',
        'export.settings.write.failed',
        `设置快照导入：写入敏感项 ${key} 到 ${item.storage}Storage 失败`,
        { key, storage: item.storage },
      )
    }
  }
  // 只记键名与计数，绝不记凭据值本身（见 settings-snapshot 的脱敏契约）。
  log.info(
    'ExportSettings',
    'export.settings.imported',
    `设置快照导入完成：普通项 ${written} 项、敏感项 ${sensitiveWritten} 项`,
    { written, sensitiveWritten, failed: failedKeys.length, failedKeys: failedKeys.join(',') },
  )
}
