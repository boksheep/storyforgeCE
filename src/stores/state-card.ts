/**
 * 状态表 Store — 管理角色/地点/物品/势力的状态卡 CRUD
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { StateCard, StateCategory, StateDiffItem, StateField } from '../lib/types'
import { parseFields, stringifyFields } from '../lib/types/state-card'
import { adopt } from '../lib/registry/adopt'
import { log } from '../lib/logging/logger'
import { matchesStateCardReference } from '../lib/state-card/selection'

const now = () => Date.now()

interface StateCardStore {
  cards: StateCard[]
  loading: boolean

  /** 加载项目的全部状态卡 */
  loadAll: (projectId: number) => Promise<void>

  /** 新增一张状态卡 */
  addCard: (card: Omit<StateCard, 'id' | 'createdAt' | 'updatedAt'>) => Promise<number>

  /** 更新一张状态卡 */
  updateCard: (id: number, data: Partial<StateCard>) => Promise<void>

  /** 删除一张状态卡 */
  deleteCard: (id: number) => Promise<void>

  /** 批量应用 diff（用于章后审核确认） */
  applyDiffs: (projectId: number, diffs: StateDiffItem[], chapterId?: number) => Promise<void>

  /** 仅供 UI 高亮相关状态卡；AI 文本由 CONTEXT_SOURCES 装配。 */
  selectStateCardIds: (referenceText: string, extraIds?: number[]) => { matchedIds: number[]; allIds: number[] }

  // ── Phase G1 ──
  /** 获取角色当前状态（从状态卡中筛选） */
  getCharacterState: (characterName: string) => { fields: { key: string; value: string }[]; card: StateCard | null }
}

export const useStateCardStore = create<StateCardStore>((set, get) => ({
  cards: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    try {
      const cards = await db.stateCards.where('projectId').equals(projectId).toArray()
      set({ cards, loading: false })
    } catch (err) {
      log.error('StateCard', 'statecard', '[StateCard] loadAll 失败:', undefined, err)
      set({ loading: false })
    }
  },

  addCard: async (card) => {
    try {
      const newCard: StateCard = { ...card, createdAt: now(), updatedAt: now() }
      const id = await db.stateCards.add(newCard) as number
      set({ cards: [...get().cards, { ...newCard, id }] })
      log.info('StateCard', 'statecard', '[StateCard] 新增:', { entityName: card.entityName, id })
      return id
    } catch (err) {
      log.error('StateCard', 'statecard', '[StateCard] addCard 失败:', undefined, err)
      throw err
    }
  },

  updateCard: async (id, data) => {
    try {
      const patch = { ...data, updatedAt: now() }
      await db.stateCards.update(id, patch)
      set({ cards: get().cards.map(c => c.id === id ? { ...c, ...patch } : c) })
    } catch (err) {
      log.error('StateCard', 'statecard', '[StateCard] updateCard 失败:', { id }, err)
      throw err
    }
  },

  deleteCard: async (id) => {
    try {
      await db.stateCards.delete(id)
      set({ cards: get().cards.filter(c => c.id !== id) })
      log.info('StateCard', 'statecard', '[StateCard] 删除:', { id })
    } catch (err) {
      log.error('StateCard', 'statecard', '[StateCard] deleteCard 失败:', { id }, err)
      throw err
    }
  },

  applyDiffs: async (projectId, diffs, chapterId) => {
    const { cards } = get()
    const knownCharacters = new Set(
      (await db.characters.where('projectId').equals(projectId).toArray())
        .map(character => character.name.trim().toLocaleLowerCase()),
    )
    const validDiffs = diffs.filter(diff =>
      diff.category === 'character'
      && knownCharacters.has(diff.entityName.trim().toLocaleLowerCase()),
    )

    // 先按 (category, entityName) 聚合本批次的所有 diff，逐实体把字段合并到一起，再统一写库。
    // 修复两个 bug：
    //  ① 同一新实体的多条字段变更原会各建一张卡（重复卡）；
    //  ② 同一已有实体的多条字段变更原各自从陈旧快照 parse → 互相覆盖、只剩最后一条。
    type Acc = { category: StateCategory; entityName: string; existing: StateCard | null; fields: StateField[] }
    const byEntity = new Map<string, Acc>()

    for (const diff of validDiffs) {
      const key = `${diff.category}\u0000${diff.entityName}`
      let acc = byEntity.get(key)
      if (!acc) {
        const existing = cards.find(c => c.entityName === diff.entityName && c.category === diff.category) || null
        acc = {
          category: diff.category, entityName: diff.entityName,
          existing,
          fields: existing ? parseFields(existing.fields) : [],
        }
        byEntity.set(key, acc)
      }
      const idx = acc.fields.findIndex(f => f.key === diff.field)
      if (idx >= 0) acc.fields[idx].value = diff.newValue
      else acc.fields.push({ key: diff.field, value: diff.newValue })
    }

    try {
      const result = await adopt({
        projectId,
        target: 'stateCards',
        mode: 'add-many',
        data: [...byEntity.values()].map(acc => ({
          category: 'character',
          entityName: acc.entityName,
          fields: stringifyFields(acc.fields),
          lastChapterId: chapterId ?? null,
        })),
      })
      const refreshed = await db.stateCards.where('projectId').equals(projectId).toArray()
      set({ cards: refreshed })
      log.info('StateCard', 'statecard', `[StateCard] applyDiffs: ${validDiffs.length} 条角色变更已应用（实体 ${byEntity.size}，写入 ${result.written.length}）`)
    } catch (err) {
      log.error('StateCard', 'statecard', '[StateCard] applyDiffs 失败:', undefined, err)
      throw err
    }
  },

  selectStateCardIds: (referenceText: string, extraIds?: number[]) => {
    const { cards } = get()
    const allIds = cards.flatMap(card => card.id == null ? [] : [card.id])
    if (!referenceText.trim()) return { matchedIds: allIds, allIds }
    const extraSet = new Set(extraIds ?? [])
    const matchedIds = cards.flatMap(card => {
      if (card.id == null) return []
      const matches = extraSet.has(card.id) || matchesStateCardReference(card, referenceText)
      return matches ? [card.id] : []
    })
    return { matchedIds, allIds }
  },
  // ── Phase G1 ──
  getCharacterState: (characterName: string) => {
    const card = get().cards.find(
      c => c.category === 'character' && c.entityName === characterName
    )
    if (!card) return { fields: [], card: null }
    return { fields: parseFields(card.fields), card }
  },
}))
