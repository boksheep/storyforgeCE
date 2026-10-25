/**
 * 质量审校结果 Store — 按 chapterId 缓存审校 / 去AI味 / 追读力三类报告。
 *
 * 为什么需要：报告是组件内瞬态 state，质量审校面板一收起（unmount）或切一级标签
 * 离开创作区，报告就丢了（bug G7 / B1）。把结果提到本 store 后：
 *  - 收起再展开 → 从 store 回显（不销毁）；
 *  - 切一级标签再回来 → store 仍在内存（活在本次会话）；
 *  - 切章节 → 按 chapterId 读各自的报告，互不串台。
 * 普通审校/去 AI 味/追读力仍是廉价可重算的内存产物；一致性 Agent 报告另经
 * agentConversations/agentEvents 持久化，这里只保留当前 UI 投影。
 */
import { create } from 'zustand'
import type { ReviewResult } from '../lib/ai/adapters/review-adapter'
import type { AntiAIResult } from '../lib/ai/adapters/anti-ai-adapter'
import type { ReadabilityResult } from '../lib/ai/adapters/readability-adapter'
import type { ConsistencyAuditResult } from '../lib/ai/adapters/consistency-audit-adapter'

export type ReviewTab = 'consistency' | 'review' | 'antiAI' | 'readability'

export interface ChapterReviewState {
  review: ReviewResult | null
  antiAI: AntiAIResult | null
  readability: ReadabilityResult | null
  consistency: ConsistencyAuditResult | null
  activeTab: ReviewTab
}

const EMPTY: ChapterReviewState = {
  review: null,
  antiAI: null,
  readability: null,
  consistency: null,
  activeTab: 'review',
}

interface ReviewResultStore {
  byChapter: Record<number, ChapterReviewState>
  setReview: (chapterId: number, r: ReviewResult) => void
  setAntiAI: (chapterId: number, r: AntiAIResult) => void
  setReadability: (chapterId: number, r: ReadabilityResult) => void
  setConsistency: (chapterId: number, r: ConsistencyAuditResult) => void
  setActiveTab: (chapterId: number, tab: ReviewTab) => void
}

function patch(prev: Record<number, ChapterReviewState>, chapterId: number, p: Partial<ChapterReviewState>) {
  return { ...prev, [chapterId]: { ...(prev[chapterId] ?? EMPTY), ...p } }
}

export const useReviewResultStore = create<ReviewResultStore>(set => ({
  byChapter: {},
  setReview: (chapterId, r) => set(s => ({ byChapter: patch(s.byChapter, chapterId, { review: r }) })),
  setAntiAI: (chapterId, r) => set(s => ({ byChapter: patch(s.byChapter, chapterId, { antiAI: r }) })),
  setReadability: (chapterId, r) => set(s => ({ byChapter: patch(s.byChapter, chapterId, { readability: r }) })),
  setConsistency: (chapterId, r) => set(s => ({ byChapter: patch(s.byChapter, chapterId, { consistency: r }) })),
  setActiveTab: (chapterId, tab) => set(s => ({ byChapter: patch(s.byChapter, chapterId, { activeTab: tab }) })),
}))

/** 读取某章的审校缓存（不存在则返回稳定的空对象引用）。 */
export function selectChapterReview(chapterId: number | null | undefined) {
  return (s: ReviewResultStore): ChapterReviewState =>
    (chapterId != null ? s.byChapter[chapterId] : undefined) ?? EMPTY
}
