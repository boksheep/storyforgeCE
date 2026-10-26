/**
 * Phase 30.2 — 角色关系自动提取
 *
 * 从大纲摘要 + 章节正文中提取角色关系，
 * 返回结构化的关系数组供 UI 预览和写入。
 */
import type { Character, ChatMessage, RelationType } from '../types'
import { usePromptStore } from '../../stores/prompt'
import { renderPrompt } from './prompt-engine'
import { characterAxesLabel } from '../character/character-axes'
import { assembleContext } from '../registry/assemble-context'

/** AI 返回的原始关系条目 */
export interface ExtractedRelation {
  char1: string
  char2: string
  /** 同一关系的全部参与者；双人关系兼容旧格式。 */
  characters?: string[]
  type: RelationType
  label: string
  description: string
  bidirectional: boolean
}

/** 匹配后的关系条目（附带角色 ID） */
export interface MatchedRelation extends ExtractedRelation {
  fromCharacterId: number
  toCharacterId: number
  participantCharacterIds?: number[]
  /** 是否与已有关系重复 */
  isDuplicate: boolean
}

/**
 * 构建提取用的 prompt messages
 */
export async function buildRelationExtractPrompt(
  projectId: number,
  characters: Character[],
  projectName = '未命名项目',
): Promise<ChatMessage[]> {
  // 1. 角色列表
  const characterList = characters
    .map(c => `- ${c.name}（${characterAxesLabel(c)}）${c.shortDescription ? '：' + c.shortDescription : ''}`)
    .join('\n')

  // 所有项目证据从登记源装配，保留预算与截断语义。
  const evidence = await assembleContext({ projectId, sourceKeys: ['relationExtractionEvidence'], inputBudgetMaxTokens: 6000 })

  const tpl = usePromptStore.getState().getActive('relation.extract')
  const { messages } = renderPrompt(tpl, {
    projectName,
    characterList,
    outlineSummary: evidence.text,
    chapterContent: '',
  })
  return messages
}

/**
 * 解析 AI 输出的 JSON 关系数组
 */
export function parseRelationOutput(output: string): ExtractedRelation[] {
  // 尝试从输出中提取 JSON 数组
  let jsonStr = output.trim()

  // 去除 markdown code block
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }

  // 尝试找到 JSON 数组
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return []

  try {
    const parsed = JSON.parse(arrayMatch[0])
    if (!Array.isArray(parsed)) return []

    const VALID_TYPES = new Set<string>([
      'family', 'lover', 'friend', 'rival', 'enemy',
      'master', 'student', 'ally', 'subordinate', 'other',
    ])

    return parsed.flatMap((item: Record<string, unknown>) => {
      if (!item || !VALID_TYPES.has(String(item.type))) return []
      const names = Array.isArray(item.characters)
        ? item.characters.filter((name): name is string => typeof name === 'string').map(name => name.trim())
        : [item.char1, item.char2].filter((name): name is string => typeof name === 'string').map(name => name.trim())
      const unique = [...new Set(names.filter(Boolean))]
      if (unique.length < 2) return []
      return [{
        char1: unique[0], char2: unique[1],
        ...(unique.length > 2 ? { characters: unique } : {}),
        type: String(item.type) as RelationType,
        label: String(item.label || ''),
        description: String(item.description || ''),
        bidirectional: item.bidirectional !== false,
      }]
    })
  } catch {
    return []
  }
}

/**
 * 将提取的关系与已有角色名匹配，标记重复
 */
export function matchRelations(
  extracted: ExtractedRelation[],
  characters: Character[],
  existingRelations: { fromCharacterId: number; toCharacterId: number; relationType: string; participantCharacterIds?: number[] }[],
): MatchedRelation[] {
  // 只接受唯一的正式名、别名或省姓名称，避免包含匹配把陌生人误认成角色。
  const nameMap = new Map<string, number | null>()
  const registerName = (name: string, id: number) => {
    const normalized = name.trim()
    if (!normalized) return
    if (nameMap.has(normalized) && nameMap.get(normalized) !== id) nameMap.set(normalized, null)
    else if (!nameMap.has(normalized)) nameMap.set(normalized, id)
  }
  for (const c of characters) {
    if (c.id != null) {
      registerName(c.name, c.id)
      c.aliases?.forEach(alias => registerName(alias, c.id!))
      if (c.name.length >= 2) registerName(c.name.slice(1), c.id)
    }
  }

  const findCharId = (name: string): number | null => nameMap.get(name.trim()) ?? null

  // 已有关系的快速查重集合
  const key = (ids: number[], type: string) => `${[...ids].sort((a, b) => a - b).join('-')}-${type}`
  const existingSet = new Set(existingRelations.map(r =>
    key(r.participantCharacterIds?.length && r.participantCharacterIds.length > 2
      ? r.participantCharacterIds : [r.fromCharacterId, r.toCharacterId], r.relationType)))

  const results: MatchedRelation[] = []

  for (const rel of extracted) {
    const ids = (rel.characters ?? [rel.char1, rel.char2]).map(findCharId)
    if (ids.some(id => id == null) || new Set(ids).size !== ids.length) continue
    const matchedIds = ids as number[]
    const sortedIds = [...matchedIds].sort((a, b) => a - b)
    const [fromId, toId] = matchedIds.length > 2 ? sortedIds : matchedIds
    const dedupKey = key(matchedIds, rel.type)
    const isDuplicate = existingSet.has(dedupKey)

    results.push({
      ...rel,
      fromCharacterId: fromId,
      toCharacterId: toId,
      ...(matchedIds.length > 2 ? { participantCharacterIds: sortedIds } : {}),
      isDuplicate,
    })
  }

  return results
}
