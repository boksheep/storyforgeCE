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
    const newRelation: CharacterRelation = {
      ...data,
      createdAt: now(),
      updatedAt: now(),
    }
    const id = await db.characterRelations.add(newRelation)
    log.info('RelationStore', 'relation.created', '角色关系已创建', { projectId: data.projectId, relationId: id })
    set({ relations: [...get().relations, { ...newRelation, id: id as number }] })
  },

  updateRelation: async (id: number, data: Partial<CharacterRelation>) => {
    const updated = await db.characterRelations.update(id, { ...data, updatedAt: now() })
    if (!updated) log.warn('RelationStore', 'relation.update.missing', '角色关系更新目标不存在', { relationId: id, fieldCount: Object.keys(data).length })
    else log.info('RelationStore', 'relation.updated', '角色关系已更新', { projectId: get().relations.find(r => r.id === id)?.projectId, relationId: id, fieldCount: Object.keys(data).length })
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
