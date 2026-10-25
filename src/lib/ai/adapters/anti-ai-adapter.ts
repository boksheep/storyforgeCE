/**
 * 去AI味增强适配器 — Phase F2
 *
 * 五维检测：词汇、句法、叙事、情感、对话
 */
import type { ChatMessage } from '../../types'

export interface AntiAIDimension {
  dimension: 'vocabulary' | 'syntax' | 'narrative' | 'emotion' | 'dialogue'
  score: number  // 0-100, 越高越好（越少AI味）
  markers: string[]  // 发现的典型AI痕迹
  suggestion: string
}

export interface AntiAIResult {
  overallScore: number
  dimensions: AntiAIDimension[]
  highFreqWords: string[]  // 高频重复词汇
  rewriteSuggestions: string[]
}

export const ANTI_AI_DIMENSION_LABELS: Record<string, string> = {
  vocabulary: '词汇多样性',
  syntax: '句式变化',
  narrative: '展示vs告知',
  emotion: '情感真实感',
  dialogue: '对话自然度',
}

export function buildAntiAIPrompt(
  chapterContent: string,
  highFreqWords?: string[],
): ChatMessage[] {
  const systemPrompt = `你是一位经验丰富的文学编辑，专门检测和消除 AI 生成文本的痕迹。

请从以下五个维度评估文本的"AI味"：

1. **词汇**（vocabulary）：检测 cliché 高频词（"不禁"、"缓缓"、"竟然"、"顿时"、"一丝"、"嘴角微微上扬"等）
2. **句法**（syntax）：句式多样性（是否全是"主谓宾"结构，是否缺乏长短句交替）
3. **叙事**（narrative）：展示(show) vs 告知(tell) 比例（"他很愤怒" vs 展示愤怒的行为）
4. **情感**（emotion）：标签化检测（"心中一震"、"不由得"等模板化情感表达）
5. **对话**（dialogue）：说话标签多样性（是否全用"说道"、"答道"、"笑道"）

输出严格 JSON，不要加 markdown 代码块：
{
  "overallScore": 75,
  "dimensions": [
    {
      "dimension": "vocabulary|syntax|narrative|emotion|dialogue",
      "score": 80,
      "markers": ["发现的典型AI痕迹片段1", "片段2"],
      "suggestion": "改进建议"
    }
  ],
  "highFreqWords": ["出现频率过高的词汇1", "词汇2"],
  "rewriteSuggestions": [
    "具体的改写示例或建议"
  ]
}

评分越高表示越像人写的（AI味越少）。`

  const parts: string[] = [
    `【正文】\n${chapterContent.slice(0, 4000)}`,
  ]
  if (highFreqWords && highFreqWords.length > 0) {
    parts.push(`【已知高频词】${highFreqWords.join('、')}`)
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') + '\n\n请开始检测：' },
  ]
}

export function parseAntiAIResult(raw: string): AntiAIResult | null {
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
      highFreqWords: Array.isArray(parsed.highFreqWords) ? parsed.highFreqWords : [],
      rewriteSuggestions: Array.isArray(parsed.rewriteSuggestions) ? parsed.rewriteSuggestions : [],
    }
  } catch {
    return null
  }
}

/**
 * 统计正文中的高频词（辅助 AI 检测）
 */
export function extractHighFreqWords(text: string, threshold = 5): string[] {
  // 常见的 AI 高频词列表
  const suspects = [
    '不禁', '缓缓', '竟然', '顿时', '微微', '淡淡', '一丝', '不由得',
    '嘴角', '心中', '脸上', '眼中', '此刻', '瞬间', '随即', '紧接着',
    '说道', '答道', '笑道', '冷哼', '沉声', '低语',
    '居然', '忍不住', '情不自禁', '若有所思', '恍然大悟',
  ]

  const counts: Record<string, number> = {}
  for (const word of suspects) {
    const regex = new RegExp(word, 'g')
    const matches = text.match(regex)
    if (matches && matches.length >= threshold) {
      counts[word] = matches.length
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => `${word}(${count}次)`)
}
