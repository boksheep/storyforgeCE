import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import { buildForeshadowTaskContext } from '../lib/foreshadow/context'
import type { Chapter, Foreshadow, ForeshadowStatus, OutlineNode } from '../lib/types'

interface ForeshadowStore {
  foreshadows: Foreshadow[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  addForeshadow: (f: Omit<Foreshadow, 'id' | 'createdAt' | 'updatedAt'>) => Promise<number>
  updateForeshadow: (id: number, data: Partial<Foreshadow>) => Promise<void>
  deleteForeshadow: (id: number) => Promise<void>
  updateStatus: (id: number, status: ForeshadowStatus) => Promise<void>

  // ── Phase C2: 伏笔上下文构建（注入 AI prompt） ──
  // 逾期/临近检测已并入 buildForeshadowTaskContext（按 canonical 章序，需传 chapters/outlineNodes）
  buildForeshadowContext: (currentChapterId: number, chapters?: Chapter[], outlineNodes?: OutlineNode[]) => string
}

const now = () => Date.now()

export const useForeshadowStore = create<ForeshadowStore>((set, get) => ({
  foreshadows: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    const foreshadows = await db.foreshadows
      .where('projectId').equals(projectId)
      .toArray()
    set({ foreshadows, loading: false })
  },

  addForeshadow: async (f) => {
    const newF: Foreshadow = { ...f, createdAt: now(), updatedAt: now() }
    const id = await db.foreshadows.add(newF) as number
    log.info('ForeshadowStore', 'foreshadow.created', '伏笔已创建', { projectId: f.projectId, recordId: id })
    set({ foreshadows: [...get().foreshadows, { ...newF, id }] })
    return id
  },

  updateForeshadow: async (id, data) => {
    const updated = await db.foreshadows.update(id, { ...data, updatedAt: now() })
    if (!updated) log.warn('ForeshadowStore', 'foreshadow.update.missing', '伏笔更新目标不存在', { recordId: id, fieldCount: Object.keys(data).length })
    else log.info('ForeshadowStore', 'foreshadow.updated', '伏笔已更新', { projectId: get().foreshadows.find(f => f.id === id)?.projectId, recordId: id, fieldCount: Object.keys(data).length })
    set({
      foreshadows: get().foreshadows.map(f =>
        f.id === id ? { ...f, ...data, updatedAt: now() } : f
      ),
    })
  },

  deleteForeshadow: async (id) => {
    const record = get().foreshadows.find(f => f.id === id)
    await db.foreshadows.delete(id)
    log.info('ForeshadowStore', 'foreshadow.deleted', '伏笔删除已执行', { projectId: record?.projectId, recordId: id, existedInStore: Boolean(record) })
    set({ foreshadows: get().foreshadows.filter(f => f.id !== id) })
  },

  updateStatus: async (id, status) => {
    const updated = await db.foreshadows.update(id, { status, updatedAt: now() })
    if (!updated) log.warn('ForeshadowStore', 'foreshadow.status.missing', '伏笔状态更新目标不存在', { recordId: id, status })
    else log.info('ForeshadowStore', 'foreshadow.status.updated', '伏笔状态已更新', { projectId: get().foreshadows.find(f => f.id === id)?.projectId, recordId: id, status })
    set({
      foreshadows: get().foreshadows.map(f =>
        f.id === id ? { ...f, status, updatedAt: now() } : f
      ),
    })
  },

  // ── Phase C2 ──

  buildForeshadowContext: (currentChapterId, chapters = [], outlineNodes = []) => {
    return buildForeshadowTaskContext(get().foreshadows, { currentChapterId, chapters, outlineNodes })
  },
}))
