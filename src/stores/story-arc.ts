/**
 * 故事线 Store — Phase B
 * 管理全局故事线（主线+支线）的 CRUD
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { StoryArc } from '../lib/types'
import { parseStages, stringifyStages, type StoryStage } from '../lib/types/story-arc'
import { deleteStoryArcLifecycle, updateStoryArcStagesLifecycle } from '../lib/storyline/lifecycle'
import { log } from '../lib/logging/logger'

const now = () => Date.now()

interface StoryArcStore {
  arcs: StoryArc[]
  activeArcId: number | null
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  setActiveArc: (id: number | null) => void
  addArc: (arc: Omit<StoryArc, 'id' | 'createdAt' | 'updatedAt'>) => Promise<number>
  /** 静态阶段必须走 updateStages()，以便同步清理动态投影的悬空 stageId。 */
  updateArc: (
    id: number,
    data: Partial<Pick<StoryArc, 'name' | 'description' | 'type'>>,
  ) => Promise<void>
  deleteArc: (id: number) => Promise<void>

  /** 获取当前活跃故事线的阶段列表 */
  getActiveStages: () => StoryStage[]
  /** 更新某条故事线的阶段 */
  updateStages: (arcId: number, stages: StoryStage[]) => Promise<void>

  /** 构建用于 AI 注入的故事线上下文 */
  buildStoryArcContext: (currentChapterOrder?: number) => string
}

export const useStoryArcStore = create<StoryArcStore>((set, get) => ({
  arcs: [],
  activeArcId: null,
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    try {
      const arcs = await db.storyArcs.where('projectId').equals(projectId).toArray()
      set({ arcs, loading: false })
      // 默认选中主线
      if (arcs.length > 0 && !get().activeArcId) {
        const main = arcs.find(a => a.type === 'main')
        set({ activeArcId: main?.id ?? arcs[0].id ?? null })
      }
    } catch (err) {
      log.error('StoryArc', 'storyarc', '[StoryArc] loadAll 失败:', undefined, err)
      set({ loading: false })
    }
  },

  setActiveArc: (id) => set({ activeArcId: id }),

  addArc: async (arc) => {
    const newArc: StoryArc = { ...arc, createdAt: now(), updatedAt: now() }
    const id = await db.storyArcs.add(newArc) as number
    set({ arcs: [...get().arcs, { ...newArc, id }] })
    return id
  },

  updateArc: async (id, data) => {
    const patch = { ...data, updatedAt: now() }
    await db.storyArcs.update(id, patch)
    set({ arcs: get().arcs.map(a => a.id === id ? { ...a, ...patch } : a) })
  },

  deleteArc: async (id) => {
    await deleteStoryArcLifecycle(id)
    const arcs = get().arcs.filter(a => a.id !== id)
    set({ arcs, activeArcId: get().activeArcId === id ? (arcs[0]?.id ?? null) : get().activeArcId })
  },

  getActiveStages: () => {
    const { arcs, activeArcId } = get()
    const arc = arcs.find(a => a.id === activeArcId)
    if (!arc) return []
    return parseStages(arc.stages)
  },

  updateStages: async (arcId, stages) => {
    const stagesJson = stringifyStages(stages)
    await updateStoryArcStagesLifecycle({
      arcId,
      stages: stagesJson,
      validStageIds: stages.map(stage => stage.id),
    })
    set({
      arcs: get().arcs.map(arc => arc.id === arcId
        ? { ...arc, stages: stagesJson, updatedAt: now() }
        : arc),
    })
  },

  buildStoryArcContext: (currentChapterOrder?: number) => {
    const { arcs } = get()
    if (!arcs.length) return ''

    const parts: string[] = ['【全局故事线】']

    for (const arc of arcs) {
      const stages = parseStages(arc.stages)
      if (!stages.length) continue

      const typeLabel = arc.type === 'main' ? '主线' : '支线'
      parts.push(`\n[${typeLabel}] ${arc.name}${arc.description ? `：${arc.description}` : ''}`)

      for (let i = 0; i < stages.length; i++) {
        const s = stages[i]
        // 标注当前所处阶段
        const marker = ''
        if (currentChapterOrder !== undefined && s.startVolume !== undefined && s.endVolume !== undefined) {
          // 简化：暂用卷序号近似
        }
        const eventsStr = s.keyEvents.length > 0 ? ` | 关键事件：${s.keyEvents.join('、')}` : ''
        const tpStr = s.turningPoint ? ` | 转折：${s.turningPoint}` : ''
        parts.push(`  ${i + 1}. ${s.title}${marker}：${s.description}${eventsStr}${tpStr}`)
      }
    }

    return parts.join('\n')
  },
}))
