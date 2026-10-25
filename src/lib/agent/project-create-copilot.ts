import { chat, resolveRequestConfig } from '../ai/client'
import { AGENT_ROLE_CATEGORIES } from '../ai/task-routing'
import { adopt } from '../registry/adopt'
import { ADOPTION_BY_TARGET } from '../registry/adoption-schema'
import { assembleContext } from '../registry/assemble-context'
import { FIELD_BY_TARGET } from '../registry/field-registry'
import { REGISTRY_BY_NAME } from '../registry/project-tables'
import type { ChatMessage } from '../types'
import { assertNotePosition } from '../types/note'
import { log } from '../logging/logger'
import { db } from '../db/schema'
import { useAIConfigStore } from '../../stores/ai-config'
import { useForeshadowStore } from '../../stores/foreshadow'
import { useLocationStore } from '../../stores/location'
import { useNoteStore } from '../../stores/note'
import { useStoryArcStore } from '../../stores/story-arc'
import { useStoryTimelineStore } from '../../stores/story-timeline'
import { runReadOnlyAgent } from './runner'
import { AgentTeamBudgetTracker } from './team-budget'
import { AGENT_TOOL_BY_NAME } from './tool-registry'
import { parseAgentProtocolAction } from './protocol'
import type { AgentContextEvidence } from './context-policy'
import type { AgentTeamBudgetEvidence } from './team-budget'

/**
 * 主 Agent 可经 adopt(mode:'add') 新建的作者数据集合。
 *
 * 纳入条件：ADOPTION_SCHEMAS 已登记身份/去重/盖章策略，且必填字段是作者可直接提供的
 * 内容字段（不含跨表不变式）。名称类身份冲突时不静默合并，而是提示改用「修改」。
 *
 * 明确不开放创建：chapters 正文、outlineNodes 结构、characters（走角色/大纲领域 Agent）、
 * 账本与提取产物（itemLedger/knowledgeLedger/temporalFacts 等）、分析缓存与导入数据。
 * 复审边界：2027-01-01。
 */
export const PROJECT_CREATE_POLICY = {
  notes: {
    required: ['content'],
    allowed: ['content', 'chapterId', 'color', 'position', 'collapsed'],
  },
  foreshadows: {
    required: ['name', 'type', 'status', 'description'],
    allowed: ['name', 'type', 'status', 'description', 'notes', 'urgency', 'importance'],
  },
  importantLocations: {
    required: ['name'],
    allowed: ['name', 'description', 'significance'],
  },
  storyArcs: {
    required: ['name', 'type'],
    allowed: ['name', 'type', 'description'],
  },
  storyTimelineEvents: {
    required: ['title', 'importance'],
    allowed: ['title', 'importance', 'storyTime', 'description', 'chapterId'],
  },
  // 词条新增必须先有分类；categoryId 的 FK 仍由 adopt() 统一校验，
  // worldGroupId 由当前世界上下文自动盖章，不开放自然语言直接改写。
  codexCategories: {
    required: ['domain', 'name'],
    allowed: ['domain', 'name', 'parentId'],
  },
  codexEntries: {
    required: ['categoryId', 'name'],
    allowed: ['categoryId', 'name', 'aliases', 'icon', 'summary', 'description', 'fields', 'refs', 'tags', 'importance', 'importantLocationId'],
  },
} as const

export type ProjectCreateTarget = keyof typeof PROJECT_CREATE_POLICY

export interface ProjectCreateCandidatePayload {
  version: 1
  agentId: 'project-create'
  taskId: string
  label: string
  contextSources: string[]
  contextEvidence?: AgentContextEvidence
  teamBudgetEvidence?: AgentTeamBudgetEvidence
  baseSnapshot: {
    projectId: number
    worldGroupId: number | null
    target: ProjectCreateTarget
  }
  dependsOnTaskIds?: string[]
}

export interface PreparedProjectCreateCandidate {
  payload: ProjectCreateCandidatePayload
  draft: string
}

const CREATE_VERB = /新增|新建|创建|添加|登记|收录|录入|补进|补入|补到|加进|加入|建一个|建条|加一条|加个|补一条|加一?个|来一?条|来一?个/
const CREATE_NOUN = /便签|笔记|伏笔|地点|重要地点|故事线|支线|主线|年表|时间线|时间线事件|故事事件|词条|设定|分类|类别|物品流水|物品|角色库/
/**
 * 句中否定（"不用新增伏笔""暂时不要建故事线"）不应触发新增闭环。
 * 合成单一正则：RegExp 对象恒为真值，不能用 || 拼接。
 */
