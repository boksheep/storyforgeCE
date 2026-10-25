import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { Worldview, StoryCore, PowerSystem, DivineDesign, NaturalResources } from '../lib/types'
import { adopt } from '../lib/registry/adopt'
import { refreshSettingAssertionSourceStatus } from '../lib/fact-ledger/setting-assertions'
import { log } from '../lib/logging/logger'

interface WorldviewStore {
  worldview: Worldview | null
  storyCore: StoryCore | null
  powerSystem: PowerSystem | null
  loading: boolean
  /** 当前加载的世界组（null = 单世界模式 / 未指定） */
  activeWorldGroupId: number | null

  loadAll: (projectId: number, worldGroupId?: number | null) => Promise<void>

  saveWorldview: (data: Partial<Worldview>) => Promise<void>
  saveStoryCore: (data: Partial<StoryCore>) => Promise<void>
  savePowerSystem: (data: Partial<PowerSystem>) => Promise<void>
}

const now = () => Date.now()

function parseObjectField<T extends object>(value: unknown): T | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : undefined
  } catch {
    return undefined
  }
}

/** 兼容 adopt 旧版曾把原生对象字段序列化成 JSON string 的记录。 */
export function normalizeWorldviewRecord(row: Worldview | null | undefined): Worldview | null {
  if (!row) return null
  return {
    ...row,
    divineDesign: parseObjectField<DivineDesign>(row.divineDesign),
    naturalResources: parseObjectField<NaturalResources>(row.naturalResources),
  }
}

export const useWorldviewStore = create<WorldviewStore>((set, get) => ({
  worldview: null,
  storyCore: null,
  powerSystem: null,
  loading: false,
  activeWorldGroupId: null,

  loadAll: async (projectId: number, worldGroupId: number | null = null) => {
    set({ loading: true, activeWorldGroupId: worldGroupId })
    const [wvList, sc, psList] = await Promise.all([
      db.worldviews.where('projectId').equals(projectId).toArray(),
      db.storyCores.where('projectId').equals(projectId).first(),
      db.powerSystems.where('projectId').equals(projectId).toArray(),
    ])
    // 单世界模式（worldGroupId == null）：取第一条
    // 多世界模式：取匹配该世界组的记录
    const wv = worldGroupId == null
      ? wvList[0]
      : wvList.find(w => w.worldGroupId === worldGroupId)
    const ps = worldGroupId == null
      ? psList[0]
      : psList.find(p => p.worldGroupId === worldGroupId)
    set({
      worldview: normalizeWorldviewRecord(wv),
      storyCore: sc || null,   // 故事核心是项目级，不分世界
      powerSystem: ps || null,
      loading: false,
    })
  },

  saveWorldview: async (data: Partial<Worldview>) => {
    const { worldview, activeWorldGroupId } = get()
    const projectId = data.projectId ?? worldview?.projectId
    if (projectId == null) {
      log.warn('WorldviewStore', 'worldview.save.no-project', '世界观保存缺少项目 ID', { fieldCount: Object.keys(data).length })
      return
    }
    const { id: _, projectId: __, createdAt: ___, updatedAt: ____, worldGroupId, ...patch } = data
    const targetWorldGroupId = worldGroupId ?? activeWorldGroupId
    const adoption = await adopt({
      projectId,
      worldGroupId: targetWorldGroupId,
      target: 'worldviews',
      mode: 'replace',
      data: patch as Record<string, unknown>,
    })
    const list = await db.worldviews.where('projectId').equals(projectId).toArray()
    const next = (targetWorldGroupId == null
      ? (list.find(w => w.worldGroupId == null) ?? list[0])
      : list.find(w => w.worldGroupId === targetWorldGroupId)) ?? null
    set({ worldview: normalizeWorldviewRecord(next) })
    if (adoption.written.length) log.info('WorldviewStore', 'worldview.saved', '世界观字段已采纳', {
      projectId, worldGroupId: targetWorldGroupId, fieldCount: Object.keys(patch).length,
      written: adoption.written.length,
    })
    else log.warn('WorldviewStore', 'worldview.adopt-denied', '世界观字段未通过采纳边界', {
      projectId, worldGroupId: targetWorldGroupId, fieldCount: Object.keys(patch).length,
      skipped: adoption.skipped.length, typeErrors: adoption.typeErrors.length,
    })
  },

  saveStoryCore: async (data: Partial<StoryCore>) => {
    const { storyCore } = get()
    const projectId = data.projectId ?? storyCore?.projectId
    if (projectId == null) {
      log.warn('WorldviewStore', 'story-core.save.no-project', '故事核心保存缺少项目 ID', { fieldCount: Object.keys(data).length })
      return
    }
    const { id: _, projectId: __, createdAt: ___, updatedAt: ____, ...patch } = data
    const adoption = await adopt({
      projectId,
      target: 'storyCores',
      mode: 'replace',
      data: patch as Record<string, unknown>,
    })
    const next = await db.storyCores.where('projectId').equals(projectId).first() ?? null
    set({ storyCore: next })
    if (adoption.written.length) log.info('WorldviewStore', 'story-core.saved', '故事核心字段已采纳', {
      projectId, fieldCount: Object.keys(patch).length, written: adoption.written.length,
    })
    else log.warn('WorldviewStore', 'story-core.adopt-denied', '故事核心字段未通过采纳边界', {
      projectId, fieldCount: Object.keys(patch).length,
      skipped: adoption.skipped.length, typeErrors: adoption.typeErrors.length,
    })
  },

  savePowerSystem: async (data: Partial<PowerSystem>) => {
    const { powerSystem, activeWorldGroupId } = get()
    const projectId = data.projectId ?? powerSystem?.projectId
    let target = powerSystem
    if (!target?.id && projectId != null) {
      const list = await db.powerSystems.where('projectId').equals(projectId).toArray()
      target = (activeWorldGroupId == null
        ? (list.find(p => p.worldGroupId == null) ?? list[0])
        : list.find(p => p.worldGroupId === activeWorldGroupId)) ?? null
    }
    if (target?.id) {
      await db.powerSystems.update(target.id, { ...data, updatedAt: now() })
      await refreshSettingAssertionSourceStatus({
        projectId: target.projectId,
        table: 'powerSystems',
        recordId: target.id,
        changedFields: Object.keys(data),
      })
      set({ powerSystem: { ...target, ...data, updatedAt: now() } })
      log.info('WorldviewStore', 'power-system.updated', '力量体系已更新', {
        projectId: target.projectId, recordId: target.id, fieldCount: Object.keys(data).length,
      })
    } else if (projectId != null) {
      const newPs: PowerSystem = {
        projectId,
        name: '', description: '', levels: '', rules: '',
        worldGroupId: activeWorldGroupId,   // 多世界模式下盖章当前世界组
        createdAt: now(), updatedAt: now(),
        ...data,
      }
      const id = await db.powerSystems.add(newPs)
      set({ powerSystem: { ...newPs, id: id as number } })
      log.info('WorldviewStore', 'power-system.created', '力量体系已创建', {
        projectId, recordId: id, worldGroupId: activeWorldGroupId,
      })
    } else {
      log.warn('WorldviewStore', 'power-system.save.no-project', '力量体系保存缺少项目 ID', { fieldCount: Object.keys(data).length })
    }
  },
}))
