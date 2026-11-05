import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { exportProjectJSON, importProjectJSON } from '../lib/export/json-export'
import type { Snapshot } from '../lib/types'
import { log } from '../lib/logging/logger'
import {
  deleteCloudSnapshot as apiDeleteCloudSnapshot,
  fetchCloudSnapshot,
  getActiveConfig,
  listCloudSnapshots,
  uploadSnapshot as apiUploadSnapshot,
  type CloudSnapshotMeta,
} from '../lib/cloud/client'
import { ensureSyncUid } from '../lib/cloud/project-identity'
import { markProjectDirty } from '../lib/cloud/outbox'
import { CloudError } from '../lib/cloud/types'

/** 每个项目最多保留的快照数量 */
const MAX_SNAPSHOTS_PER_PROJECT = 20
/** 自动备份间隔（毫秒）— 5 分钟 */
export const AUTO_BACKUP_INTERVAL = 5 * 60 * 1000

interface BackupStore {
  snapshots: Snapshot[]
  loading: boolean

  /** 云端快照（**只有元数据**，来自服务器） */
  cloudSnapshots: CloudSnapshotMeta[]
  cloudLoading: boolean
  cloudError: string | null

  /** 加载某个项目的所有快照（按时间倒序） */
  loadSnapshots: (projectId: number) => Promise<void>

  /** 创建快照 */
  createSnapshot: (
    projectId: number,
    label: string,
    type: 'auto' | 'manual',
    options?: { uploadToCloud?: boolean },
  ) => Promise<number>

  /** 删除快照 */
  deleteSnapshot: (id: number) => Promise<void>

  /** 从快照恢复 — 返回新创建的项目 ID */
  restoreSnapshot: (snapshotId: number) => Promise<number>

  /** 清理旧快照（保留最新 MAX 条） */
  pruneSnapshots: (projectId: number) => Promise<void>

  // ── 云端快照 ──────────────────────────────────────────────
  /** 把某个本地快照上传到云数据库（幂等：同一快照重复上传不会产生两条） */
  uploadSnapshotToCloud: (snapshotId: number) => Promise<boolean>
  /** 拉取云端快照列表 */
  loadCloudSnapshots: (projectId: number) => Promise<void>
  /** 从云端快照恢复（新建项目） */
  restoreCloudSnapshot: (snapshotUid: string) => Promise<number>
  /** 删除云端快照（不影响本地） */
  deleteCloudSnapshot: (snapshotUid: string) => Promise<void>
}

/** 云端快照标识由客户端生成，且**先落盘再上传** —— 重试才能幂等。 */
function newSnapshotUid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function messageOf(error: unknown): string {
  if (error instanceof CloudError) return error.message
  return (error as Error)?.message ?? '未知错误'
}