const NEGATED_CREATE = /^(?:不要|无需|不必|别|禁止|暂不|先不|不需要|不用|甭|先别)|(?:不要|无需|不必|不需要|不用|别|禁止|暂不|先不|甭|先别)[^，。；,;!?？\n]{0,10}(?:新增|新建|创建|添加|加|补|建)/

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function isProjectCreateRequest(request: string): boolean {
  const text = request.trim()
  if (!text) return false
  if (NEGATED_CREATE.test(text)) return false
  return CREATE_VERB.test(text) && CREATE_NOUN.test(text)
}

function fieldSpec(target: string, field: string) {
  return (FIELD_BY_TARGET.get(target) ?? []).find(spec => spec.field === field)
}

/** 严格校验创建草稿：字段闭集、必填齐全、类型与长度受限。 */
export function parseProjectCreateDraft(
  text: string,
  target: ProjectCreateTarget,
): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('新增候选必须是 JSON 对象。') }
  if (!isObject(parsed) || !Object.keys(parsed).length) throw new Error('新增候选不能为空。')
  const policy = PROJECT_CREATE_POLICY[target]
  const allowed = new Set<string>(policy.allowed)
  const registered = new Set((FIELD_BY_TARGET.get(target) ?? []).map(spec => spec.field))
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key) || !registered.has(key)) {
      throw new Error(`字段 ${target}.${key} 未获主 Agent 新增授权。`)
    }
    if (value == null && !(target === 'codexCategories' && key === 'parentId')) throw new Error(`字段 ${key} 不能为空。`)
    const spec = fieldSpec(target, key)
    if (!spec) throw new Error(`字段 ${target}.${key} 未在 FIELD_REGISTRY 登记。`)
    if (value == null) continue
    if (spec.type === 'enum') {
      const normalized = spec.enumAliasMap?.[String(value)] ?? String(value)
      if (!spec.enums?.includes(normalized)) throw new Error(`字段 ${key} 的枚举值无效。`)
      parsed[key] = normalized
      continue
    }
    if (spec.type === 'number') {
      if (!Number.isFinite(Number(value)) || (target === 'notes' && key === 'chapterId'
        && (!Number.isInteger(Number(value)) || Number(value) < 1))) throw new Error(`字段 ${key} 必须是有效数字。`)
      parsed[key] = Number(value)
      continue
    }
    if (spec.type === 'array') {
      if (!Array.isArray(value) && typeof value !== 'string') throw new Error(`字段 ${key} 必须是数组。`)
      continue
    }
    if (spec.type === 'json' || spec.type === 'object') {
      if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) {
        throw new Error(`字段 ${key} 必须是 JSON 对象或 JSON 字符串。`)
      }
      if (target === 'notes' && key === 'position') assertNotePosition(value)
      continue
    }
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') throw new Error(`字段 ${key} 必须是布尔值。`)
      continue
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 12_000) {
      throw new Error(`字段 ${key} 必须是 1-12000 字的非空文本。`)
    }
  }
  if (target === 'codexCategories') {
    const domain = parsed.domain
    if (!['natural', 'humanity', 'origin'].includes(String(domain))) {
      throw new Error('分类 domain 必须是 natural、humanity 或 origin。')
    }
    if (parsed.parentId != null && !Number.isInteger(Number(parsed.parentId))) {
      throw new Error('分类 parentId 必须是整数或 null。')
    }
  }
  if (target === 'codexEntries') {
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('词条 name 不能为空。')
    if (!Number.isInteger(Number(parsed.categoryId)) || Number(parsed.categoryId) < 1) {
      throw new Error('词条 categoryId 必须是正整数分类 ID。')
    }
  }
  const missing = policy.required.filter(field => {
    const value = parsed[field]
    return value == null || (typeof value === 'string' && !value.trim())
  })
  if (missing.length) throw new Error(`新增候选缺少必填字段：${missing.join('、')}。`)
  return parsed
}

export const PROJECT_CREATE_TARGET_ORDER: readonly ProjectCreateTarget[] = [
  'notes', 'codexCategories', 'codexEntries', 'foreshadows', 'importantLocations',
  'storyArcs', 'storyTimelineEvents',
]

function policyPrompt(): string {
  return PROJECT_CREATE_TARGET_ORDER.map(target => {
    const policy = PROJECT_CREATE_POLICY[target]
    return `- ${target}: 必填 ${policy.required.join(', ')}；可写 ${policy.allowed.join(', ')}`
  }).join('\n')
}

