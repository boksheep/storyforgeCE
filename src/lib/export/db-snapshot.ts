/**
 * IndexedDB 全库便携快照。
 *
 * 这是面向跨设备的可迁移格式，不是 Dexie 内部 raw dump：项目数据仍经
 * PROJECT_TABLES 派生的 JSON 导出/导入，因此自增 ID 和跨表引用会在目标库重新映射。
 * 临时导入表、派生缓存、日志和全局系统配置不进入快照。
 */
import { db } from '../db/schema'
import { log } from '../logging/logger'
import { exportProjectJSON, importProjectJSON, type ProjectExportData } from './json-export'
import { exportSettingsSnapshot, importSettingsSnapshot, type SettingsSnapshot } from './settings-snapshot'

export const DB_SNAPSHOT_KIND = 'storyforge-indexeddb-snapshot'
export const DB_SNAPSHOT_VERSION = 2
export const LEGACY_DB_SNAPSHOT_VERSION = 1

export interface IndexedDBSnapshot {
  kind: typeof DB_SNAPSHOT_KIND
  version: number
  exportedAt: number
  projects: ProjectExportData[]
  settings: SettingsSnapshot
}

export async function exportIndexedDBSnapshot(includeSensitiveSettings = false): Promise<IndexedDBSnapshot> {
  const startedAt = Date.now()
  const projects = await db.projects.orderBy('updatedAt').reverse().toArray()
  const snapshots: ProjectExportData[] = []
  for (const project of projects) {
    if (project.id == null) continue
    snapshots.push(await exportProjectJSON(project.id))
  }
  const result: IndexedDBSnapshot = {
    kind: DB_SNAPSHOT_KIND,
    version: DB_SNAPSHOT_VERSION,
    exportedAt: Date.now(),
    projects: snapshots,
    settings: exportSettingsSnapshot(includeSensitiveSettings),
  }
  log.info('DbSnapshot', 'snapshot.export.completed', '全库便携快照已装配', {
    projectCount: snapshots.length, includeSensitiveSettings, durationMs: Date.now() - startedAt,
  })
  return result
}

export function parseIndexedDBSnapshot(value: unknown): IndexedDBSnapshot {
  if (!value || typeof value !== 'object') throw new Error('无效的 IndexedDB 快照')
  const candidate = value as Partial<IndexedDBSnapshot>
  if (candidate.kind !== DB_SNAPSHOT_KIND ||
      (candidate.version !== DB_SNAPSHOT_VERSION && candidate.version !== LEGACY_DB_SNAPSHOT_VERSION) ||
      !Array.isArray(candidate.projects)) {
    throw new Error('快照格式或版本不受支持')
  }
  if (candidate.version === DB_SNAPSHOT_VERSION && (!candidate.settings || typeof candidate.settings !== 'object')) {
    throw new Error('快照缺少设置数据')
  }
  if (candidate.projects.some(project => !project || typeof project !== 'object' || !project.version || !project.project)) {
    throw new Error('快照中包含无效项目数据')
  }
  return {
    ...candidate,
    settings: candidate.settings ?? { safe: {} },
  } as IndexedDBSnapshot
}

/** 导入为新项目；任何现有项目都不会被覆盖。设置会覆盖当前浏览器的对应偏好。 */
export async function importIndexedDBSnapshot(snapshot: IndexedDBSnapshot, includeSensitiveSettings = false): Promise<number[]> {
  const startedAt = Date.now()
  const ids: number[] = []
  for (const project of snapshot.projects) ids.push(await importProjectJSON(project))
  importSettingsSnapshot(snapshot.settings, includeSensitiveSettings)
  log.info('DbSnapshot', 'snapshot.import.completed', '全库便携快照导入已结束', {
    sourceProjectCount: snapshot.projects.length, importedProjectCount: ids.length,
    includeSensitiveSettings, durationMs: Date.now() - startedAt,
  })
  return ids
}

export function downloadIndexedDBSnapshot(snapshot: IndexedDBSnapshot, filename: string): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
