/**
 * NS-6 · 全闭环 — 正文修改的 stale 传播 + 影响分析。
 *
 * 设计 §22.8 NS-6 / §26.4：改某章正文后——
 * - 该章派生记忆失效：handoff/摘要由 hash 自动 stale（NS-1）、检索块由 hash 重建（NS-5）；
 *   事实账本里【源自该章】且证据引文已不在新正文的【已确认】事实 → 标记 stale/待复核（§16.7），
 *   绝不自动删事实、绝不动 locked。
 * - 影响分析：列出"引用了该章事实/紧随其后的"后续章节，交作者复核——只提示、不自动改正文。
 */
import { db } from '../db/schema'
import { log } from '../logging/logger'
import type { TemporalFact } from '../types/temporal-fact'
import { normalizeChapterText } from '../ai/chapter-memory/text-normalization'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'

/**
 * 正文改动后传播 stale：源自该章、证据已失效的【已确认】事实标记 stale（待作者重新确认）。
 * 不删事实、不动 locked、不碰候选/已否决。
 */
export async function propagateChapterEditStale(projectId: number, chapterId: number): Promise<{ demotedFacts: number }> {
  const chapter = await db.chapters.get(chapterId)
  const content = normalizeChapterText(chapter?.content || '')
  const facts = await db.temporalFacts
    .where('projectId').equals(projectId)
    .filter(f => f.sourceChapterId === chapterId && f.status === 'confirmed' && !f.locked)
    .toArray()
  let demoted = 0
  for (const f of facts) {
    // 证据引文已不在新正文 → 该确认事实失去依据，标记 stale 待复核
    if (f.sourceQuote && !content.includes(f.sourceQuote) && f.id != null) {
      await db.temporalFacts.update(f.id, { status: 'stale', updatedAt: Date.now() })
      demoted++
    }
  }
  log.info('EditImpact', 'consistency.chapter.stale-propagated', '正文修改后的事实失效传播已完成', {
    projectId, chapterId, candidateFactCount: facts.length, demotedFacts: demoted,
    contentChars: content.length,
  })
  return { demotedFacts: demoted }
}

export interface EditImpact {
  /** 源自被改章的事实（作者应复核它们是否仍成立） */
  factsFromChapter: TemporalFact[]
  /** 规范章序在被改章之后、可能受影响需复核的后续章 id（按章序） */
  downstreamChapterIds: number[]
}

/**
 * 影响分析：改了某章后，列出源自该章的事实 + 其后续章（供作者复核）。只读、只提示，不自动改任何正文。
 */
export async function analyzeEditImpact(projectId: number, chapterId: number): Promise<EditImpact> {
  const [facts, outlineNodes, chapters] = await Promise.all([
    db.temporalFacts.where('projectId').equals(projectId).filter(f => f.sourceChapterId === chapterId).toArray(),
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const idx = sequence.findIndex(e => e.chapter.id === chapterId)
  const downstreamChapterIds = idx >= 0
    ? sequence.slice(idx + 1).map(e => e.chapter.id!).filter(id => id != null)
    : []
  log.info('EditImpact', 'consistency.chapter.impact-analyzed', '章节修改影响分析已完成', {
    projectId, chapterId, sourceFactCount: facts.length,
    downstreamChapterCount: downstreamChapterIds.length, chapterFound: idx >= 0,
  })
  return { factsFromChapter: facts, downstreamChapterIds }
}