/** 身份冲突时不静默合并，返回既有记录 ID 供作者改用「修改」。 */
async function findIdentityConflict(input: {
  projectId: number
  worldGroupId?: number | null
  target: ProjectCreateTarget
  draft: Record<string, unknown>
}): Promise<number | null> {
  const adoption = ADOPTION_BY_TARGET.get(input.target)
  const spec = REGISTRY_BY_NAME.get(input.target)
  if (!adoption || !spec) throw new Error('新增目标未在注册表登记。')
  const identityFields = adoption.identity === 'id' ? ['id']
    : adoption.identity === 'name' ? ['name']
      : adoption.identity.fields
  const rows = await spec.table.where('projectId').equals(input.projectId).toArray() as Record<string, unknown>[]
  const worldGroupId = input.worldGroupId ?? null
  const hit = rows.find(row => {
    if (input.target === 'codexEntries' && (row.worldGroupId ?? null) !== worldGroupId) return false
    return identityFields.every(field => {
      const expected = input.draft[field]
      if (expected == null) return row[field] == null
      return String(row[field] ?? '').trim() === String(expected).trim()
    })
  })
  return typeof hit?.id === 'number' ? hit.id : null
}

export async function prepareProjectCreateCandidate(input: {
  projectId: number
  worldGroupId: number | null
  request: string
  conversationId: number
  historyBeforeSequence: number
  budget: AgentTeamBudgetTracker
  signal?: AbortSignal
}, dependencies: {
  complete?: (messages: ChatMessage[]) => Promise<string>
} = {}): Promise<PreparedProjectCreateCandidate | { clarification: string }> {
  const config = resolveRequestConfig(
    useAIConfigStore.getState().config,
    { category: AGENT_ROLE_CATEGORIES.orchestrator },
  ).config
  const memory = await assembleContext({
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    agentConversationId: input.conversationId,
    agentHistoryBeforeSequence: input.historyBeforeSequence,
    searchQuery: input.request,
    sourceKeys: ['agentConversation'],
    provider: config.provider,
    model: config.model,
    inputBudgetMaxTokens: 3000,
  })
  const goal = [
    memory.text,
    '【本轮作者新增要求】',
    input.request,
    '【主 Agent 可直接新增的作者数据集合】',
    policyPrompt(),
    '先用 list_project_tables/read_project_table 查清当前项目已有记录，避免与已有条目重复，再给 final.answer 一个严格 JSON 字符串：',
    '{"target":"表名","patch":{"已授权字段":"内容"}}。',
    'patch 必须包含该集合的全部必填字段；枚举字段使用注册表枚举值（伏笔 type: chekhov|prophecy|symbol|character|dialogue|environment|timeline|red-herring|parallel|callback；status: planned|planted|echoed|resolved；故事线 type: main|sub）。',
    '只新增一条记录，不提出批量新增；不能安全定位目标或本轮要求超出上表范围时，返回 {"clarification":"需要作者补充的具体问题或此操作所需的专门入口"}。',
    '只提出候选，绝不调用写入工具；本轮用户指令才是新增授权，历史仅帮助理解指代。',
  ].filter(Boolean).join('\n\n')
  const result = await runReadOnlyAgent({
    goal,
    context: {
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      provider: config.provider,
      model: config.model,
    },
    limits: { maxSteps: 5, maxToolCalls: 6, maxTotalTokens: 70_000 },
    signal: input.signal,
    model: {
      complete: async messages => {
        const reservation = input.budget.reserveCall({
          label: '主 Agent 项目新增候选',
          messages,
          maxOutputTokens: 2000,
        })
        try {
          const content = dependencies.complete
            ? await dependencies.complete(messages)
            : await chat(messages, config, {
                category: 'agent.orchestrator.project-create',
                projectId: input.projectId,
                configOverrides: { maxTokens: 2000, temperature: 0.2 },
                contextOverflowPolicy: 'reject',
              }, input.signal)
          input.budget.settleCall(reservation, content)
          return { content }
        } catch (error) {
          input.budget.settleFailedCall(reservation)
          throw error
        }
      },
    },
  })
  if (result.status !== 'completed') throw new Error('项目新增规划未完成，请缩小范围后重试。')
  let raw: unknown
  try { raw = JSON.parse(result.answer) } catch { throw new Error('项目新增计划不是有效 JSON。') }
  if (!isObject(raw)) throw new Error('项目新增计划必须是对象。')
  if (typeof raw.clarification === 'string' && Object.keys(raw).length === 1) {
    return { clarification: raw.clarification.slice(0, 500) }
  }
  if (!result.events.some(event => event.type === 'tool' && event.ok
    && event.name === 'read_project_table')) {
    throw new Error('新增候选缺少项目记录读取证据。')
  }
  if (typeof raw.target !== 'string'
    || !Object.prototype.hasOwnProperty.call(PROJECT_CREATE_POLICY, raw.target)) {
    throw new Error('目标表不在主 Agent 可新增范围。')
  }
  const target = raw.target as ProjectCreateTarget
  const readTarget = result.transcript.some(message => {
    if (message.role !== 'assistant') return false
    try {
      const action = parseAgentProtocolAction(message.content)
      return action.type === 'tool' && action.calls.some(call => (
        call.name === 'read_project_table' && call.arguments.tableName === target
      ))
    } catch { return false }
  })
  if (!readTarget) throw new Error('新增候选没有读取对应目标表。')
  const patch = parseProjectCreateDraft(JSON.stringify(raw.patch), target)
  if (target === 'codexEntries') {
    const category = await db.codexCategories.get(Number(patch.categoryId))
    if (!category || category.projectId !== input.projectId) {
      return { clarification: '当前项目没有可用的词条分类。请先新增或登记一个分类，再登记词条；词条 categoryId 必须引用该分类。' }
    }
  }
  const conflictId = await findIdentityConflict({
    projectId: input.projectId, worldGroupId: input.worldGroupId, target, draft: patch,
  })
  if (conflictId != null) {
    return {
      clarification: `已存在同身份的 ${target} #${conflictId}。请改用「修改」要求更新该条目，而不是新增。`,
    }
  }
  return {
    payload: {
      version: 1,
      agentId: 'project-create',
      taskId: 'project-create-1',
      label: `新增 ${target}`,
      contextSources: [...new Set([
        ...memory.included,
        ...result.events.flatMap(event => event.type === 'tool' && event.ok
          ? AGENT_TOOL_BY_NAME.get(event.name)?.sourceKeys ?? []
          : []),
      ])],
      baseSnapshot: {
        projectId: input.projectId,
        worldGroupId: input.worldGroupId,
        target,
      },
    },
    draft: JSON.stringify(patch, null, 2),
  }
}

