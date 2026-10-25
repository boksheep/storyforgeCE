/**
 * 章节审校适配器 — Phase F1
 *
 * AI 审校五个维度：逻辑一致性、人物行为、世界观、伏笔衔接、情节节奏
 */
import type { ChatMessage } from '../../types'

export interface ReviewIssue {
  dimension: 'logic' | 'character' | 'worldview' | 'foreshadow' | 'pacing'
  severity: 'info' | 'warning' | 'critical'
  description: string
  quote?: string
  suggestion: string
}

export interface ReviewResult {
  overallScore: number
  issues: ReviewIssue[]
  suggestions: string[]
}

const DIMENSION_LABELS: Record<string, string> = {
  logic: '逻辑一致性',
  character: '人物行为',
  worldview: '世界观',
  foreshadow: '伏笔衔接',
  pacing: '情节节奏',
}

export { DIMENSION_LABELS as REVIEW_DIMENSION_LABELS }

export function buildReviewPrompt(
  chapterContent: string,
  chapterTitle: string,
  worldContext: string,
  characterContext: string,
  prevChapterSummary: string,
  foreshadowContext: string,
  stateContext: string,
): ChatMessage[] {
  const systemPrompt = `你是一位专业的小说编辑，负责对章节进行多维度审校。
请从以下五个维度审查正文：

1. **逻辑一致性**（logic）：角色位置移动是否合理、时间线是否连贯、因果关系是否成立
2. **人物行为一致性**（character）：角色性格是否前后矛盾、对话是否符合人设
3. **世界观一致性**（worldview）：是否违反已设定的世界规则
4. **伏笔衔接**（foreshadow）：本章涉及的伏笔是否处理得当、是否有遗漏
5. **情节节奏**（pacing）：是否有拖沓或跳跃、叙述节奏是否合理

输出严格 JSON，不要加 markdown 代码块：
{
  "overallScore": 85,
  "issues": [
    {
      "dimension": "logic|character|worldview|foreshadow|pacing",
      "severity": "info|warning|critical",
      "description": "问题描述",
      "quote": "引用原文片段（可选，最多30字）",
      "suggestion": "改进建议"
    }
  ],
  "suggestions": ["总体改进建议1", "总体改进建议2"]
}

评分标准：
- 90-100：优秀，几乎无问题
- 70-89：良好，有小问题但不影响阅读
- 50-69：一般，有明显问题需要修改
- 0-49：需要大改，有严重逻辑/设定问题`

  const parts: string[] = [
    `【章节标题】${chapterTitle}`,
    `【正文】\n${chapterContent.slice(0, 4000)}`,
  ]
  if (prevChapterSummary) parts.push(`【上一章摘要】${prevChapterSummary}`)
  if (worldContext) parts.push(`【世界观】\n${worldContext.slice(0, 500)}`)
  if (characterContext) parts.push(`【角色设定】\n${characterContext.slice(0, 500)}`)
  if (foreshadowContext) parts.push(`【伏笔状态】\n${foreshadowContext.slice(0, 400)}`)
  if (stateContext) parts.push(`【状态表】\n${stateContext.slice(0, 400)}`)

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') + '\n\n请开始审校：' },
  ]
}

/**
 * G8：按审校报告让 AI 修改全文。
 * 把原文 + 报告里的问题/建议喂给模型，产出修订后的【全文】（保持篇幅与情节，只针对问题改）。
 */
export function buildReviewRevisePrompt(
  chapterContent: string,
  report: ReviewResult,
  worldContext?: string,
  characterContext?: string,
): ChatMessage[] {
  const issueLines = report.issues.map((it, i) => {
    const dim = DIMENSION_LABELS[it.dimension] || it.dimension
    const q = it.quote ? `（原文：「${it.quote}」）` : ''
    return `${i + 1}. [${dim}·${it.severity}] ${it.description}${q} → 建议：${it.suggestion}`
  })
  const systemPrompt = `你是一位专业的小说编辑。下面给你一段章节正文，以及一份审校报告。
请你**根据报告逐条修订正文**，输出修改后的【完整正文】。

修订要求：
1. 只针对报告里指出的问题改（逻辑/人物/世界观/伏笔/节奏），没问题的段落保持原样。
2. 篇幅与原文相近（控制在原文 90%~110%）；绝不删情节、不缩写成摘要、不注水扩写。
3. 保持原有的人称、时态、文风；这是"改稿"，不是"重写"。
4. 直接输出修订后的正文全文，不要任何前言、说明、标注或 markdown。`

  const parts: string[] = [
    `【审校报告·待修订的问题】\n${issueLines.length ? issueLines.join('\n') : '（无具体问题项，按总体建议润饰即可）'}`,
  ]
  if (report.suggestions.length) parts.push(`【总体建议】\n${report.suggestions.map(s => '· ' + s).join('\n')}`)
  if (worldContext) parts.push(`【世界观参考】\n${worldContext.slice(0, 500)}`)
  if (characterContext) parts.push(`【角色参考】\n${characterContext.slice(0, 500)}`)
  parts.push(`【原文】\n${chapterContent}`)

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') + '\n\n请输出修订后的正文全文：' },
  ]
}

export function parseReviewResult(raw: string): ReviewResult | null {
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
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }
  } catch {
    return null
  }
}
