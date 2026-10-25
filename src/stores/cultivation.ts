import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import {
  parseCultivationStages,
  validateCultivationStages,
  type CultivationSystem,
} from '../lib/types/cultivation'
import {
  clearCultivationSystemReferences,
  clearRemovedCultivationStageReferences,
  refreshCultivationProgressStageSources,
} from '../lib/cultivation/lifecycle'
import { refreshSettingAssertionSourceStatus } from '../lib/fact-ledger/setting-assertions'
import { transactionTablesForReferences } from '../lib/registry/lifecycle'

interface CultivationStore {
  systems: CultivationSystem[]
  loading: boolean
  loadAll: (projectId: number) => Promise<void>
  addSystem: (system: Omit<CultivationSystem, 'id' | 'createdAt' | 'updatedAt'>) => Promise<number>
  updateSystem: (id: number, patch: Partial<CultivationSystem>) => Promise<void>
  deleteSystem: (id: number) => Promise<void>
}

const now = () => Date.now()

export const useCultivationStore = create<CultivationStore>((set, get) => ({
  systems: [],
  loading: false,

  loadAll: async (projectId) => {
    set({ loading: true })
    const systems = await db.cultivationSystems.where('projectId').equals(projectId).toArray()
    set({ systems, loading: false })
  },

  addSystem: async (system) => {
    const validation = validateCultivationStages(parseCultivationStages(system.stages))
    if (!validation.valid) {
      log.warn('CultivationStore', 'cultivation.create.invalid', '修炼体系阶段校验失败', { projectId: system.projectId, issueCount: validation.errors.length })
      throw new Error(validation.errors.join('；'))
    }
    const timestamp = now()
    const row = { ...system, createdAt: timestamp, updatedAt: timestamp }
    const id = await db.cultivationSystems.add(row) as number
    log.info('CultivationStore', 'cultivation.created', '修炼体系已创建', { projectId: system.projectId, systemId: id, stageCount: parseCultivationStages(system.stages).length })
    set({ systems: [...get().systems, { ...row, id }] })
    return id
  },

  updateSystem: async (id, patch) => {
    const current = get().systems.find(system => system.id === id) ?? await db.cultivationSystems.get(id)
    if (!current) {
      log.warn('CultivationStore', 'cultivation.update.missing', '修炼体系更新目标不存在', { systemId: id, fieldCount: Object.keys(patch).length })
      return
    }
    let removedStageIds = new Set<string>()
    if (patch.stages !== undefined) {
      const nextStages = parseCultivationStages(patch.stages)
      const validation = validateCultivationStages(nextStages)
      if (!validation.valid) {
        log.warn('CultivationStore', 'cultivation.update.invalid', '修炼体系阶段校验失败', { projectId: current.projectId, systemId: id, issueCount: validation.errors.length })
        throw new Error(validation.errors.join('；'))
      }
      const nextIds = new Set(nextStages.map(stage => stage.id))
      removedStageIds = new Set(parseCultivationStages(current.stages)
        .map(stage => stage.id)
        .filter(stageId => !nextIds.has(stageId)))
    }
    const next = { ...patch, updatedAt: now() }
    await db.transaction('rw', transactionTablesForReferences('cultivationSystems'), async () => {
      await db.cultivationSystems.update(id, next)
      await clearRemovedCultivationStageReferences(current.projectId, id, removedStageIds)
      if (patch.stages !== undefined) {
        await refreshCultivationProgressStageSources({
          projectId: current.projectId,
          systemId: id,
          previousStages: current.stages,
          nextStages: patch.stages,
        })
      }
    })
    await refreshSettingAssertionSourceStatus({
      projectId: current.projectId,
      table: 'cultivationSystems',
      recordId: id,
      changedFields: Object.keys(patch),
    })
    set({ systems: get().systems.map(system => system.id === id ? { ...system, ...next } : system) })
    log.info('CultivationStore', 'cultivation.updated', '修炼体系及关联来源已更新', { projectId: current.projectId, systemId: id, fieldCount: Object.keys(patch).length, removedStageCount: removedStageIds.size })
  },

  deleteSystem: async (id) => {
    const current = get().systems.find(system => system.id === id) ?? await db.cultivationSystems.get(id)
    if (!current) {
      log.warn('CultivationStore', 'cultivation.delete.missing', '修炼体系删除目标不存在', { systemId: id })
      return
    }
    await db.transaction('rw', transactionTablesForReferences('cultivationSystems'), async () => {
      await clearCultivationSystemReferences(current.projectId, new Set([id]))
      await db.cultivationSystems.delete(id)
    })
    set({ systems: get().systems.filter(system => system.id !== id) })
    log.info('CultivationStore', 'cultivation.deleted', '修炼体系及关联引用已清除', { projectId: current.projectId, systemId: id })
  },
}))
