export const STORYLINE_PROGRESS_STATUSES = [
  'dormant',
  'active',
  'climax',
  'resolved',
  'abandoned',
] as const

export type StorylineProgressStatus = typeof STORYLINE_PROGRESS_STATUSES[number]

/** Phase 39：StoryArc 静态蓝图的作者已确认动态投影。 */
export interface StorylineProgress {
  id?: number
  projectId: number
  arcId: number
  currentStageId?: string | null
  status: StorylineProgressStatus
  progressNote: string
  lastActiveChapterId?: number | null
  lastActiveChapterTitle?: string
  /** JSON string：模型提议、作者确认的角色/物品/地点/势力名称闭集。 */
  involvedEntities: string
  /** 最近一次采纳的正文逐字证据。 */
  evidenceQuote?: string
  createdAt: number
  updatedAt: number
}

/** 两条已登记 StoryArc 在同章互相影响的作者已确认节点。 */
export interface StorylineCrossing {
  id?: number
  projectId: number
  arcIdA: number
  arcIdB: number
  chapterId?: number | null
  chapterTitle?: string
  note: string
  evidenceQuote: string
  createdAt: number
  updatedAt: number
}
