import { moralAxisColor } from '../character/character-axes'
import type { Character, CharacterRelation } from '../types'

export interface RelationGraphNode {
  id: string
  name: string
  color: string
  kind: 'character' | 'group'
  relationId?: number
}

export interface RelationGraphLink {
  source: string
  target: string
  relationIds: number[]
  labels: string[]
  color: string
  bidirectional: boolean
}

const COLORS: Record<string, string> = {
  family: '#f59e0b', lover: '#ec4899', friend: '#22c55e', rival: '#f97316',
  enemy: '#ef4444', master: '#a78bfa', student: '#60a5fa', ally: '#14b8a6',
  subordinate: '#94a3b8', other: '#6b7280',
}

/** 一段多人关系只生成一个关系节点与 N 条辐射线，避免 N² 两两连线。 */
export function buildRelationGraphData(characters: Character[], relations: CharacterRelation[]) {
  const byId = new Map(characters.filter(character => character.id != null)
    .map(character => [character.id!, character]))
  const used = new Set<number>()
  const groupNodes: RelationGraphNode[] = []
  const links: RelationGraphLink[] = []
  const pairLinks = new Map<string, RelationGraphLink>()

  relations.forEach((relation, index) => {
    const participants = relation.participantCharacterIds?.length && relation.participantCharacterIds.length > 2
      ? relation.participantCharacterIds : [relation.fromCharacterId, relation.toCharacterId]
    if (new Set(participants).size !== participants.length || participants.some(id => !byId.has(id))) return
    participants.forEach(id => used.add(id))
    const color = COLORS[relation.relationType] ?? COLORS.other
    const label = relation.label?.trim() || relation.relationType
    const relationId = relation.id ?? -(index + 1)
    if (participants.length > 2) {
      const hubId = `group:${relationId}`
      groupNodes.push({ id: hubId, name: label, color, kind: 'group', relationId })
      participants.forEach(id => links.push({ source: hubId, target: String(id),
        relationIds: [relationId], labels: [label], color, bidirectional: true }))
      return
    }
    const [from, to] = participants
    const key = `${Math.min(from, to)}:${Math.max(from, to)}`
    const existing = pairLinks.get(key)
    if (existing) {
      existing.relationIds.push(relationId)
      existing.labels.push(label)
    } else {
      pairLinks.set(key, { source: String(from), target: String(to),
        relationIds: [relationId], labels: [label], color, bidirectional: relation.isBidirectional })
    }
  })

  const nodes: RelationGraphNode[] = characters.filter(character => character.id != null && used.has(character.id))
    .map(character => ({ id: String(character.id), name: character.name,
      color: moralAxisColor(character.moralAxis), kind: 'character' }))
  return { nodes: [...nodes, ...groupNodes], links: [...pairLinks.values(), ...links] }
}
