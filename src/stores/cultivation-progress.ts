import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type { CultivationProgress } from '../lib/types'
import { deleteCultivationProgressEvent } from '../lib/cultivation/progress'

interface CultivationProgressStore {
  events: CultivationProgress[]
  loading: boolean
  loadAll: (projectId: number) => Promise<void>
  deleteEvent: (id: number) => Promise<void>
}

export const useCultivationProgressStore = create<CultivationProgressStore>((set, get) => ({
  events: [],
  loading: false,

  loadAll: async (projectId) => {
    set({ loading: true })
    const events = await db.cultivationProgress.where('projectId').equals(projectId).toArray()
    set({ events, loading: false })
  },

  deleteEvent: async (id) => {
    const row = get().events.find(event => event.id === id)
    if (!row) {
      log.warn('CultivationProgress', 'cultivation.progress.delete.missing', '修炼进度删除目标不在当前项目列表', { eventId: id })
      return
    }
    await deleteCultivationProgressEvent(row.projectId, id)
    log.info('CultivationProgress', 'cultivation.progress.deleted', '修炼进度事件已删除', { projectId: row.projectId, eventId: id })
    set({ events: get().events.filter(event => event.id !== id) })
  },
}))
