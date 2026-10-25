import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type { Reference, CreateReferenceInput, ReferenceChunkAnalysis } from '../lib/types'
import {
  deleteReferenceWithAnalysis,
  getReferenceAnalysisRunChunks,
} from '../lib/reference-analysis/lifecycle'

interface ReferenceStore {
  references: Reference[]
  loading: boolean
  loadAll: (projectId: number) => Promise<void>
  addReference: (data: CreateReferenceInput) => Promise<number>
  updateReference: (id: number, data: Partial<Reference>) => Promise<void>
  deleteReference: (id: number) => Promise<void>

  // ── 深度分析相关 ──
  /** 获取某个参考的所有分块分析 */
  getChunkAnalyses: (refId: number, runId?: number) => Promise<ReferenceChunkAnalysis[]>
}

export const useReferenceStore = create<ReferenceStore>((set, get) => ({
  references: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    const references = await db.references.where('projectId').equals(projectId).toArray()
    set({ references, loading: false })
  },

  addReference: async (data: CreateReferenceInput) => {
    const now = Date.now()
    const id = await db.references.add({ ...data, createdAt: now, updatedAt: now } as Reference)
    log.info('ReferenceStore', 'reference.created', '参考资料记录已创建', {
      projectId: data.projectId, referenceId: id,
    })
    await get().loadAll(data.projectId)
    return id as number
  },

  updateReference: async (id: number, data: Partial<Reference>) => {
    await db.references.update(id, { ...data, updatedAt: Date.now() })
    const ref = await db.references.get(id)
    log.info('ReferenceStore', 'reference.updated', '参考资料记录已更新', {
      projectId: ref?.projectId ?? data.projectId, referenceId: id,
      fieldCount: Object.keys(data).length,
    })
    if (ref) await get().loadAll(ref.projectId)
  },

  deleteReference: async (id: number) => {
    const projectId = await deleteReferenceWithAnalysis(id)
    if (projectId) await get().loadAll(projectId)
  },

  // ── 深度分析相关 ──

  getChunkAnalyses: getReferenceAnalysisRunChunks,
}))
