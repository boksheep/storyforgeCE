/**
 * 导入会话 CRUD store。
 *
 * 薄薄地封一层 Dexie 访问，让 pipeline.ts 和 UI 都不用直接摸 db。
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { ImportSession, ImportLog, ChunkState } from '../lib/types/import-session'
import type { ImportFileBlob } from '../lib/types/import-file'
import { log } from '../lib/logging/logger'

interface ImportSessionStore {
  /** 当前激活的 session（null = 没跑任何任务） */
  current: ImportSession | null

  /** 加载某 session 到内存；不存在返回 null */
  load: (sessionId: number) => Promise<ImportSession | null>
  /** 扫描项目里的未完成 session（用于断点续跑提示） */
  findUnfinished: (projectId: number) => Promise<ImportSession | null>
  /** 扫描项目里"已完成、可复用解析"的最新 session（解析一次·多次落地） */
  findReusableCompleted: (projectId: number) => Promise<ImportSession | null>
  /** 清除内存中的 current（不删除 DB） */
  clear: () => void
  /** 创建新 session 并持久化 */
  create: (data: Omit<ImportSession, 'id' | 'createdAt' | 'updatedAt'>) => Promise<number>
  /** 覆盖更新（部分字段） */
  patch: (sessionId: number, partial: Partial<ImportSession>) => Promise<void>
  /** 更新某个 chunk 的状态 */
  patchChunk: (sessionId: number, chunkIndex: number, partial: Partial<ChunkState>) => Promise<void>
  /** 追加日志到 DB */
  log: (sessionId: number, chunkIndex: number, level: ImportLog['level'], message: string) => Promise<void>
  /** 删除 session + 其全部日志（用户放弃任务时） */
  deleteSession: (sessionId: number) => Promise<void>
  /** 取 session 的日志（给 Activity Log 回放） */
  listLogs: (sessionId: number, limit?: number) => Promise<ImportLog[]>

  // ── Phase 18 方案 A：Blob 持久化 ────────────────────────────
  /** 把上传的 File / Blob 作为原文存档（免得浏览器关了要重传） */
  saveBlob: (sessionId: number, filename: string, blob: Blob, fileHash: string) => Promise<void>
  /** 读取 Blob 存档 */
  loadBlob: (sessionId: number) => Promise<ImportFileBlob | null>
  /** 删除 Blob 存档（session 完成 / 放弃时） */
  deleteBlob: (sessionId: number) => Promise<void>
}


const now = () => Date.now()

export const useImportSessionStore = create<ImportSessionStore>((set, get) => ({
  current: null,

  load: async (sessionId) => {
    const s = (await db.importSessions.get(sessionId)) || null
    set({ current: s })
    return s
  },

  findUnfinished: async (projectId) => {
    // 找该项目下状态不是 done/cancelled 的最新会话
    const all = await db.importSessions
      .where('projectId').equals(projectId)
      .reverse().sortBy('updatedAt')
    const s = all.find(x => x.status !== 'done' && x.status !== 'cancelled') || null
    return s
  },

  findReusableCompleted: async (projectId) => {
    // 已完成且 merged 有内容的最新会话 → 可复用解析,免重新解析
    const all = await db.importSessions
      .where('projectId').equals(projectId)
      .reverse().sortBy('updatedAt')
    return all.find(x => {
      if (x.status !== 'done') return false
      const m = x.merged
      const hasWv = m?.worldview && Object.keys(m.worldview).length > 0
      const hasCh = Array.isArray(m?.characters) && m.characters.length > 0
      const hasOl = Array.isArray(m?.outline) && m.outline.length > 0
      const hasWt = m?.writingTechniques && Object.values(m.writingTechniques).some(v => typeof v === 'string' && v.trim())
      return hasWv || hasCh || hasOl || hasWt
    }) || null
  },

  clear: () => set({ current: null }),

  create: async (data) => {
    const row: ImportSession = { ...data, createdAt: now(), updatedAt: now() }
    const id = (await db.importSessions.add(row)) as number
    set({ current: { ...row, id } })
    return id
  },

  patch: async (sessionId, partial) => {
    const next = { ...partial, updatedAt: now() }
    await db.importSessions.update(sessionId, next)
    const cur = get().current
    if (cur?.id === sessionId) {
      set({ current: { ...cur, ...next } as ImportSession })
    }
  },

  patchChunk: async (sessionId, chunkIndex, partial) => {
    const cur = await db.importSessions.get(sessionId)
    if (!cur) return
    const chunks = cur.chunks.map(c =>
      c.index === chunkIndex ? { ...c, ...partial } : c,
    )
    await db.importSessions.update(sessionId, { chunks, updatedAt: now() })
    const mem = get().current
    if (mem?.id === sessionId) {
      set({ current: { ...mem, chunks, updatedAt: now() } })
    }
  },

  log: async (sessionId, chunkIndex, level, message) => {
    await db.importLogs.add({
      sessionId, chunkIndex, level, message,
      createdAt: now(),
    })
  },

  deleteSession: async (sessionId) => {
    await db.transaction('rw', db.importSessions, db.importLogs, async () => {
      await db.importSessions.delete(sessionId)
      await db.importLogs.where('sessionId').equals(sessionId).delete()
    })
    const cur = get().current
    if (cur?.id === sessionId) set({ current: null })
  },

  listLogs: async (sessionId, limit = 500) => {
    const rows = await db.importLogs
      .where('sessionId').equals(sessionId)
      .reverse().sortBy('createdAt')
    return rows.slice(0, limit)
  },

  saveBlob: async (sessionId, filename, blob, fileHash) => {
    const row: ImportFileBlob = {
      sessionId,
      filename,
      fileSize: blob.size,
      fileHash,
      blob,
      createdAt: now(),
    }
    await db.importFiles.put(row)
  },

  loadBlob: async (sessionId) => {
    const row = (await db.importFiles.get(sessionId)) || null
    return row
  },

  deleteBlob: async (sessionId) => {
    try {
      await db.importFiles.delete(sessionId)
    } catch {
      // 以前是静默 `catch { // ignore }`：blob 是导入原文的归档，删不掉会一直占用
      // IndexedDB 配额（浏览器可能为此驱逐活数据），而 UI 会照报"已释放"。
      log.warn(
        'ImportPipeline',
        'import.blob.delete.failed',
        `删除导入原文 blob 失败（session #${sessionId}）：空间未释放，可能占用配额`,
        { sessionId },
      )
    }
  },
}))
