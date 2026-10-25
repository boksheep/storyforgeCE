export interface CultivationStage {
  id: string
  name: string
  features?: string
  breakthrough?: string
  parentStageIds: string[]
  branchLabel?: string
  tier?: number
}

/** 世界底层能量之上的具体修炼流派；每个世界可有多套。 */
export interface CultivationSystem {
  id?: number
  projectId: number
  name: string
  description: string
  /** CultivationStage[] JSON；阶段间以 parentStageIds 构成 DAG。 */
  stages: string
  worldGroupId?: number | null
  createdAt: number
  updatedAt: number
}

export interface CultivationStageValidation {
  valid: boolean
  errors: string[]
}

export function parseCultivationStages(value: string | undefined): CultivationStage[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(row => row && typeof row === 'object')
      .map((row: Record<string, unknown>) => ({
        id: typeof row.id === 'string' ? row.id : '',
        name: typeof row.name === 'string' ? row.name : '',
        features: typeof row.features === 'string' ? row.features : '',
        breakthrough: typeof row.breakthrough === 'string' ? row.breakthrough : '',
        parentStageIds: Array.isArray(row.parentStageIds)
          ? row.parentStageIds.filter((id): id is string => typeof id === 'string')
          : [],
        branchLabel: typeof row.branchLabel === 'string' ? row.branchLabel : '',
        tier: typeof row.tier === 'number' && Number.isFinite(row.tier) ? row.tier : undefined,
      }))
  } catch {
    return []
  }
}

export function stringifyCultivationStages(stages: readonly CultivationStage[]): string {
  return JSON.stringify(stages)
}

/** 拒绝重复 ID、悬空父节点、自环和任意有向环。 */
export function validateCultivationStages(stages: readonly CultivationStage[]): CultivationStageValidation {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const stage of stages) {
    if (!stage.id.trim()) errors.push('存在缺少 ID 的境界')
    else if (ids.has(stage.id)) errors.push(`境界 ID 重复：${stage.id}`)
    ids.add(stage.id)
    if (!stage.name.trim()) errors.push(`境界 ${stage.id || '（未命名）'} 缺少名称`)
  }
  for (const stage of stages) {
    for (const parentId of stage.parentStageIds) {
      if (parentId === stage.id) errors.push(`境界「${stage.name}」不能以自身为前置`)
      else if (!ids.has(parentId)) errors.push(`境界「${stage.name}」引用了不存在的前置 ${parentId}`)
    }
  }

  const parents = new Map(stages.map(stage => [stage.id, stage.parentStageIds]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const parentId of parents.get(id) ?? []) {
      if (visit(parentId)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  if (stages.some(stage => visit(stage.id))) errors.push('境界关系中存在有向环，修炼路径必须是 DAG')
  return { valid: errors.length === 0, errors: [...new Set(errors)] }
}

/** 计算稳定层级：根节点为 0，后续节点为所有父节点最大层级 + 1。 */
export function cultivationStageTiers(stages: readonly CultivationStage[]): Map<string, number> {
  const byId = new Map(stages.map(stage => [stage.id, stage]))
  const memo = new Map<string, number>()
  const active = new Set<string>()
  const tierOf = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!
    if (active.has(id)) return 0
    active.add(id)
    const stage = byId.get(id)
    const tier = !stage || stage.parentStageIds.length === 0
      ? 0
      : Math.max(...stage.parentStageIds.map(parentId => tierOf(parentId))) + 1
    active.delete(id)
    memo.set(id, tier)
    return tier
  }
  for (const stage of stages) tierOf(stage.id)
  return memo
}
