import type { ChapterTypingStats } from '../types'

export const TYPING_IDLE_THRESHOLD_MS = 8_000

export function createTypingStats(): ChapterTypingStats {
  return { activeTypingMs: 0, typedCharacters: 0, editCount: 0 }
}

export function recordTypingActivity(
  previous: ChapterTypingStats | undefined,
  previousTypedAt: number | undefined,
  plainBefore: string,
  plainAfter: string,
  now = Date.now(),
): ChapterTypingStats {
  const stats = previous ?? createTypingStats()
  const delta = Math.max(0, plainAfter.length - plainBefore.length)
  const activeTypingMs = previousTypedAt != null && now >= previousTypedAt && now - previousTypedAt <= TYPING_IDLE_THRESHOLD_MS
    ? stats.activeTypingMs + (now - previousTypedAt)
    : stats.activeTypingMs
  return {
    activeTypingMs,
    typedCharacters: stats.typedCharacters + delta,
    editCount: stats.editCount + 1,
    lastTypedAt: now,
  }
}

export function typingWordsPerMinute(stats: ChapterTypingStats | undefined): number {
  if (!stats || stats.activeTypingMs <= 0) return 0
  return Math.round((stats.typedCharacters / (stats.activeTypingMs / 60_000)) * 10) / 10
}

export function formatTypingDuration(stats: ChapterTypingStats | undefined): string {
  const minutes = Math.floor((stats?.activeTypingMs ?? 0) / 60_000)
  const seconds = Math.floor(((stats?.activeTypingMs ?? 0) % 60_000) / 1_000)
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}
