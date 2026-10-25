import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { exportProjectJSON, importProjectJSON } from '../lib/export/json-export'
import type { Snapshot } from '../lib/types'
import { log } from '../lib/logging/logger'

/** 每个项目最多保留的快照数量 */
const MAX_SNAPSHOTS_PER_PROJECT = 20
/** 自动备份间隔（毫秒）— 5 分钟 */
export const AUTO_BACKUP_INTERVAL = 5 * 60 * 1000

interface BackupStore {
  snapshots: Snapshot[]
  loading: boolean

  /** 加载某个项目的所有快照（按时间倒序） */
  loadSnapshots: (projectId: number) => Promise<void>

  /** 创建快照 */
  createSnapshot: (projectId: number, label: string, type: 'auto' | 'manual') => Promise<number>

  /** 删除快照 */
  deleteSnapshot: (id: number) => Promise<void>

  /** 从快照恢复 — 返回新创建的项目 ID */
  restoreSnapshot: (snapshotId: number) => Promise<number>

  /** 清理旧快照（保留最新 MAX 条） */
  pruneSnapshots: (projectId: number) => Promise<void>
}

export const useBackupStore = create<BackupStore>((set, get) => ({
  snapshots: [],
  loading: false,

  loadSnapshots: async (projectId: number) => {
    set({ loading: true })
    const snapshots = await db.snapshots
      .where('projectId')
      .equals(projectId)
      .reverse()
      .sortBy('createdAt')
    set({ snapshots, loading: false })
  },

  createSnapshot: async (projectId: number, label: string, type: 'auto' | 'manual') => {
    // 序列化整个项目
    const exportData = await exportProjectJSON(projectId)
    const jsonStr = JSON.stringify(exportData)
    const snapshotSize = new Blob([jsonStr]).size

    const id = await db.snapshots.add({
      projectId,
      label,
      type,
      data: jsonStr,
      size: snapshotSize,
      createdAt: Date.now(),
    } as Snapshot) as number

    // 清理旧的自动快照
    await get().pruneSnapshots(projectId)
    // 刷新列表
    await get().loadSnapshots(projectId)

    // 快照是把整份作品重新序列化存档（用户看不到背后规模），记下大小与去向。
    log.info(
      'BackupStore',
      'backup.snapshot.created',
      `已创建快照 #${id}（${type}，${snapshotSize} 字节）`,
      { projectId, snapshotId: id, size: snapshotSize, type },
    )

    return id
  },

  deleteSnapshot: async (id: number) => {
    const snap = await db.snapshots.get(id)
    await db.snapshots.delete(id)
    // 删除快照=丢掉一份恢复点，属不可逆操作：只记 id 与规模。
    log.warn(
      'BackupStore',
      'backup.snapshot.deleted',
      `已删除快照 #${id}${snap ? `（项目 #${snap.projectId}，${snap.type}）` : ''}`,
      { projectId: snap?.projectId ?? 0, snapshotId: id, type: snap?.type ?? '' },
    )
    if (snap) {
      await get().loadSnapshots(snap.projectId)
    }
  },

  restoreSnapshot: async (snapshotId: number) => {
    const snap = await db.snapshots.get(snapshotId)
    if (!snap) throw new Error('快照不存在')

    const exportData = JSON.parse(snap.data)
    const newProjectId = await importProjectJSON(exportData)
    return newProjectId
  },

  pruneSnapshots: async (projectId: number) => {
    // 分别处理自动和手动快照
    const autoSnaps = await db.snapshots
      .where('projectId')
      .equals(projectId)
      .filter((s) => s.type === 'auto')
      .reverse()
      .sortBy('createdAt')

    if (autoSnaps.length > MAX_SNAPSHOTS_PER_PROJECT) {
      const toDelete = autoSnaps.slice(MAX_SNAPSHOTS_PER_PROJECT)
      await db.snapshots.bulkDelete(toDelete.map((s) => s.id!))
      // 自动快照超限被清：属于"系统替作者删"的不可逆动作，必须留痕。
      log.warn(
        'BackupStore',
        'backup.snapshot.pruned',
        `清理自动快照 ${toDelete.length} 个（保留最新 ${MAX_SNAPSHOTS_PER_PROJECT} 个）`,
        { projectId, count: toDelete.length, keep: MAX_SNAPSHOTS_PER_PROJECT },
      )
    }
  },
}))
