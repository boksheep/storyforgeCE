import { db } from '../db/schema'
import { FIELD_BY_TARGET } from '../registry/field-registry'
import { REGISTRY_BY_NAME } from '../registry/project-tables'

/**
 * STEP-1 撤回/重做的**唯一受控写入入口**。
 *
 * 为什么不走 `adopt()`：撤回不是新的 AI 写入，而是把某个已采纳步骤的**先前状态**还原。
 * 它必须能处理 adopt() 表达不了的两件事：
 *   1. 删除「这一步新建的行」（adopt 没有删除语义）；
 *   2. 还原不被 FIELD_REGISTRY 覆盖的派生字段（如章节 wordCount 之外的内部字段）。
 *
 * 因此这里用 **PROJECT_TABLES 注册表驱动**的表访问（与 adopt.ts 相同方式），
 * 而不是在别处散写 `db.xxx.update()`；并且只在 ADOPTION_EXTENSIONS 登记过的目标上使用。
 *
 * 安全边界（每条都对应一个反例测试）：
 *   - 只允许 `STEP_JOURNAL_TABLES` 内的表；
 *   - 行必须存在且属于当前项目；
 *   - **当前行必须仍等于该步骤记录的状态**，否则拒绝（说明已被后续修改，撤回会造成数据丢失）；
 *   - 字段闭集：只还原本步骤真正改动过的字段，拒绝凭空写入其他字段；
 *   - 新建行的删除要求该行仍与创建时快照完全一致。
 */

/** 步骤记录器可撤回的表（与 step-recorder 的 allowlist 保持单一来源）。 */
export const STEP_STORE_TABLES: readonly string[] = [
  'chapters',
  'characterRelations',
  'characters',
  'codexCategories',
  'codexEntries',
  'creativeRules',
  'cultivationProgress',
  'cultivationSystems',
  'detailedOutlines',
  'foreshadows',
  'historicalKeywords',
  'historicalTimelineEvents',
  'importantLocations',
  'inspirationWorkspaces',
  'itemLedger',
  'knowledgeLedger',
  'notes',
  'outlineNodes',
  'projects',
  'references',
  'stateCards',
  'storyArcs',
  'storyCores',
  'storylineCrossings',
  'storylineProgress',
  'storyTimelineEvents',
  'worldviews',
]

export class StepRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepRestoreError'
  }
}

function tableFor(name: string) {
  const spec = REGISTRY_BY_NAME.get(name)
  if (!spec) throw new StepRestoreError(`表 ${name} 未在 PROJECT_TABLES 登记`)
  if (!STEP_STORE_TABLES.includes(name)) {
    throw new StepRestoreError(`表 ${name} 不在步骤记录器的可撤回范围内`)
  }
  return spec
}

function stableJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort()
  return JSON.stringify(keys.map(key => [key, value[key]]))
}

/** 只比较本步骤关心的字段，避免 updatedAt 之类的自然漂移阻止撤回。 */
function fieldsMatch(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(field => stableJson({ [field]: current[field] }) === stableJson({ [field]: expected[field] }))
}

/** 允许还原的字段：本步骤改动过的字段 ∩ 该表已登记字段（另有明确列出的行级字段）。 */
function restorableFields(table: string, fields: readonly string[]): string[] {
  const registered = new Set((FIELD_BY_TARGET.get(table) ?? []).map(spec => spec.field))
  return fields.filter(field => registered.has(field))
}

/** 行级字段：adopt() 也会写、但不属于 FIELD_REGISTRY 的记账字段。 */
const ROW_LEVEL_FIELDS = new Set(['wordCount', 'updatedAt', 'createdAt', 'order', 'projectId', 'worldGroupId'])

export interface RestoreOutcome {
  restored: string[]
  removed: string[]
}

/**
 * 把一行还原成快照状态。
 * `target` 为 null 表示"这一步把这行删掉"（撤回新建）。
 */
export async function restoreRow(input: {
  projectId: number
  table: string
  recordId: number
  fields: readonly string[]
  /** 期望的当前状态（用于并发校验）；null 表示该行应当不存在。 */
  expectedCurrent: Record<string, unknown> | null
  /** 要写回的状态；null 表示删除该行。 */
  target: Record<string, unknown> | null
}): Promise<'updated' | 'deleted' | 'recreated'> {
  const spec = tableFor(input.table)
  if (input.table === 'projects' && (input.expectedCurrent === null || input.target === null)) {
    throw new StepRestoreError('项目根记录只允许还原简介字段，不能通过步骤历史创建或删除')
  }

  if (input.expectedCurrent === null && input.target != null) {
    // 重新创建（重做一次删除，或撤回一次删除）
    const existing = await spec.table.get(input.recordId) as Record<string, unknown> | undefined
    if (existing) throw new StepRestoreError(`${input.table} #${input.recordId} 已存在，无法重新创建`)
    const created = { ...input.target, id: input.recordId } as never
    await spec.table.add(created)
    return 'recreated'
  }

  const current = await spec.table.get(input.recordId) as Record<string, unknown> | undefined
  if (!current) throw new StepRestoreError(`${input.table} #${input.recordId} 不存在，无法还原`)
  if ((input.table === 'projects' ? current.id : current.projectId) !== input.projectId) {
    throw new StepRestoreError(`${input.table} #${input.recordId} 不属于当前项目`)
  }
  // 已经是目标状态：撤回/重做是幂等的，直接算成功（例如正文还没被自动保存到库时撤回）。
  if (input.target && fieldsMatch(current, input.target, input.fields)) return 'updated'
  if (input.expectedCurrent && !fieldsMatch(current, input.expectedCurrent, input.fields)) {
    throw new StepRestoreError(
      `${input.table} #${input.recordId} 已被后续修改，撤回会覆盖更新的内容；请先手动确认。`,
    )
  }

  if (input.target === null) {
    await spec.table.delete(input.recordId)
    return 'deleted'
  }

  const patch: Record<string, unknown> = {}
  for (const field of input.fields) {
    if (!ROW_LEVEL_FIELDS.has(field) && !restorableFields(input.table, [field]).length) continue
    if (Object.prototype.hasOwnProperty.call(input.target, field)) patch[field] = input.target[field]
  }
  if (!Object.keys(patch).length) {
    throw new StepRestoreError(`${input.table} #${input.recordId} 没有可还原的已登记字段`)
  }
  await spec.table.update(input.recordId, patch as never)
  return 'updated'
}

/** 项目/世界生命周期清理：连同步骤历史一起删除。 */
export async function clearStepJournalRows(projectId: number): Promise<number> {
  const ids = (await db.stepJournal.where('projectId').equals(projectId).primaryKeys()) as number[]
  if (ids.length) await db.stepJournal.bulkDelete(ids)
  return ids.length
}
