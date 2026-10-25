import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type {
  CharacterDrivenPlan,
  CharacterDrivenPlanArc,
  CharacterDrivenPlotVolume,
} from '../lib/types'
import {
  parseCharacterDrivenPlanArcs,
  parseCharacterDrivenPlotVolumes,
  stringifyCharacterDrivenPlanArcs,
  stringifyCharacterDrivenPlotVolumes,
} from '../lib/types'

interface CharacterDrivenPlanStore {
  plans: CharacterDrivenPlan[]
  currentPlanId: number | null
  activePlanId: number | null
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  selectPlan: (id: number | null) => void
  createPlan: (projectId: number, name?: string) => Promise<number>
  copyAsNewVersion: (id: number) => Promise<number>
  renamePlan: (id: number, name: string) => Promise<void>
  saveInputs: (
    id: number,
    input: { arcs: CharacterDrivenPlanArc[]; userHint: string },
  ) => Promise<void>
  saveGenerated: (id: number, volumes: CharacterDrivenPlotVolume[]) => Promise<void>
  markAdopted: (id: number) => Promise<void>
  setActivePlan: (projectId: number, id: number | null) => Promise<void>
  deletePlan: (id: number) => Promise<void>
}

const now = () => Date.now()

function updatedPlan(
  plan: CharacterDrivenPlan,
  patch: Partial<CharacterDrivenPlan>,
): CharacterDrivenPlan {
  return { ...plan, ...patch }
}