export async function adoptProjectCreateCandidate(input: {
  projectId: number
  worldGroupId: number | null
  payload: ProjectCreateCandidatePayload
  draft: string
}): Promise<string> {
  const snapshot = input.payload.baseSnapshot
  if (snapshot.projectId !== input.projectId || snapshot.worldGroupId !== input.worldGroupId
    || !Object.prototype.hasOwnProperty.call(PROJECT_CREATE_POLICY, snapshot.target)) {
    throw new Error('新增候选不属于当前项目或世界，请重新生成。')
  }
  const patch = parseProjectCreateDraft(input.draft, snapshot.target)
  const conflictId = await findIdentityConflict({
    projectId: input.projectId, worldGroupId: input.worldGroupId,
    target: snapshot.target, draft: patch,
  })
  if (conflictId != null) {
    throw new Error(`已存在同身份的 ${snapshot.target} #${conflictId}，请改用修改。`)
  }
  const result = await adopt({
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    target: snapshot.target,
    mode: 'add',
    data: patch,
    historyLabel: `主 Agent 新增 ${snapshot.target}`,
    historySource: 'master-copilot/project-create',
  })
  if (result.written.length !== 1 || result.unknown.length || result.typeErrors.length
    || result.fkErrors.length || result.skipped.length) {
    const details = result.fkErrors.length
      ? `外键校验失败：${result.fkErrors.map(error => `${error.field}=${String(error.refValue)}`).join('、')}`
      : result.typeErrors.length
        ? `字段类型错误：${result.typeErrors.map(error => error.field).join('、')}`
        : result.skipped.map(item => item.reason).join('、') || '候选未完整写入'
    throw new Error(`新增候选未完整采纳：${details}。`)
  }
  if (snapshot.target === 'notes') {
    await useNoteStore.getState().loadAll(input.projectId)
    log.info('NoteStore', 'note.agent.created', '主 Agent 已创建便签', {
      projectId: input.projectId, noteId: result.written[0].id,
      chapterId: patch.chapterId ?? null, fields: Object.keys(patch).join(','),
    })
  } else if (snapshot.target === 'foreshadows') {
    await useForeshadowStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'importantLocations') {
    await useLocationStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'storyArcs') {
    await useStoryArcStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'storyTimelineEvents') {
    await useStoryTimelineStore.getState().loadAll(input.projectId)
  }
  return `已新增 ${snapshot.target} #${result.written[0].id}：${Object.keys(patch).join('、')}。`
}
