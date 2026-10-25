import { db } from '../db/schema'
import { log } from '../logging/logger'
import { enqueueStepRecord } from '../history/step-recorder'
import { ADOPTION_BY_TARGET } from '../registry/adoption-schema'
import { adopt } from '../registry/adopt'
import { REGISTRY_BY_NAME } from '../registry/project-tables'
import { useCharacterStore } from '../../stores/character'
import { useCodexStore } from '../../stores/codex'
import { useCreativeRulesStore } from '../../stores/project-singletons'
import { useDetailedOutlineStore } from '../../stores/detailed-outline'
import { useForeshadowStore } from '../../stores/foreshadow'
import { useLocationStore } from '../../stores/location'
import { useNoteStore } from '../../stores/note'
import { useOutlineStore } from '../../stores/outline'
import { useProjectStore } from '../../stores/project'
import { useStoryArcStore } from '../../stores/story-arc'
import { useStoryTimelineStore } from '../../stores/story-timeline'
import { useWorldviewStore } from '../../stores/worldview'
import type { AgentContextEvidence } from './context-policy'
import type { AgentTeamBudgetEvidence } from './team-budget'
import { parseProjectCreateDraft, PROJECT_CREATE_POLICY, type ProjectCreateTarget } from './project-create-copilot'
import { parseProjectFieldDraft, PROJECT_FIELD_EDIT_POLICY, type ProjectFieldTarget } from './project-field-copilot'

export interface NativeOperationDraft {
  id: string
  kind: 'update' | 'create'
  target: string
  recordId?: number | null
  expectedUpdatedAt?: number | null
  patch: Record<string, unknown>
  evidence: string
}

interface NativeOperationSnapshot {
  id: string
  kind: NativeOperationDraft['kind']
  target: string
  recordId: number | null
  rowJson: string | null
}

export interface NativeOperationsCandidatePayload {
  version: 1
  agentId: 'project-native'
  taskId: string
  label: string
  contextSources: string[]
  contextEvidence?: AgentContextEvidence
  teamBudgetEvidence?: AgentTeamBudgetEvidence
  baseSnapshot: {
    projectId: number
    worldGroupId: number | null
    operations: NativeOperationSnapshot[]
  }
  dependsOnTaskIds?: string[]
}

export interface PreparedNativeOperationsCandidate {
  payload: NativeOperationsCandidatePayload
  draft: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOperation(raw: unknown): NativeOperationDraft {
  if (!isObject(raw) || (raw.kind !== 'update' && raw.kind !== 'create')
    || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(raw.id)
    || typeof raw.target !== 'string' || !isObject(raw.patch)
    || !Object.keys(raw.patch).length || typeof raw.evidence !== 'string'
    || !raw.evidence.trim()) {
    throw new Error('操作候选缺少合法的 id、kind、target、patch 或读取依据。')
  }
  return raw as unknown as NativeOperationDraft
}

function parseDraft(text: string): NativeOperationDraft[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('多操作候选必须是 JSON。') }
  if (!isObject(raw) || !Array.isArray(raw.operations)
    || raw.operations.length < 1 || raw.operations.length > 8) {
    throw new Error('多操作候选必须包含 1–8 条 operations。')
  }
  const operations = raw.operations.map(assertOperation)
  if (new Set(operations.map(op => op.id)).size !== operations.length) {
    throw new Error('操作 ID 不能重复。')
  }
  return operations
}

async function readTargetRow(input: {
  projectId: number
  worldGroupId: number | null
  target: string
  recordId: number | null
}): Promise<Record<string, unknown> | null> {
  const spec = REGISTRY_BY_NAME.get(input.target)
  if (!spec || spec.owner !== 'project') throw new Error(`目标表 ${input.target} 未登记为项目数据。`)
  if (ADOPTION_BY_TARGET.has(input.target)) {
    if (!Number.isInteger(input.recordId) || (input.recordId ?? 0) < 1) {
      throw new Error(`${input.target} 定点修改需要记录 ID。`)
    }
    const row = await spec.table.get(input.recordId!) as Record<string, unknown> | undefined
    if (!row || (input.target === 'projects'
      ? row.id !== input.projectId : row.projectId !== input.projectId)) {
      throw new Error(`${input.target} #${input.recordId} 不属于当前项目。`)
    }
    if (spec.worldScoped && (row.worldGroupId ?? null) !== input.worldGroupId) {
      throw new Error(`${input.target} #${input.recordId} 不属于当前世界。`)
    }
    return row
  }
  if (input.recordId != null) throw new Error(`${input.target} 单例修改不能指定记录 ID。`)
  const rows = await spec.table.where('projectId').equals(input.projectId).toArray() as Record<string, unknown>[]
  const scoped = spec.worldScoped
    ? rows.filter(row => (row.worldGroupId ?? null) === input.worldGroupId)
    : rows
  if (scoped.length > 1) throw new Error(`${input.target} 存在多条单例记录，无法唯一定位。`)
  return scoped[0] ?? null
}

