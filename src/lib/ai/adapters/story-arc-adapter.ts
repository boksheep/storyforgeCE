/**
 * 故事线 AI 适配器 — Phase B2
 * 根据世界观 + 故事核心 + 大纲 → AI 规划全局故事线
 */
import type { ChatMessage } from '../../types'
import { log } from '../../logging/logger'

export function buildStoryArcPrompt(
  projectName: string,
  genre: string,
  worldContext: string,
  storyCore: string,
  outlineSummary: string,
  arcType: 'main' | 'sub' = 'main',
  existingArcs?: string,
): ChatMessage[] {
  const typeLabel = arcType === 'main' ? '主线故事线' : '支线故事线'

  const systemPrompt = `你是一个专业小说策划师。根据提供的世界观、故事核心和大纲信息，规划一条完整的${typeLabel}。

要求：
1. 故事线应包含 3-7 个阶段，每个阶段有清晰的起止
2. 每个阶段必须有：标题、描述（50-100字）、关键事件（1-3个）
3. 重要阶段应标注转折点
4. 阶段之间要有因果递进关系，形成完整的叙事弧线
5. ${arcType === 'main' ? '主线应贯穿全书，从开篇到结局' : '支线应与主线交织但有独立发展'}

输出严格 JSON 格式，不要加 markdown 代码块：
{
  "name": "故事线名称",
  "description": "故事线整体描述（一句话）",
  "stages": [
    {
      "title": "阶段标题",
      "description": "阶段描述",
      "keyEvents": ["事件1", "事件2"],
      "turningPoint": "转折点描述（可选，无则不填）"
    }
  ]
}`

  const parts = [`【项目】${projectName}（${genre || '未知题材'}）`]
  if (worldContext) parts.push(`【世界观】\n${worldContext.slice(0, 500)}`)
  if (storyCore) parts.push(`【故事核心】\n${storyCore.slice(0, 500)}`)
  if (outlineSummary) parts.push(`【大纲摘要】\n${outlineSummary.slice(0, 500)}`)
  if (existingArcs) parts.push(`【已有故事线】\n${existingArcs}`)

  const userPrompt = parts.join('\n\n') + `\n\n请为这部作品规划一条${typeLabel}：`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

/**
 * 从 AI 输出解析故事线配置
 */
export function parseStoryArcResult(raw: string): {
  name: string
  description: string
  stages: Array<{
    title: string
    description: string
    keyEvents: string[]
    turningPoint?: string
  }>
} | null {
  const trimmed = raw.trim()
  let jsonStr = trimmed

  // 去除 markdown 代码块
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  // 找到 JSON 对象
  const objStart = jsonStr.indexOf('{')
  const objEnd = jsonStr.lastIndexOf('}')
  if (objStart === -1 || objEnd === -1) return null

  try {
    const parsed = JSON.parse(jsonStr.slice(objStart, objEnd + 1))
    if (!parsed.name || !Array.isArray(parsed.stages)) return null
    return parsed
  } catch (err) {
    log.error('StoryArc', 'storyarc', '[StoryArc] 解析失败:', undefined, err)
    return null
  }
}
