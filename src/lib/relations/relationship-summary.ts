import { adopt } from '../registry/adopt'
import { db } from '../db/schema'
import type { Character, CharacterRelation } from '../types'

export const RELATION_FIELD_PREFIX = '- 与【'

type RelationForSummary = Pick<
  CharacterRelation,
  'fromCharacterId' | 'toCharacterId' | 'participantCharacterIds' | 'label' | 'description' | 'isBidirectional'
>

interface RelationSummaryPatchInput {
  projectId: number
  relation: RelationForSummary
  characters: Character[]
}

function relationLine(otherName: string, relation: RelationForSummary, perspective: 'from' | 'to'): string {
  const label = relation.label?.trim() || '关系'
  const description = relation.description?.trim()
  const prefix = perspective === 'from'
    ? `- 与【${otherName}】：${label}`
    : relation.isBidirectional
      ? `- 与【${otherName}】：${label}`
      : `- 被【${otherName}】关联：${label}`
  return description ? `${prefix}。${description}` : `${prefix}。`
}

function appendUniqueLine(existing: string | undefined, line: string): string | null {
  const normalizedExisting = String(existing ?? '').trim()
  const existingLines = normalizedExisting
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)
  if (existingLines.includes(line)) return null
  return normalizedExisting ? `${normalizedExisting}\n${line}` : line
}

export function buildRelationshipFieldPatches({ projectId, relation, characters }: RelationSummaryPatchInput): Array<{ characterId: number; relationships: string }> {
  const groupIds = relation.participantCharacterIds
  if (groupIds && groupIds.length > 2) {
    const participants = groupIds.map(id => characters.find(c => c.projectId === projectId && c.id === id))
    if (participants.some(character => !character?.id) || new Set(groupIds).size !== groupIds.length) return []
    return participants.flatMap(character => {
      const peers = participants.filter(peer => peer!.id !== character!.id).map(peer => peer!.name).join('、')
      const line = `- 与【${peers}】共同：${relation.label?.trim() || '关系'}${relation.description?.trim() ? `。${relation.description.trim()}` : '。'}`
      const relationships = appendUniqueLine(character!.relationships, line)
      return relationships == null ? [] : [{ characterId: character!.id!, relationships }]
    })
  }
  const from = characters.find(c => c.projectId === projectId && c.id === relation.fromCharacterId)
  const to = characters.find(c => c.projectId === projectId && c.id === relation.toCharacterId)
  if (!from?.id || !to?.id) return []

  const patches: Array<{ characterId: number; relationships: string }> = []
  const fromRelationships = appendUniqueLine(from.relationships, relationLine(to.name, relation, 'from'))
  if (fromRelationships != null) patches.push({ characterId: from.id, relationships: fromRelationships })

  const toRelationships = appendUniqueLine(to.relationships, relationLine(from.name, relation, 'to'))
  if (toRelationships != null) patches.push({ characterId: to.id, relationships: toRelationships })

  return patches
}

export async function syncRelationToCharacterFields(input: RelationSummaryPatchInput): Promise<number> {
  const endpoints = input.relation.participantCharacterIds?.length && input.relation.participantCharacterIds.length > 2
    ? input.relation.participantCharacterIds : [input.relation.fromCharacterId, input.relation.toCharacterId]
  const latestRows = await db.characters.bulkGet(endpoints)
  const characterById = new Map<number, Character>()
  for (const character of input.characters) {
    if (character.id != null && character.projectId === input.projectId) {
      characterById.set(character.id, character)
    }
  }
  for (const character of latestRows) {
    if (character?.id != null && character.projectId === input.projectId) {
      characterById.set(character.id, character)
    }
  }

  const patches = buildRelationshipFieldPatches({
    ...input,
    characters: Array.from(characterById.values()),
  })
  let written = 0
  for (const patch of patches) {
    const result = await adopt({
      projectId: input.projectId,
      target: 'characters',
      recordId: patch.characterId,
      mode: 'merge-diffs',
      data: { relationships: patch.relationships },
    })
    written += result.written.length
  }
  return written
}
