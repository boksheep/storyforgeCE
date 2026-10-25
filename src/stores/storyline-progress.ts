import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { StorylineCrossing, StorylineProgress } from '../lib/types'
import { log } from '../lib/logging/logger'

interface StorylineProgressStore {
  progress: StorylineProgress[]
  crossings: StorylineCrossing[]
  loading: boolean
  loadAll: (projectId: number) => Promise<void>
}

export const useStorylineProgressStore = create<StorylineProgressStore>((set) => ({
  progress: [],
  crossings: [],
  loading: false,
  loadAll: async (projectId) => {
    set({ loading: true })
    try {
      const [progress, crossings] = await Promise.all([
        db.storylineProgress.where('projectId').equals(projectId).toArray(),
        db.storylineCrossings.where('projectId').equals(projectId).toArray(),
      ])
      set({ progress, crossings, loading: false })
    } catch (error) {
      log.error('StorylineProgress', 'storylineprogress', '[StorylineProgress] loadAll 失败:', undefined, error)
      set({ loading: false })
    }
  },
}))