function categoryReference(operation: NativeOperationDraft): string | null {
  const value = operation.patch.categoryId
  return operation.kind === 'create' && operation.target === 'codexEntries'
    && typeof value === 'string' && /^\$[a-zA-Z0-9_-]{1,40}$/.test(value)
    ? value.slice(1) : null
}

function validatePatch(operation: NativeOperationDraft, earlier: ReadonlyMap<string, NativeOperationDraft>): void {
  if (operation.kind === 'update') {
    if (!Object.prototype.hasOwnProperty.call(PROJECT_FIELD_EDIT_POLICY, operation.target)) {
      throw new Error(`${operation.target} 没有受控字段修改策略；需专门领域生命周期。`)
    }
    parseProjectFieldDraft(JSON.stringify(operation.patch), operation.target as ProjectFieldTarget)
    return
  }
  if (!Object.prototype.hasOwnProperty.call(PROJECT_CREATE_POLICY, operation.target)) {
    throw new Error(`${operation.target} 没有受控新增策略；需专门领域生命周期。`)
  }
  const reference = categoryReference(operation)
  if (reference && earlier.get(reference)?.target !== 'codexCategories'
    || reference && earlier.get(reference)?.kind !== 'create') {
    throw new Error(`词条分类引用 $${reference} 必须指向本候选前面的分类新增操作。`)
  }
  const patch = reference ? { ...operation.patch, categoryId: 1 } : operation.patch
  parseProjectCreateDraft(JSON.stringify(patch), operation.target as ProjectCreateTarget)
}

async function assertNoIdentityConflict(input: {
  projectId: number
  worldGroupId: number | null
  operation: NativeOperationDraft
  patch: Record<string, unknown>
}): Promise<void> {
  const adoption = ADOPTION_BY_TARGET.get(input.operation.target)
  const spec = REGISTRY_BY_NAME.get(input.operation.target)
  if (!adoption || !spec) throw new Error(`${input.operation.target} 缺少新增生命周期登记。`)
  const fields = adoption.identity === 'id' ? ['id']
    : adoption.identity === 'name' ? ['name'] : adoption.identity.fields
  const rows = await spec.table.where('projectId').equals(input.projectId).toArray() as Record<string, unknown>[]
  const duplicate = rows.some(row => fields.every(field => {
    const wanted = field === 'worldGroupId' ? input.worldGroupId : input.patch[field]
    return String(row[field] ?? '') === String(wanted ?? '')
  }))
  if (duplicate) throw new Error(`${input.operation.target} 已有同身份记录，请改为定点修改。`)
}

