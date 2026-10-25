/**
 * 追读力评估适配器 — Phase F3
 *
 * 评估维度：Hook（悬念钩子）、Coolpoint（爽点）、Micropayoff（微兑现）、Pacing（节奏）
 */
import type { ChatMessage } from '../../types'

export interface ReadabilityDimension {
  dimension: 'hook' | 'coolpoint' | 'micropayoff' | 'pacing'
  score: number  // 0-100
  description: string
  suggestion: string
}

export interface ReadabilityResult {
  overallScore: number
  dimensions: ReadabilityDimension[]
  highlights: string[]  // 亮点
  weaknesses: string[]  // 薄弱环节
}

export const READABILITY_DIMENSION_LABELS: Record<string, { label: string; emoji: string }> = {
  hook:        { label: '悬念钩子', emoji: '🎣' },
  coolpoint:   { label: '爽点/高潮', emoji: '⚡' },
  micropayoff: { label: '微兑现', emoji: '🎁' },
  pacing:      { label: '叙事节奏', emoji: '🎵' },
}

export function buildReadabilityPrompt(
  chapterContent: string,
  chapterTitle: string,
  prevChapterSummary: string,
  nextChapterSummary: string,
): ChatMessage[] {
  const systemPrompt = `你是一位专业的网文编辑，擅长评估章节的"追读力"——即读者看完本章后继续阅读下一章的动力。

请从以下四个维度评估：

1. **Hook（悬念钩子）**：章末是否留有悬念？是否让读者迫不及待想看下一章？
2. **Coolpoint（爽点/高潮）**：本章有无高潮、爽点、打脸时刻或情感爆发点？
3. **Micropayoff（微兑现）**：前文铺垫在本章有无小回报？读者积累的期待是否得到部分满足？
4. **Pacing（叙事节奏）**：叙述-对话-动作-描写的比例是否合理？是否有拖沓段落？

输出严格 JSON，不要加 markdown 代码块：
{
  "overallScore": 78,
  "dimensions": [
    {
      "dimension": "hook|coolpoint|micropayoff|pacing",
      "score": 80,
      "description": "该维度的具体评价",
      "suggestion": "改进建议"
    }
  ],
  "highlights": ["本章的亮点1", "亮点2"],
  "weaknesses": ["薄弱环节1", "薄弱环节2"]
}

评分标准：
- 90-100：极强追读力，读者无法停下
- 70-89：良好，有足够的吸引力
- 50-69：一般，部分读者可能弃读
- 0-49：追读力弱，需要大幅加强`

  const parts: string[] = [
    `【章节标题】${chapterTitle}`,
    `【正文】\n${chapterContent.slice(0, 4000)}`,
  ]
  if (prevChapterSummary) parts.push(`【上一章摘要】${prevChapterSummary}`)
  if (nextChapterSummary) parts.push(`【下一章摘要】${nextChapterSummary}`)

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') + '\n\n请评估追读力：' },
  ]
}

export function parseReadabilityResult(raw: string): ReadabilityResult | null {
  const trimmed = raw.trim()
  let jsonStr = trimmed

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const objStart = jsonStr.indexOf('{')
  const objEnd = jsonStr.lastIndexOf('}')
  if (objStart === -1 || objEnd === -1) return null

  try {
    const parsed = JSON.parse(jsonStr.slice(objStart, objEnd + 1))
    return {
      overallScore: parsed.overallScore ?? 0,
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
    }
  } catch {
    return null
  }
}
