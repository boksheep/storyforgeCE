import type { Chapter, OutlineNode } from '../types'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'
import { walkOutlineChaptersInCanonicalOrder } from '../outline/canonical-outline-walk'

export interface ProjectionBoundary {
  targetOrder: number | null
  orderOfChapter: Map<number, number>
  worldOfChapter: Map<number, number | null>
}

/**
 * 解析“目标章开始前”的规范时点。
 *
 * 生成章纲/细纲时正文 Chapter 可能尚未创建，因此允许直接以 outlineNodeId
 * 定位；已有正文仍按稳定 chapterId 定位。两条路径共享同一规范大纲顺序。
 */
export function resolveProjectionBoundary(input: {
  outlineNodes: OutlineNode[]
  chapters: Chapter[]
  chapterId?: number | null
  outlineNodeId?: number | null
}): ProjectionBoundary {
  const walk = walkOutlineChaptersInCanonicalOrder(input.outlineNodes)
  const orderOfOutline = new Map<number, number>()
  const worldOfOutline = new Map<number, number | null>()
  walk.chapters.forEach((entry, index) => {
    if (entry.outlineNode.id == null) return
    orderOfOutline.set(entry.outlineNode.id, index)
    worldOfOutline.set(entry.outlineNode.id, entry.worldGroupId)
  })

  const orderOfChapter = new Map<number, number>()
  const worldOfChapter = new Map<number, number | null>()
  for (const chapter of input.chapters) {
    if (chapter.id == null) continue
    const order = orderOfOutline.get(chapter.outlineNodeId)
    if (order == null) continue
    orderOfChapter.set(chapter.id, order)
    worldOfChapter.set(chapter.id, worldOfOutline.get(chapter.outlineNodeId) ?? null)
  }

  let targetOrder = input.outlineNodeId != null
    ? orderOfOutline.get(input.outlineNodeId) ?? null
    : null
  if (targetOrder == null && input.chapterId != null) {
    targetOrder = orderOfChapter.get(input.chapterId) ?? null
  }
  if (targetOrder != null) return { targetOrder, orderOfChapter, worldOfChapter }

  // 兼容历史“正文存在但大纲节点已丢失”的尾部顺序。
  if (input.chapterId != null) {
    const { sequence } = resolveCanonicalChapterSequence(input.outlineNodes, input.chapters)
    const fallbackOrder = new Map<number, number>()
    const fallbackWorld = new Map<number, number | null>()
    sequence.forEach((entry, index) => {
      if (entry.chapter.id == null) return
      fallbackOrder.set(entry.chapter.id, index)
      fallbackWorld.set(entry.chapter.id, entry.worldGroupId)
    })
    return {
      targetOrder: fallbackOrder.get(input.chapterId) ?? null,
      orderOfChapter: fallbackOrder,
      worldOfChapter: fallbackWorld,
    }
  }

  return { targetOrder: null, orderOfChapter, worldOfChapter }
}
