/**
 * 角色补全适配器（C1）——给【已有角色】补全【指定维度】,与已有设定(及可选的剧情证据)保持一致。
 *
 * 与「AI 设计角色」(从零造)区别:补全只填指定维度、不覆盖已有内容、必须与既有设定一致。
 * 不新增 prompt-seed(避开破坏生成→解析的风险),在此就地构造受控 prompt,输出严格 JSON。
 * 写回仍走 adopt({ target:'characters', recordId })——字段级校验由 FIELD_REGISTRY 负责。
 */
import type { ChatMessage, Character } from '../../types'
import { CHARACTER_DIMENSIONS, type CharacterDimensionKey } from '../../character/character-dimensions'

export interface SupplementArgs {
  character: Character
  /** 要补全的维度 key */
  dimensions: CharacterDimensionKey[]
  /** 世界观等上下文 */
  worldContext: string
  /** C2 反喂:该角色在正文/事实/年表里的真实表现（可空） */
  evidenceContext?: string
}

const labelOf = (k: CharacterDimensionKey) => CHARACTER_DIMENSIONS.find(d => d.key === k)?.label ?? k

export function buildCharacterSupplementPrompt(args: SupplementArgs): ChatMessage[] {
  const { character, dimensions, worldContext, evidenceContext } = args
  // 已有设定（非空维度），让 AI 据此保持一致
  const known = CHARACTER_DIMENSIONS
    .filter(d => (character[d.key] as string)?.trim())
    .map(d => `- ${d.label}：${(character[d.key] as string).trim()}`)
    .join('\n') || '（暂无）'
  const wanted = dimensions.map(k => `"${k}"（${labelOf(k)}）`).join('、')

  const system = [
    '你是资深网文角色设计师。任务：为一个【已有角色】补全【指定维度】。',
    '硬性要求：',
    '1. 只补全指定维度,不要输出其它字段；',
    '2. 补全内容必须与该角色的【已有设定】一致、不冲突；',
    evidenceContext ? '3. 必须严格符合该角色在正文里【已经写出来的真实表现】(下方证据),绝不能编造与正文矛盾的设定；' : '',
    '4. 每个维度写得具体、可用,符合该角色定位与世界观。',
    '只输出 JSON,key 为指定的英文字段名,value 为中文内容。不要解释、不要 markdown。',
  ].filter(Boolean).join('\n')

  const user = [
    `【角色】${character.name || '未命名'}`,
    `【已有设定】\n${known}`,
    `【世界观/设定】\n${worldContext || '（暂无）'}`,
    evidenceContext ? `【该角色在正文中的真实表现（必须据此补全,不得矛盾）】\n${evidenceContext}` : '',
    `【需补全的维度】${wanted}`,
    `请输出 JSON：{${dimensions.map(k => `"${k}":"…"`).join(', ')}}`,
  ].filter(Boolean).join('\n\n')

  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

/** 解析补全输出:取 JSON 里属于「请求维度」且非空的字段。 */
export function parseCharacterSupplement(raw: string, dimensions: CharacterDimensionKey[]): Partial<Character> {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return {} }
  const patch: Partial<Character> = {}
  for (const k of dimensions) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) (patch as Record<string, string>)[k] = v.trim()
  }
  return patch
}