export async function prepareNativeOperationsCandidate(input: {
  projectId: number
  worldGroupId: number | null
  operations: NativeOperationDraft[]
  contextSources: string[]
}): Promise<PreparedNativeOperationsCandidate> {
  const operations = parseDraft(JSON.stringify({ operations: input.operations }))
  const earlier = new Map<string, NativeOperationDraft>()
  const updateTargets = new Set<string>()
  const snapshots: NativeOperationSnapshot[] = []
  for (const operation of operations) {
    validatePatch(operation, earlier)
    const recordId = operation.recordId ?? null
    if (operation.kind === 'update') {
      const key = `${operation.target}:${recordId ?? 'singleton'}`
      if (updateTargets.has(key)) {
        throw new Error(`${operation.target} #${recordId ?? '单例'} 被重复修改；请把字段合并到一条操作。`)
      }
      updateTargets.add(key)
      const row = await readTargetRow({
        projectId: input.projectId, worldGroupId: input.worldGroupId,
        target: operation.target, recordId,
      })
      if (operation.expectedUpdatedAt !== (row?.updatedAt ?? null)) {
        throw new Error(`${operation.target} #${recordId ?? '单例'} 的版本与读取证据不符，请重新读取。`)
      }
      snapshots.push({ id: operation.id, kind: operation.kind, target: operation.target,
        recordId, rowJson: row ? JSON.stringify(row) : null })
    } else {
      if (recordId != null || operation.expectedUpdatedAt != null) {
        throw new Error(`新增 ${operation.target} 不得指定已有记录 ID 或版本。`)
      }
      const identity = ADOPTION_BY_TARGET.get(operation.target)?.identity
      const identityFields = identity === 'name' ? ['name']
        : identity && identity !== 'id' ? identity.fields : []
      if (identityFields.length && [...earlier.values()].some(prior =>
        prior.kind === 'create' && prior.target === operation.target
        && identityFields.every(field => String(prior.patch[field] ?? '') === String(operation.patch[field] ?? '')))) {
        throw new Error(`${operation.target} 在同一候选中重复新增同身份记录。`)
      }
      if (!categoryReference(operation)) {
        await assertNoIdentityConflict({
          projectId: input.projectId, worldGroupId: input.worldGroupId,
          operation, patch: operation.patch,
        })
      }
      snapshots.push({ id: operation.id, kind: operation.kind, target: operation.target,
        recordId: null, rowJson: null })
    }
    earlier.set(operation.id, operation)
  }
  return {
    payload: {
      version: 1, agentId: 'project-native', taskId: 'project-native-1',
      label: `${operations.length} 项项目数据操作`, contextSources: input.contextSources,
      baseSnapshot: {
        projectId: input.projectId, worldGroupId: input.worldGroupId, operations: snapshots,
      },
    },
    draft: JSON.stringify({ operations }, null, 2),
  }
}

function assertCompleteWrite(result: Awaited<ReturnType<typeof adopt>>, operation: NativeOperationDraft): number {
  if (result.written.length !== 1 || result.unknown.length || result.typeErrors.length
    || result.fkErrors.length || result.skipped.length) {
    const problem = result.fkErrors.map(error => `${error.field}=${String(error.refValue)}`)
      .concat(result.typeErrors.map(error => error.field))
      .concat(result.unknown)
      .concat(result.skipped.map(item => item.reason))
      .join('、') || '未写入一条完整记录'
    throw new Error(`${operation.id} ${operation.target} 采纳失败：${problem}。整组操作已回滚。`)
  }
  return result.written[0].id
}

async function refreshProjectStores(projectId: number, targets: ReadonlySet<string>): Promise<void> {
  const tasks: Array<Promise<unknown>> = []
  if (targets.has('projects')) tasks.push(useProjectStore.getState().loadProject(projectId))
  if (targets.has('storyCores') || targets.has('worldviews')) tasks.push(useWorldviewStore.getState().loadAll(projectId))
  if (targets.has('creativeRules')) tasks.push(useCreativeRulesStore.getState().loadAll(projectId))
  if (targets.has('characters')) tasks.push(useCharacterStore.getState().loadAll(projectId))
  if (targets.has('outlineNodes')) tasks.push(useOutlineStore.getState().loadAll(projectId))
  if (targets.has('detailedOutlines')) tasks.push(useDetailedOutlineStore.getState().loadAll(projectId))
  if (targets.has('codexCategories') || targets.has('codexEntries')) tasks.push(useCodexStore.getState().loadExisting(projectId))
  if (targets.has('foreshadows')) tasks.push(useForeshadowStore.getState().loadAll(projectId))
  if (targets.has('importantLocations')) tasks.push(useLocationStore.getState().loadAll(projectId))
  if (targets.has('storyArcs')) tasks.push(useStoryArcStore.getState().loadAll(projectId))
  if (targets.has('storyTimelineEvents')) tasks.push(useStoryTimelineStore.getState().loadAll(projectId))
  if (targets.has('notes')) tasks.push(useNoteStore.getState().loadAll(projectId))
  await Promise.allSettled(tasks)
}

