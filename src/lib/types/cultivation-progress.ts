export const CULTIVATION_TRANSITIONS = ['enter', 'advance', 'regress', 'switch'] as const
export type CultivationTransition = typeof CULTIVATION_TRANSITIONS[number]

export const CULTIVATION_PROGRESS_STATUSES = ['confirmed', 'stale', 'source-missing'] as const
export type CultivationProgressStatus = typeof CULTIVATION_PROGRESS_STATUSES[number]

/** Phase 34：正文证据经作者确认后的修炼阶段事件。当前进度由事件流实时投影。 */
export interface CultivationProgress {
  id?: number
  projectId: number
  worldGroupId?: number | null
  characterId?: number | null
  characterName: string
  cultivationSystemId?: number | null
  cultivationSystemName: string
  stageId?: string | null
  stageName: string
  transition: CultivationTransition
  sourceChapterId?: number | null
  sourceChapterTitle: string
  sourceQuote: string
  /** 逐字引文在纯文本正文中的位置；同章事件据此确定顺序。 */
  sourceOffset: number
  trigger: string
  status: CultivationProgressStatus
  createdAt: number
  updatedAt: number
}
