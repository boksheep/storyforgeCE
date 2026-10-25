import type { Chapter, OutlineNode } from '../types'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'
import { htmlToPlainText } from '../utils/html'

export type InventoryExtractionMode = 'all' | 'range'

export interface InventoryExtractionChapter {
  chapter: Chapter
  /** 在完整规范章序中的 1-based 序号，包括尚未写正文的章节。 */
  ordinal: number
  hasWrittenContent: boolean
}

export interface InventoryExtractionSelection {
  chapters: Chapter[]
  error: string | null
}

export function listInventoryExtractionChapters(
  chapters: Chapter[],
  outlineNodes: OutlineNode[],
): InventoryExtractionChapter[] {
  return resolveCanonicalChapterSequence(outlineNodes, chapters).sequence.map((entry, index) => ({
    chapter: entry.chapter,
    ordinal: index + 1,
    hasWrittenContent: htmlToPlainText(entry.chapter.content ?? '').trim().length > 50,
  }))
}

export function selectInventoryExtractionChapters(input: {
  chapters: Chapter[]
  outlineNodes: OutlineNode[]
  mode: InventoryExtractionMode
  startOrdinal?: number
  endOrdinal?: number
}): InventoryExtractionSelection {
  const available = listInventoryExtractionChapters(input.chapters, input.outlineNodes)

  if (input.mode === 'range') {
    const start = input.startOrdinal ?? 0
    const end = input.endOrdinal ?? 0
    if (start < 1 || end < 1) return { chapters: [], error: '请选择有效的起止章节' }
    if (start > end) return { chapters: [], error: '起始章不能大于结束章' }
    const chapters = available
      .filter(item => item.ordinal >= start && item.ordinal <= end && item.hasWrittenContent)
      .map(item => item.chapter)
    return {
      chapters,
      error: chapters.length > 0 ? null : '所选范围内没有可提取的已写正文',
    }
  }

  const chapters = available.filter(item => item.hasWrittenContent).map(item => item.chapter)
  return {
    chapters,
    error: chapters.length > 0 ? null : '还没有已写正文的章节，先去写作再提取',
  }
}
