import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type { CharacterRelation } from '../lib/types'

interface CharacterRelationStore {
  relations: CharacterRelation[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  addRelation: (relation: Omit<CharacterRelation, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateRelation: (id: number, data: Partial<CharacterRelation>) => Promise<void>
  deleteRelation: (id: number) => Promise<void>
}

const now = () => Date.now()

async function validateRelation(projectId: number, relation: Pick<CharacterRelation,
  'fromCharacterId' | 'toCharacterId' | 'participantCharacterIds'>): Promise<number> {
  const participants = relation.participantCharacterIds?.length
    ? relation.participantCharacterIds : [relation.fromCharacterId, relation.toCharacterId]
  if (relation.fromCharacterId === relation.toCharacterId || new Set(participants).size !== participants.length
    || participants.length < 2 || (relation.participantCharacterIds?.length && participants.length < 3)
    || !participants.includes(relation.fromCharacterId) || !participants.includes(relation.toCharacterId)) {
    throw new Error('关系参与角色无效；多人关系至少需要三名不同角色。')
  }
  const rows = await db.characters.bulkGet(participants)
  if (rows.some(row => !row || row.projectId !== projectId)) throw new Error('关系包含其他项目或不存在的角色。')
  return participants.length
}

export const useCharacterRelationStore = create<CharacterRelationStore>((set, get) => ({
  relations: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    const relations = await db.characterRelations
      .where('projectId')
      .equals(projectId)
      .toArray()
    set({ relations, loading: false })
  },

  addRelation: async (data) => {
    const participantCount = await validateRelation(data.projectId, data)
    const newRelation: CharacterRelation = {
      ...data,
      createdAt: now(),
      updatedAt: now(),
    }
    const id = await db.characterRelations.add(newRelation)
    log.info('RelationStore', 'relation.created', '角色关系已创建', { projectId: data.projectId, relationId: id, participantCount })
    set({ relations: [...get().relations, { ...newRelation, id: id as number }] })
  },

  updateRelation: async (id: number, data: Partial<CharacterRelation>) => {
    const current = await db.characterRelations.get(id)
    if (!current) throw new Error('关系不存在。')
    const participantCount = await validateRelation(current.projectId, { ...current, ...data })
    const updated = await db.characterRelations.update(id, { ...data, updatedAt: now() })
    if (!updated) log.warn('RelationStore', 'relation.update.missing', '角色关系更新目标不存在', { relationId: id, fieldCount: Object.keys(data).length })
    else log.info('RelationStore', 'relation.updated', '角色关系已更新', { projectId: current.projectId, relationId: id, fieldCount: Object.keys(data).length, participantCount })
    set({
      relations: get().relations.map((r) =>
        r.id === id ? { ...r, ...data, updatedAt: now() } : r
      ),
    })
  },

  deleteRelation: async (id: number) => {
    const relation = get().relations.find(r => r.id === id)
    await db.characterRelations.delete(id)
    log.info('RelationStore', 'relation.deleted', '角色关系删除已执行', { projectId: relation?.projectId, relationId: id, existedInStore: Boolean(relation) })
    set({ relations: get().relations.filter((r) => r.id !== id) })
  },
}))
