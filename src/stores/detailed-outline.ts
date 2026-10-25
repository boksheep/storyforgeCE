import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { DetailedOutline } from '../lib/types'
import { normalizeDetailedScenes } from '../lib/types/detailed-outline'
import { log } from '../lib/logging/logger'

interface DetailedOutlineStore {
  detailedOutlines: DetailedOutline[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  /** 获取或创建某章节的细纲 */
  getOrCreate: (projectId: number, outlineNodeId: number) => Promise<DetailedOutline>
  save: (id: number, patch: Partial<DetailedOutline>) => Promise<void>
  remove: (id: number) => Promise<void>
}

const now = () => Date.now()

export const useDetailedOutlineStore = create<DetailedOutlineStore>((set, get) => ({
  detailedOutlines: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    const list = await db.detailedOutlines.where('projectId').equals(projectId).toArray()
    // CF-2 自愈：旧库可能把 scenes 存成字符串，读入时统一回数组，避免渲染端 .map/.reduce 崩溃
    set({ detailedOutlines: list.map(d => ({ ...d, scenes: normalizeDetailedScenes(d.scenes) })), loading: false })
  },

  getOrCreate: async (projectId: number, outlineNodeId: number): Promise<DetailedOutline> => {
    const existing = get().detailedOutlines.find(d => d.outlineNodeId === outlineNodeId)
    if (existing) return existing
    // 内存没有时以 DB 为准再查一次，避免 store 未加载/竞态导致同一节点重复建细纲
    const inDb = await db.detailedOutlines.where('outlineNodeId').equals(outlineNodeId).first()
    if (inDb) {
      const normalized = { ...inDb, scenes: normalizeDetailedScenes(inDb.scenes) }
      if (!get().detailedOutlines.some(d => d.id === normalized.id)) {
        set({ detailedOutlines: [...get().detailedOutlines, normalized] })
      }
      return normalized
    }
    const fresh: DetailedOutline = {
      projectId, outlineNodeId, scenes: [],
      createdAt: now(), updatedAt: now(),
    }
    const id = await db.detailedOutlines.add(fresh) as number
    const withId = { ...fresh, id }
    set({ detailedOutlines: [...get().detailedOutlines, withId] })
    return withId
  },

  save: async (id, patch) => {
    const updated = { ...patch, updatedAt: now() }
    await db.detailedOutlines.update(id, updated)
    set({
      detailedOutlines: get().detailedOutlines.map(d =>
        d.id === id ? { ...d, ...updated } : d
      ),
    })
  },

  remove: async (id) => {
    const removed = get().detailedOutlines.find(d => d.id === id)
    await db.detailedOutlines.delete(id)
    set({ detailedOutlines: get().detailedOutlines.filter(d => d.id !== id) })
    // 删除细纲=丢弃该节点已生成的场面规划，属不可逆操作：只记 id 与所属项目。
    log.warn(
      'DetailedOutlineStore',
      'detailed.outline.deleted',
      `已删除细纲 #${id}`,
      { projectId: removed?.projectId ?? 0, outlineNodeId: removed?.outlineNodeId ?? 0, count: 1 },
    )
  },
}))
