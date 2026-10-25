import { db } from '../db/schema'
import { REGISTRY_BY_NAME } from '../registry/project-tables'
import { useChapterStore } from '../../stores/chapter'
import type { Chapter, OutlineNode } from '../types'
import type { AgentContextEvidence } from './context-policy'
import type { AgentTeamBudgetEvidence } from './team-budget'

/** 专用删章入口：只复用章节生命周期，不开放通用表删除。 */
export interface ChapterDeletionCandidatePayload {
  version: 1
  agentId: 'project-lifecycle'
  taskId: string
  label: string
  contextSources: string[]
  contextEvidence?: AgentContextEvidence
  teamBudgetEvidence?: AgentTeamBudgetEvidence
  dependsOnTaskIds?: string[]
  tableName: 'chapters'
  recordId: number
  projectId: number
  worldGroupId: number | null
  fingerprint: string
  preview: string
}

interface ChapterImpact {
  chapter: Chapter
  affected: Record<string, unknown[]>
}

async function readChapterImpact(projectId: number, worldGroupId: number | null, recordId: number): Promise<ChapterImpact> {
  if (REGISTRY_BY_NAME.get('chapters')?.table !== db.chapters) throw new Error('章节未登记在 PROJECT_TABLES')
  const chapter = await db.chapters.get(recordId)
  if (!chapter || chapter.projectId !== projectId) throw new Error('章节不存在或不属于当前项目')
  if (worldGroupId != null) {
    let outlineId: number | null = chapter.outlineNodeId
    let effectiveWorld: number | null = null
    const seen = new Set<number>()
    while (outlineId != null && !seen.has(outlineId)) {
      seen.add(outlineId)
      const node: OutlineNode | undefined = await db.outlineNodes.get(outlineId)
      if (!node || node.projectId !== projectId) throw new Error('章节大纲归属无效')
      if (node.worldGroupId != null) {
        effectiveWorld = node.worldGroupId
        break
      }
      outlineId = node.parentId ?? null
    }
    if (effectiveWorld !== worldGroupId) throw new Error('章节不属于当前世界作用域')
  }
  const [beats, chunks, summaries, facts, knowledge, progress, crossings, cultivation] = await Promise.all([
    db.emotionBeatCards.where('chapterId').equals(recordId).toArray(),
    db.retrievalChunks.where('sourceChapterId').equals(recordId).toArray(),
    db.narrativeSummaryNodes.where('sourceChapterId').equals(recordId).toArray(),
    db.temporalFacts.where('projectId').equals(projectId).filter(row =>
      row.sourceChapterId === recordId || row.validFromChapterId === recordId || row.validToChapterId === recordId).toArray(),
    db.knowledgeLedger.where('sourceChapterId').equals(recordId).toArray(),
    db.storylineProgress.where('projectId').equals(projectId).filter(row => row.lastActiveChapterId === recordId).toArray(),
    db.storylineCrossings.where('chapterId').equals(recordId).toArray(),
    db.cultivationProgress.where('sourceChapterId').equals(recordId).toArray(),
  ])
  return { chapter, affected: { beats, chunks, summaries, facts, knowledge, progress, crossings, cultivation } }
}

/** 同步计算，保证复核能留在 IndexedDB 删除事务内。 */
function fingerprintImpact(impact: ChapterImpact): string {
  const text = JSON.stringify(impact)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + index), 0x85ebca6b)
  }
  return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
}

function describeImpact(impact: ChapterImpact): string {
  const counts = Object.fromEntries(Object.entries(impact.affected).map(([name, rows]) => [name, rows.length]))
  return [
    `删除章节「${impact.chapter.title}」(#${impact.chapter.id})：正文 ${impact.chapter.content.length} 字将删除。`,
    `级联删除：情感节拍 ${counts.beats}、检索块 ${counts.chunks}、叙事摘要节点 ${counts.summaries}。`,
    `保留记录并断开章节引用：时间事实 ${counts.facts}、认知记录 ${counts.knowledge}、故事线进度 ${counts.progress}、故事线交汇 ${counts.crossings}、修炼进度 ${counts.cultivation}。`,
    '物品流水、年表等独立产物会保留原有冗余章节信息。确认后使用章节现有生命周期执行，无法在此撤销。',
  ].join('\n')
}

export async function prepareChapterDeletionCandidate(input: {
  projectId: number
  worldGroupId: number | null
  recordId: number
  contextSources: string[]
}): Promise<{ payload: ChapterDeletionCandidatePayload; draft: string }> {
  if (!Number.isInteger(input.recordId) || input.recordId < 1) throw new Error('章节 ID 无效')
  const impact = await readChapterImpact(input.projectId, input.worldGroupId, input.recordId)
  const preview = describeImpact(impact)
  return {
    payload: {
      version: 1, agentId: 'project-lifecycle', taskId: `delete-chapter-${input.recordId}`,
      label: '删除章节', contextSources: input.contextSources,
      tableName: 'chapters', recordId: input.recordId, projectId: input.projectId,
      worldGroupId: input.worldGroupId, fingerprint: fingerprintImpact(impact), preview,
    },
    draft: preview,
  }
}

export async function adoptChapterDeletionCandidate(input: {
  projectId: number
  worldGroupId: number | null
  payload: ChapterDeletionCandidatePayload
  draft: string
}): Promise<string> {
  const { payload } = input
  if (payload.version !== 1 || payload.agentId !== 'project-lifecycle' || payload.tableName !== 'chapters'
    || payload.projectId !== input.projectId || payload.worldGroupId !== input.worldGroupId
    || payload.preview !== input.draft) throw new Error('删除候选与当前项目或预览不一致')
  await useChapterStore.getState().cascadeDeleteChapters([payload.recordId], async () => {
    const current = await readChapterImpact(input.projectId, input.worldGroupId, payload.recordId)
    if (fingerprintImpact(current) !== payload.fingerprint) {
      throw new Error('章节或关联数据已变化，请重新生成删除影响预览')
    }
  })
  return `已删除章节 #${payload.recordId}，并按章节生命周期处理关联数据。`
}