export const useBackupStore = create<BackupStore>((set, get) => ({
  snapshots: [],
  loading: false,
  cloudSnapshots: [],
  cloudLoading: false,
  cloudError: null,

  loadSnapshots: async (projectId: number) => {
    set({ loading: true })
    const snapshots = await db.snapshots
      .where('projectId')
      .equals(projectId)
      .reverse()
      .sortBy('createdAt')
    set({ snapshots, loading: false })
  },

  createSnapshot: async (projectId: number, label: string, type: 'auto' | 'manual', options = {}) => {
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

    // 可选：同时上传到云数据库。失败不回滚本地快照——本地才是主副本。
    if (options.uploadToCloud) {
      try {
        await get().uploadSnapshotToCloud(id)
      } catch (error) {
        log.warn(
          'BackupStore',
          'backup.snapshot.cloud_failed',
          `快照 #${id} 上传云端失败，本地已保留`,
          { projectId, snapshotId: id, reason: messageOf(error) },
        )
      }
    }

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

  // ── 云端快照 ────────────────────────────────────────────────

  uploadSnapshotToCloud: async (snapshotId: number) => {
    // 防御性检查：UI 已经用 cloudReady 挡过一次，但 store 不能依赖调用方。
    // 未启用云端时静默跳过 —— 本地快照照常创建，符合"可选上传（如果有）"。
    if (!getActiveConfig()?.enabled) return false

    const snap = await db.snapshots.get(snapshotId)
    if (!snap) throw new Error('快照不存在')

    const projectUid = await ensureSyncUid(snap.projectId)
    if (!projectUid) throw new Error('项目不存在，无法上传快照')

    // **先落盘 snapshotUid 再上传**：重试必须复用同一个标识，
    // 否则网络抖动会往云端塞出多份一模一样的快照。
    let snapshotUid = snap.cloudSnapshotUid
    if (!snapshotUid) {
      snapshotUid = newSnapshotUid()
      await db.snapshots.update(snapshotId, { cloudSnapshotUid: snapshotUid })
    }

    const payload = {
      projectUid,
      snapshotUid,
      label: snap.label,
      type: snap.type,
      createdAt: snap.createdAt,
      data: snap.data,
    }

    try {
      await apiUploadSnapshot(payload)
    } catch (error) {
      // 项目还没同步过 → 先把它推上去再重试。
      // 用户点"上传快照"时不该被要求"先去点立即同步"，那是我们该处理的事。
      //
      // 注意：引擎只推**脏**项目，而"刚建的项目 + 只建了快照"没有任何编辑，
      // 所以这里必须先显式标脏，否则 flushNow 会直接返回"没有要推的"。
      if (!(error instanceof CloudError) || error.status !== 404) throw error

      markProjectDirty(snap.projectId, ['projects'])
      const engine = await import('../lib/cloud/sync-engine')
      await engine.flushNow()

      try {
        await apiUploadSnapshot(payload)
      } catch (retryError) {
        if (retryError instanceof CloudError && retryError.status === 404) {
          throw new Error('项目尚未同步到云端，请先在「云数据库」卡片点「立即同步」后重试')
        }
        throw retryError
      }
    }

    await db.snapshots.update(snapshotId, { cloudUploadedAt: Date.now() })
    await get().loadSnapshots(snap.projectId)
    log.info(
      'BackupStore',
      'backup.snapshot.cloud_uploaded',
      `快照 #${snapshotId} 已上传云数据库`,
      { projectId: snap.projectId, snapshotId, snapshotUid, size: snap.size },
    )
    return true
  },

  loadCloudSnapshots: async (projectId: number) => {
    set({ cloudLoading: true, cloudError: null })
    try {
      // 只读不写：**不**为了"看一眼列表"就给项目生成云端身份
      const project = await db.projects.get(projectId)
      const projectUid = project?.syncUid
      if (!projectUid) {
        set({ cloudSnapshots: [], cloudLoading: false })
        return
      }
      const list = await listCloudSnapshots(projectUid)
      set({ cloudSnapshots: list, cloudLoading: false })
    } catch (error) {
      set({ cloudSnapshots: [], cloudLoading: false, cloudError: messageOf(error) })
    }
  },

  restoreCloudSnapshot: async (snapshotUid: string) => {
    const payload = await fetchCloudSnapshot(snapshotUid)
    const exportData = JSON.parse(payload.data)
    // 与本地恢复一致：永远新建项目，绝不就地覆盖
    const newProjectId = await importProjectJSON(exportData)
    log.info(
      'BackupStore',
      'backup.snapshot.cloud_restored',
      '已从云端快照恢复为新项目',
      { snapshotUid, newProjectId },
    )
    return newProjectId
  },

  deleteCloudSnapshot: async (snapshotUid: string) => {
    await apiDeleteCloudSnapshot(snapshotUid)

    // 本地若挂着这份快照的云端标记，一并清掉（否则图标会指向已删除的远端）
    const local = (await db.snapshots.toArray()).find(s => s.cloudSnapshotUid === snapshotUid)
    if (local?.id != null) {
      await db.snapshots.update(local.id, {
        cloudSnapshotUid: undefined,
        cloudUploadedAt: undefined,
      })
      await get().loadSnapshots(local.projectId)
    }

    set(state => ({
      cloudSnapshots: state.cloudSnapshots.filter(item => item.snapshotUid !== snapshotUid),
    }))
    log.info('BackupStore', 'backup.snapshot.cloud_deleted', '云端快照已删除', { snapshotUid })
  },
}))
