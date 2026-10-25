import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'
import { walkOutlineChaptersInCanonicalOrder } from '../outline/canonical-outline-walk'
import type { Chapter, OutlineNode } from '../types'
import { htmlToPlainText } from '../utils/html'
import { normalizeReference, subtreeNodeIds } from './project-lookup'

const MAX_CANDIDATES = 5

function shortText(value: string | undefined, limit: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').replace(/【/g, '〔').replace(/】/g, '〕').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 以大纲规范章序定位标题和相邻章；章节表的 order/ID 不能充当章号。 */
export function formatChapterNeighborEvidence(input: {
  outlineNodes: OutlineNode[]
  chapters: Chapter[]
  worldGroupId: number | null
  reference: string
  scopeNodeId?: number | null
  anchorNodeId?: number
}): string {
  const reference = input.reference.trim().slice(0, 60)
  const safeReference = shortText(reference, 60)
  const normalized = normalizeReference(reference)
  if (!normalized) return '【相邻章节定位】请提供章节标题。'
  const walk = walkOutlineChaptersInCanonicalOrder(input.outlineNodes)
  const { sequence } = resolveCanonicalChapterSequence(input.outlineNodes, input.chapters)
  const chapterByNode = new Map(sequence.filter(entry => entry.outlineNode?.id != null)
    .map(entry => [entry.outlineNode!.id!, entry.chapter]))
  const scopedIds = subtreeNodeIds(input.outlineNodes, input.scopeNodeId ?? null)
  const volumeByNode = new Map<number, OutlineNode | null>()
  const ordinalInVolume = new Map<number, number>()
  const volumeCounts = new Map<number, number>()
  for (const item of walk.chapters) {
    const id = item.outlineNode.id!
    let parent = item.outlineNode.parentId == null ? undefined : walk.nodeById.get(item.outlineNode.parentId)
    const visited = new Set<number>()
    let volume: OutlineNode | null = null
    while (parent?.id != null && !visited.has(parent.id)) {
      visited.add(parent.id)
      if (parent.type === 'volume') { volume = parent; break }
      parent = parent.parentId == null ? undefined : walk.nodeById.get(parent.parentId)
    }
    volumeByNode.set(id, volume)
    if (volume?.id != null) {
      const ordinal = (volumeCounts.get(volume.id) ?? 0) + 1
      volumeCounts.set(volume.id, ordinal)
      ordinalInVolume.set(id, ordinal)
    }
  }
  const visible = walk.chapters.filter(item => item.worldGroupId === input.worldGroupId)
  const matches = visible.filter(item => {
    const id = item.outlineNode.id!
    if (input.anchorNodeId != null) return id === input.anchorNodeId
    return (scopedIds == null || scopedIds.has(id))
      && (normalizeReference(item.outlineNode.title) === normalized
        || normalizeReference(chapterByNode.get(id)?.title ?? '') === normalized)
  })
  if (!matches.length) return `【相邻章节定位】当前世界${scopedIds ? '的指定大纲范围' : ''}没有标题为“${safeReference}”的章节；没有自动推测章号或相邻章。`
  const sameTitleCount = visible.filter(item => normalizeReference(item.outlineNode.title) === normalized
    || normalizeReference(chapterByNode.get(item.outlineNode.id!)?.title ?? '') === normalized).length

  const describe = (item: typeof walk.chapters[number] | undefined): string => {
    if (!item) return '无'
    const node = item.outlineNode
    const chapter = chapterByNode.get(node.id!)
    const volume = volumeByNode.get(node.id!)
    const volumeLabel = volume ? `${shortText(volume.title, 60)}第${ordinalInVolume.get(node.id!)}章` : '无卷归属'
    return `${volumeLabel}｜全书第${item.ordinal}章｜大纲节点 #${node.id}｜章节记录 #${chapter?.id ?? '无'}｜${shortText(node.title, 100)}`
  }
  const lines = matches.slice(0, MAX_CANDIDATES).flatMap((match, index) => {
    const at = visible.findIndex(item => item.outlineNode.id === match.outlineNode.id)
    const next = visible[at + 1]
    const nextChapter = next ? chapterByNode.get(next.outlineNode.id!) : undefined
    const previous = visible[at - 1]
    return [
      `候选 ${index + 1}：`,
      `前一章：${describe(previous)}`,
      `锚点章：${describe(match)}`,
      `后一章：${describe(next)}`,
      next ? `后一章摘要：${shortText(next.outlineNode.summary, 500) || '未填写'}` : '',
      nextChapter ? `后一章正文短摘：${shortText(htmlToPlainText(nextChapter.content), 500) || '未写正文'}` : '',
      nextChapter?.title && nextChapter.title !== next?.outlineNode.title
        ? `后一章记录标题：${shortText(nextChapter.title, 100)}（与大纲标题不同）` : '',
    ].filter(Boolean)
  })
  return [
    input.anchorNodeId != null
      ? `【相邻章节定位】标题“${safeReference}”已按大纲节点 #${input.anchorNodeId} 固定；当前世界同标题章节数：${sameTitleCount}。`
      : `【相邻章节定位】标题“${safeReference}”精确命中 ${matches.length} 章。`,
    matches.length === 1 && (sameTitleCount === 1 || input.scopeNodeId != null && input.anchorNodeId == null)
      ? '定位状态：唯一。'
      : input.anchorNodeId != null ? '定位状态：记录已固定，但同标题章节存在歧义；需结合所属卷确认作者所指。'
        : '定位状态：有歧义；不得自动选取或修改，请按卷/篇范围缩小或让作者确认。',
    ...lines,
    matches.length > MAX_CANDIDATES ? `另有 ${matches.length - MAX_CANDIDATES} 个同名章未展示。` : '',
    '章号以大纲规范顺序为准；章节记录 ID、order 与章号不同。',
  ].filter(Boolean).join('\n')
}