export const useCharacterDrivenPlanStore = create<CharacterDrivenPlanStore>((set, get) => ({
  plans: [],
  currentPlanId: null,
  activePlanId: null,
  loading: false,

  loadAll: async (projectId) => {
    set({ loading: true })
    const [plans, project] = await Promise.all([
      db.characterDrivenPlans.where('projectId').equals(projectId).reverse().sortBy('updatedAt'),
      db.projects.get(projectId),
    ])
    const current = get().currentPlanId
    const active = plans.some(plan => plan.id === project?.activeCharacterDrivenPlanId)
      ? project?.activeCharacterDrivenPlanId ?? null
      : null
    set({
      plans,
      currentPlanId: plans.some(plan => plan.id === current)
        ? current
        : (active ?? plans[0]?.id ?? null),
      activePlanId: active,
      loading: false,
    })
  },

  selectPlan: id => set({ currentPlanId: id }),

  createPlan: async (projectId, name) => {
    const ts = now()
    const plan: CharacterDrivenPlan = {
      projectId,
      name: name?.trim() || `角色驱动方案 ${get().plans.length + 1}`,
      arcs: '[]',
      userHint: '',
      generatedVolumes: '[]',
      status: 'draft',
      version: 1,
      parentPlanId: null,
      createdAt: ts,
      updatedAt: ts,
    }
    const id = await db.characterDrivenPlans.add(plan) as number
    log.info('CharacterDrivenPlan', 'plan.created', '角色驱动方案已创建', { projectId, planId: id, version: plan.version })
    set({ plans: [{ ...plan, id }, ...get().plans], currentPlanId: id })
    return id
  },

  copyAsNewVersion: async (id) => {
    const source = get().plans.find(plan => plan.id === id) ?? await db.characterDrivenPlans.get(id)
    if (!source?.id) {
      log.warn('CharacterDrivenPlan', 'plan.copy.missing', '角色驱动方案复制源不存在', { planId: id })
      throw new Error('来源方案不存在')
    }
    const ts = now()
    const version = Math.max(1, source.version) + 1
    const copy: CharacterDrivenPlan = {
      ...source,
      id: undefined,
      name: `${source.name} v${version}`,
      arcs: stringifyCharacterDrivenPlanArcs(parseCharacterDrivenPlanArcs(source.arcs)),
      generatedVolumes: stringifyCharacterDrivenPlotVolumes(
        parseCharacterDrivenPlotVolumes(source.generatedVolumes),
      ),
      status: source.status === 'adopted' ? 'generated' : source.status,
      version,
      parentPlanId: source.id,
      createdAt: ts,
      updatedAt: ts,
    }
    const newId = await db.characterDrivenPlans.add(copy) as number
    log.info('CharacterDrivenPlan', 'plan.version.created', '角色驱动方案新版本已创建', { projectId: source.projectId, sourcePlanId: id, planId: newId, version })
    set({ plans: [{ ...copy, id: newId }, ...get().plans], currentPlanId: newId })
    return newId
  },

  renamePlan: async (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) {
      log.warn('CharacterDrivenPlan', 'plan.rename.empty', '角色驱动方案重命名为空，未写入', { planId: id })
      return
    }
    const updatedAt = now()
    await db.characterDrivenPlans.update(id, { name: trimmed, updatedAt })
    log.info('CharacterDrivenPlan', 'plan.renamed', '角色驱动方案已重命名', { planId: id, nameChars: trimmed.length })
    set({ plans: get().plans.map(plan => plan.id === id ? updatedPlan(plan, { name: trimmed, updatedAt }) : plan) })
  },

  saveInputs: async (id, input) => {
    const plan = get().plans.find(item => item.id === id) ?? await db.characterDrivenPlans.get(id)
    if (!plan) {
      log.warn('CharacterDrivenPlan', 'plan.inputs.missing', '角色驱动方案输入保存目标不存在', { planId: id })
      throw new Error('方案不存在')
    }
    const validCharacterIds = new Set(
      (await db.characters.where('projectId').equals(plan.projectId).primaryKeys()) as number[],
    )
    const normalizedArcs = input.arcs.map(arc => ({
      ...arc,
      characterId: arc.characterId != null && validCharacterIds.has(arc.characterId)
        ? arc.characterId
        : null,
    }))
    const patch: Partial<CharacterDrivenPlan> = {
      arcs: stringifyCharacterDrivenPlanArcs(normalizedArcs),
      userHint: input.userHint,
      status: 'draft',
      updatedAt: now(),
    }
    set({ plans: get().plans.map(plan => plan.id === id ? updatedPlan(plan, patch) : plan) })
    await db.characterDrivenPlans.update(id, patch)
    log.info('CharacterDrivenPlan', 'plan.inputs.saved', '角色驱动方案输入已保存', { projectId: plan.projectId, planId: id, arcCount: normalizedArcs.length, hintChars: input.userHint.length, validCharacterCount: validCharacterIds.size })
  },

  saveGenerated: async (id, volumes) => {
    const parsed = parseCharacterDrivenPlotVolumes(volumes)
    if (parsed.length === 0) {
      log.warn('CharacterDrivenPlan', 'plan.generated.empty', '角色驱动方案生成结果没有有效卷', { planId: id, inputVolumeCount: volumes.length })
      throw new Error('生成结果没有可保存的有效卷')
    }
    const patch: Partial<CharacterDrivenPlan> = {
      generatedVolumes: stringifyCharacterDrivenPlotVolumes(parsed),
      status: 'generated',
      updatedAt: now(),
    }
    await db.characterDrivenPlans.update(id, patch)
    log.info('CharacterDrivenPlan', 'plan.generated.saved', '角色驱动方案生成卷已保存', { planId: id, volumeCount: parsed.length })
    set({ plans: get().plans.map(plan => plan.id === id ? updatedPlan(plan, patch) : plan) })
  },

  markAdopted: async (id) => {
    const patch: Partial<CharacterDrivenPlan> = { status: 'adopted', updatedAt: now() }
    await db.characterDrivenPlans.update(id, patch)
    log.info('CharacterDrivenPlan', 'plan.marked-adopted', '角色驱动方案已标记采纳', { planId: id })
    set({ plans: get().plans.map(plan => plan.id === id ? updatedPlan(plan, patch) : plan) })
  },

  setActivePlan: async (projectId, id) => {
    if (id != null) {
      const plan = get().plans.find(item => item.id === id) ?? await db.characterDrivenPlans.get(id)
      if (!plan || plan.projectId !== projectId) {
        log.warn('CharacterDrivenPlan', 'plan.activate.denied', '角色驱动方案激活被项目边界拒绝', { projectId, planId: id })
        throw new Error('不能激活其它项目的角色驱动方案')
      }
    }
    await db.projects.update(projectId, {
      activeCharacterDrivenPlanId: id,
      updatedAt: now(),
    })
    set({ activePlanId: id })
    log.info('CharacterDrivenPlan', 'plan.active.changed', '项目活动角色驱动方案已更新', { projectId, planId: id })
  },

  deletePlan: async (id) => {
    const plan = get().plans.find(item => item.id === id) ?? await db.characterDrivenPlans.get(id)
    if (!plan?.id) {
      log.warn('CharacterDrivenPlan', 'plan.delete.missing', '角色驱动方案删除目标不存在', { planId: id })
      return
    }
    const updatedAt = now()
    await db.transaction('rw', db.characterDrivenPlans, db.projects, async () => {
      const children = await db.characterDrivenPlans.where('parentPlanId').equals(id).toArray()
      if (children.length) {
        await db.characterDrivenPlans.bulkUpdate(children.map(child => ({
          key: child.id!,
          changes: { parentPlanId: null, updatedAt },
        })))
      }
      const project = await db.projects.get(plan.projectId)
      if (project?.activeCharacterDrivenPlanId === id) {
        await db.projects.update(plan.projectId, {
          activeCharacterDrivenPlanId: null,
          updatedAt,
        })
      }
      await db.characterDrivenPlans.delete(id)
    })
    log.info('CharacterDrivenPlan', 'plan.deleted', '角色驱动方案已删除并解除子版本引用', { projectId: plan.projectId, planId: id })
    const remaining = get().plans
      .filter(item => item.id !== id)
      .map(item => item.parentPlanId === id ? updatedPlan(item, { parentPlanId: null, updatedAt }) : item)
    set({
      plans: remaining,
      currentPlanId: get().currentPlanId === id ? (remaining[0]?.id ?? null) : get().currentPlanId,
      activePlanId: get().activePlanId === id ? null : get().activePlanId,
    })
  },
}))
