/**
 * 故事进程年表 store — Phase 25.5.2-a
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { StoryTimelineEvent } from '../lib/types'
import { log } from '../lib/logging/logger'

interface StoryTimelineStore {
  events: StoryTimelineEvent[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  addEvent: (e: Omit<StoryTimelineEvent, 'id' | 'createdAt'>) => Promise<number>
  addEvents: (es: Omit<StoryTimelineEvent, 'id' | 'createdAt'>[]) => Promise<void>
  updateEvent: (id: number, patch: Partial<StoryTimelineEvent>) => Promise<void>
  deleteEvent: (id: number) => Promise<void>
  deleteByChapter: (projectId: number, chapterId: number) => Promise<void>
}

const now = () => Date.now()

export const useStoryTimelineStore = create<StoryTimelineStore>((set, get) => ({
  events: [],
  loading: false,

  loadAll: async (projectId) => {
    set({ loading: true })
    const events = await db.storyTimelineEvents.where('projectId').equals(projectId).toArray()
    set({ events, loading: false })
  },

  addEvent: async (e) => {
    const id = await db.storyTimelineEvents.add({ ...e, createdAt: now() } as StoryTimelineEvent) as number
    set({ events: [...get().events, { ...e, id, createdAt: now() } as StoryTimelineEvent] })
    return id
  },

  addEvents: async (es) => {
    if (es.length === 0) return
    const ts = now()
    const rows = es.map(e => ({ ...e, createdAt: ts })) as StoryTimelineEvent[]
    const ids = await db.storyTimelineEvents.bulkAdd(rows, { allKeys: true }) as number[]
    set({ events: [...get().events, ...rows.map((r, i) => ({ ...r, id: ids[i] }))] })
    // 批量落库用 count + chapterId 概括规模，避免逐条刷屏。
    log.info(
      'StoryTimelineStore',
      'story.timeline.bulk.added',
      `批量写入年表事件 ${rows.length} 条`,
      { projectId: es[0].projectId, chapterId: es[0].chapterId ?? 0, count: rows.length },
    )
  },

  updateEvent: async (id, patch) => {
    await db.storyTimelineEvents.update(id, patch)
    set({ events: get().events.map(e => e.id === id ? { ...e, ...patch } : e) })
  },

  deleteEvent: async (id) => {
    const removed = get().events.find(e => e.id === id)
    await db.storyTimelineEvents.delete(id)
    set({ events: get().events.filter(e => e.id !== id) })
    log.warn(
      'StoryTimelineStore',
      'story.timeline.deleted',
      `已删除年表事件 #${id}`,
      { projectId: removed?.projectId ?? 0, eventId: id, count: 1 },
    )
  },

  deleteByChapter: async (projectId, chapterId) => {
    const toDelete = get().events.filter(e => e.projectId === projectId && e.chapterId === chapterId)
    await db.storyTimelineEvents.bulkDelete(toDelete.map(e => e.id!).filter(Boolean))
    set({ events: get().events.filter(e => !(e.projectId === projectId && e.chapterId === chapterId)) })
    // 重新提取前按章清空旧记录：不可逆的批量删除，记下规模与作用域。
    log.warn(
      'StoryTimelineStore',
      'story.timeline.cleared.chapter',
      `已清除章节 #${chapterId} 的年表事件 ${toDelete.length} 条`,
      { projectId, chapterId, count: toDelete.length },
    )
  },
}))
