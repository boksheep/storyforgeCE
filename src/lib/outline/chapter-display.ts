import type { Chapter, OutlineNode } from '../types'
import { walkOutlineChaptersInCanonicalOrder } from './canonical-outline-walk'

export interface ChapterDisplayMeta {
  title: string
  ordinal: number | null
}

export function resolveChapterDisplayMeta(
  chapter: Chapter,
  outlineNodes: OutlineNode[],
): ChapterDisplayMeta {
  const outlineNode = outlineNodes.find(node => node.id === chapter.outlineNodeId) ?? null

  return {
    title: outlineNode?.title?.trim() || chapter.title,
    ordinal: outlineNode ? resolveOutlineChapterOrdinal(outlineNode, outlineNodes) : null,
  }
}

function resolveOutlineChapterOrdinal(target: OutlineNode, outlineNodes: OutlineNode[]): number | null {
  if (target.id == null || target.type !== 'chapter') return null

  return walkOutlineChaptersInCanonicalOrder(outlineNodes)
    .chapters.find(item => item.outlineNode.id === target.id)
    ?.ordinal ?? null
}
