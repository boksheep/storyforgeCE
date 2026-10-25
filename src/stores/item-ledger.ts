/**
 * 物品流水 store — Phase 25.5.2-b
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { ItemLedgerEntry } from '../lib/types'
import { log } from '../lib/logging/logger'

interface ItemLedgerStore {
  entries: ItemLedgerEntry[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  addEntry: (entry: Omit<ItemLedgerEntry, 'id' | 'createdAt'>) => Promise<number>
  addEntries: (entries: Omit<ItemLedgerEntry, 'id' | 'createdAt'>[]) => Promise<void>
  updateEntry: (id: number, patch: Partial<ItemLedgerEntry>) => Promise<void>
  deleteEntry: (id: number) => Promise<void>
  /** 删除某章节的所有提取记录（重新提取前清理，避免重复） */
  deleteByChapter: (projectId: number, chapterId: number) => Promise<void>
}

const now = () => Date.now()

export const useItemLedgerStore = create<ItemLedgerStore>((set, get) => ({
  entries: [],
  loading: false,

  loadAll: async (projectId) => {
    set({ loading: true })
    const entries = await db.itemLedger.where('projectId').equals(projectId).toArray()
    set({ entries, loading: false })
  },

  addEntry: async (entry) => {
    const id = await db.itemLedger.add({ ...entry, createdAt: now() } as ItemLedgerEntry) as number
    set({ entries: [...get().entries, { ...entry, id, createdAt: now() } as ItemLedgerEntry] })
    return id
  },

  addEntries: async (entries) => {
    if (entries.length === 0) return
    const ts = now()
    const rows = entries.map(e => ({ ...e, createdAt: ts })) as ItemLedgerEntry[]
    const ids = await db.itemLedger.bulkAdd(rows, { allKeys: true }) as number[]
    const withIds = rows.map((r, i) => ({ ...r, id: ids[i] }))
    set({ entries: [...get().entries, ...withIds] })
    // 批量入账用 count + chapterId 概括规模，避免逐条刷屏。
    log.info(
      'ItemLedgerStore',
      'item.ledger.bulk.added',
      `批量写入物品流水 ${rows.length} 条`,
      { projectId: entries[0].projectId, chapterId: entries[0].chapterId ?? 0, count: rows.length },
    )
  },

  updateEntry: async (id, patch) => {
    await db.itemLedger.update(id, patch)
    set({ entries: get().entries.map(e => e.id === id ? { ...e, ...patch } : e) })
  },

  deleteEntry: async (id) => {
    const removed = get().entries.find(e => e.id === id)
    await db.itemLedger.delete(id)
    set({ entries: get().entries.filter(e => e.id !== id) })
    log.warn(
      'ItemLedgerStore',
      'item.ledger.deleted',
      `已删除物品流水 #${id}`,
      { projectId: removed?.projectId ?? 0, itemId: id, count: 1 },
    )
  },

  deleteByChapter: async (projectId, chapterId) => {
    const toDelete = get().entries.filter(e => e.projectId === projectId && e.chapterId === chapterId)
    await db.itemLedger.bulkDelete(toDelete.map(e => e.id!).filter(Boolean))
    set({ entries: get().entries.filter(e => !(e.projectId === projectId && e.chapterId === chapterId)) })
    // 重新提取前按章清空旧记录：不可逆的批量删除，记下规模与作用域。
    log.warn(
      'ItemLedgerStore',
      'item.ledger.cleared.chapter',
      `已清除章节 #${chapterId} 的物品流水 ${toDelete.length} 条`,
      { projectId, chapterId, count: toDelete.length },
    )
  },
}))
