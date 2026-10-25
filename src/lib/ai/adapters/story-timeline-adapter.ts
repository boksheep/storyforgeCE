/**
 * 故事进程年表提取适配器 — Phase 25.5.2-a
 * 从章节正文提取剧情大事。
 */
import type { ChatMessage } from '../../types'
import { usePromptStore } from '../../../stores/prompt'
import { renderPrompt } from '../prompt-engine'

export interface ExtractedStoryEvent {
  title: string
  storyTime: string
  importance: number
  description: string
}

export function buildStoryTimelinePrompt(chapterTitle: string, chapterText: string): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('story-timeline.extract')
  const { messages } = renderPrompt(tpl, { chapterTitle, chapterText })
  return messages
}

export function parseStoryEvents(raw: string): ExtractedStoryEvent[] {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  let jsonStr = fence ? fence[1].trim() : trimmed
  const start = jsonStr.indexOf('[')
  const end = jsonStr.lastIndexOf(']')
  if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1)
  try {
    const arr = JSON.parse(jsonStr)
    if (!Array.isArray(arr)) return []
    return arr
      .map((e: Record<string, unknown>): ExtractedStoryEvent => {
        let imp = Math.round(Number(e.importance) || 2)
        if (imp < 1) imp = 1
        if (imp > 3) imp = 3
        return {
          title: String(e.title || '').trim(),
          storyTime: String(e.storyTime || '').trim(),
          importance: imp,
          description: String(e.description || '').trim(),
        }
      })
      .filter(e => e.title)
  } catch {
    return []
  }
}