/** 作者确认后单事务采纳：任一版本/FK/去重/类型失败均回滚整组。 */
export async function adoptNativeOperationsCandidate(input: {
  projectId: number
  worldGroupId: number | null
  payload: NativeOperationsCandidatePayload
  draft: string
}): Promise<string> {
  const base = input.payload.baseSnapshot
  if (input.payload.agentId !== 'project-native' || base.projectId !== input.projectId
    || base.worldGroupId !== input.worldGroupId) {
    throw new Error('操作候选不属于当前项目或世界。')
  }
  const operations = parseDraft(input.draft)
  if (operations.length !== base.operations.length) throw new Error('候选操作数量已变化，请重新生成。')
  const earlier = new Map<string, NativeOperationDraft>()
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index]
    const snapshot = base.operations[index]
    if (op.id !== snapshot.id || op.kind !== snapshot.kind || op.target !== snapshot.target
      || (op.recordId ?? null) !== snapshot.recordId) {
      throw new Error('候选目标或操作顺序已变化，请重新生成并读取证据。')
    }
    validatePatch(op, earlier)
    earlier.set(op.id, op)
  }
  const createdIds = new Map<string, number>()
  const changes: Array<{
    table: string; recordId: number; before: Record<string, unknown> | null
    after: Record<string, unknown> | null; fields: string[]
  }> = []
  await db.transaction('rw', db.tables, async () => {
    for (let index = 0; index < operations.length; index++) {
      const op = operations[index]
      const snapshot = base.operations[index]
      const spec = REGISTRY_BY_NAME.get(op.target)!
      let before: Record<string, unknown> | null = null
      let patch = op.patch
      if (op.kind === 'update') {
        before = await readTargetRow({
          projectId: input.projectId, worldGroupId: input.worldGroupId,
          target: op.target, recordId: op.recordId ?? null,
        })
        if ((before ? JSON.stringify(before) : null) !== snapshot.rowJson
          || op.expectedUpdatedAt !== (before?.updatedAt ?? null)) {
          throw new Error(`${op.target} #${op.recordId ?? '单例'} 已变化；整组操作已回滚。`)
        }
        patch = parseProjectFieldDraft(JSON.stringify(op.patch), op.target as ProjectFieldTarget)
      } else {
        const reference = categoryReference(op)
        if (reference) {
          const categoryId = createdIds.get(reference)
          if (categoryId == null) throw new Error(`分类操作 $${reference} 尚未写入。`)
          patch = { ...op.patch, categoryId }
        }
        patch = parseProjectCreateDraft(JSON.stringify(patch), op.target as ProjectCreateTarget)
        await assertNoIdentityConflict({
          projectId: input.projectId, worldGroupId: input.worldGroupId,
          operation: op, patch,
        })
      }
      const result = await adopt({
        projectId: input.projectId, worldGroupId: input.worldGroupId,
        target: op.target,
        ...(op.kind === 'update' && op.recordId != null ? { recordId: op.recordId } : {}),
        mode: op.kind === 'create' ? 'add' : 'replace', data: patch,
        history: false,
      })
      const id = assertCompleteWrite(result, op)
      if (op.kind === 'create') createdIds.set(op.id, id)
      const after = await spec.table.get(id) as Record<string, unknown> | undefined
      if (!after || (op.target === 'projects'
        ? after.id !== input.projectId : after.projectId !== input.projectId)) {
        throw new Error(`${op.id} 写入后未能从当前项目重读记录；整组操作已回滚。`)
      }
      changes.push({ table: op.target, recordId: id, before,
        after: JSON.parse(JSON.stringify(after)) as Record<string, unknown>,
        fields: Object.keys(after).filter(field => before?.[field] !== after[field]),
      })
    }
  })
  enqueueStepRecord({
    projectId: input.projectId, worldGroupId: input.worldGroupId,
    label: `主 Agent 采纳 ${operations.length} 项项目操作`,
    source: 'master-copilot/project-native', changes,
  })
  await refreshProjectStores(input.projectId, new Set(operations.map(op => op.target)))
  for (const change of changes.filter(change => change.table === 'notes')) {
    log.info('NoteStore', 'note.agent.changed', '主 Agent 已执行便签操作', {
      projectId: input.projectId, noteId: change.recordId,
      mode: change.before ? 'update' : 'create', fields: change.fields.join(','),
    })
  }
  return `已完成并重读验证 ${operations.length} 项操作：${operations.map(op => op.id).join('、')}。`
}
