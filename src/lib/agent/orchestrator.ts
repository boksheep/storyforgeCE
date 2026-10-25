import JSON5 from 'json5'
import { logEvent } from '../logging/logger'
import { useAIConfigStore } from '../../stores/ai-config'
import { AGENT_ROLE_CATEGORIES } from '../ai/task-routing'
import { useChapterStore } from '../../stores/chapter'
import { useCharacterStore } from '../../stores/character'
import { useInspirationWorkspaceStore } from '../../stores/inspiration-workspace'
import { useOutlineStore } from '../../stores/outline'
import { useWorldviewStore } from '../../stores/worldview'
import { chat, resolveRequestConfig, type ChatResult } from '../ai/client'
import { db } from '../db/schema'
import {
  adoptGenerationNodeOutput,
  type GenerationNode,
} from '../generation/generation-node'
import {
  parseInspirationFragments,
  MAX_INSPIRATION_FRAGMENTS,
} from '../inspiration/workspace'
import { adopt } from '../registry/adopt'
import {
  parseAgentEventPayload,
  type AgentEvent,
  type ChatMessage,
  type InspirationResultMode,
} from '../types'
import {
  parseCharacterCandidateDraft,
  prepareCharacterCopilot,
  type CharacterCopilotCandidate,
  type CharacterRosterSnapshot,
} from './character-copilot'
import {
  parseInspirationCandidateDraft,
  prepareInspirationCopilot,
  type InspirationCopilotResult,
  type InspirationWorkspaceSnapshot,
} from './inspiration-copilot'
import {
  adoptRestoredOutlineCandidate,
  parseOutlineCandidateDraft,
  prepareOutlineCopilot,
  type OutlineCopilotMode,
  type OutlineCopilotSnapshot,
} from './outline-copilot'
import {
  adoptRestoredProseCandidate,
  parseProseCandidateDraft,
  prepareProseCopilot,
  type ProseCopilotOperation,
  type ProseCopilotSnapshot,
} from './prose-copilot'
import {
  prepareWorldOriginCopilot,
  type WorldOriginSnapshot,
} from './world-origin-copilot'
import type {
  AgentContextEvidence,
  AgentContextTaskKind,
} from './context-policy'
import { assembleContext } from '../registry/assemble-context'
import { validateDomainCandidateCanon } from './canon-validator'
import { runBudgetedGenerationNode } from './team-execution'

import { resolveVolumePlotReview, type VolumePlotReview } from './project-review'
import {
  AgentTeamBudgetExceededError,
  AgentTeamBudgetTracker,
  type AgentTeamBudgetEvidence,
} from './team-budget'

export const DOMAIN_AGENT_IDS = ['world-origin', 'character', 'inspiration', 'outline', 'prose'] as const
export type DomainAgentId = typeof DOMAIN_AGENT_IDS[number]

const CONTEXT_TASK_BY_AGENT: Record<DomainAgentId, AgentContextTaskKind> = {
  'world-origin': 'agent-world-origin',
  character: 'agent-character',
  inspiration: 'agent-inspiration',
  outline: 'agent-outline',
  prose: 'agent-prose',
}

const MAX_OUTPUT_TOKENS_BY_AGENT: Record<DomainAgentId, number> = {
  'world-origin': 3_000,
  character: 6_000,
  inspiration: 8_000,
  outline: 12_000,
  prose: 16_000,
}

export interface MasterAgentTask {
  id: string
  agentId: DomainAgentId
  instruction: string
  dependsOn: string[]
}

export interface MasterAgentPlan {
  summary: string
  tasks: MasterAgentTask[]
  review?: VolumePlotReview
  projectFieldRequest?: boolean
  projectCreateRequest?: boolean
}

export interface MasterCandidatePayload {
  version: 1
  taskId: string
  agentId: DomainAgentId
  label: string
  contextSources: string[]
  contextEvidence?: AgentContextEvidence
  teamBudgetEvidence?: AgentTeamBudgetEvidence
  baseSnapshot: unknown
  mode?: InspirationResultMode
  selectedFragmentIds?: string[]
  outlineMode?: OutlineCopilotMode
  outlineParentId?: number | null
  proseOperation?: ProseCopilotOperation
  proseOutlineNodeId?: number
  dependsOnTaskIds?: string[]
}

export interface ExecutedMasterCandidate {
  payload: MasterCandidatePayload
  draft: string
  runtimeNode: GenerationNode<any, any, any>
  runtimeOutput: unknown
}

interface PlannerDependencies {
  complete?: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<string | { content: string; finishReason?: string }>
}

class AgentPlanIncompleteError extends Error {}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('主 Agent 没有返回任务计划 JSON。')
  const parsed = JSON5.parse(fenced.slice(start, end + 1)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('主 Agent 任务计划必须是对象。')
  }
  return parsed as Record<string, unknown>
}

function requestedAction(request: string, pattern: RegExp): boolean {
  for (const match of request.matchAll(pattern)) {
    const start = match.index ?? 0
    const phrase = request.slice(Math.max(0, start - 5), start + match[0].length + 2)
    if (!/不要|无需|不必|不需要|别|禁止|暂不|不再/.test(phrase)) return true
  }
  return false
}

function explicitlyRequestedDomains(request: string): Set<DomainAgentId> {
  const hasInspiration = requestedAction(request, /(?:反推|生成|创建|整理|融合)[^，。；,;!?？\n]{0,12}(?:灵感|碎片|脑洞)|(?:灵感|碎片)[^，。；,;!?？\n]{0,12}(?:反推|生成|整理|融合)/g)
  const hasProse = requestedAction(request, /续写|接着写|继续写|(?:写|润色|修改|修正|纠正|删除|调整|改写|重写)[^，。；,;!?？\n]{0,16}第\s*[零〇一二两三四五六七八九十\d]+\s*章|(?:生成|创作|写|撰写|扩写|润色|修改|修正|纠正|调整|改写|重写)[^，。；,;!?？\n]{0,12}正文|正文[^，。；,;!?？\n]{0,12}(?:生成|创作|续写|扩写|润色|修改|修正|纠正|调整|改写|重写)|(?:第\s*[零〇一二两三四五六七八九十百\d]+\s*章|正文)[^，。；,;!?？\n]{0,32}(?:错别字|病句|标点|结尾|突兀|不顺|不自然)/g)
    || /删除\s*第\s*[零〇一二两三四五六七八九十百\d]+\s*章[^，。；,;!?？\n]{0,12}(?:错别字|病句|标点|字词|文字)/.test(request)
  const outlineAction = requestedAction(request, /(?:生成|创建|新增|规划|设计|展开|补充|完善|修改|重做)[^，。；,;!?？\n]{0,12}(?:大纲|卷纲|章纲|章节规划|剧情结构|情节结构)|(?:大纲|卷纲|章纲|章节规划|剧情结构|情节结构)[^，。；,;!?？\n]{0,12}(?:生成|创建|新增|规划|设计|展开|补充|完善|修改|重做)/g)
  const hasOutline = outlineAction
  const worldObject = '(?:世界观|世界|背景设定|世界起源|文明设定|力量体系|时代背景|地理设定)'
  const gap = '[^，。；,;!?？\\n]{0,12}'
  const worldAction = requestedAction(request, new RegExp(`(?:创建|生成|设计|新增|建立|补充|完善|修改|重做)${gap}${worldObject}|${worldObject}${gap}(?:创建|生成|设计|新增|建立|补充|完善|修改|重做)`, 'g'))
  const characterAction = requestedAction(request, /(?:创建|生成|设计|新增|塑造|补充|完善|修改|重做)[^，。；,;!?？\n]{0,12}(?:角色|人物|主角|配角|反派|npc)|(?:角色|人物|主角|配角|反派|npc)[^，。；,;!?？\n]{0,12}(?:创建|生成|设计|新增|塑造|补充|完善|修改|重做)/gi)
  const hasWorld = worldAction
  // 大纲里的“角色变化/角色弧光”是输出约束，不是创建或修改角色主档的授权。
  const hasCharacter = characterAction
  return new Set<DomainAgentId>([
    ...(hasWorld ? ['world-origin' as const] : []),
    ...(hasCharacter ? ['character' as const] : []),
    ...(hasInspiration ? ['inspiration' as const] : []),
    ...(hasOutline ? ['outline' as const] : []),
    ...(hasProse ? ['prose' as const] : []),
  ])
}

function fallbackPlan(request: string): MasterAgentPlan {
  const tasks: MasterAgentTask[] = []
  const requested = explicitlyRequestedDomains(request)
  const hasWorld = requested.has('world-origin')
  const hasCharacter = requested.has('character')
  const hasInspiration = requested.has('inspiration')
  const hasOutline = requested.has('outline')
  const hasProse = requested.has('prose')
  if (hasWorld) tasks.push({
    id: 'world-1',
    agentId: 'world-origin',
    instruction: request,
    dependsOn: [],
  })
  if (hasInspiration) tasks.push({
    id: 'inspiration-1',
    agentId: 'inspiration',
    instruction: request,
    dependsOn: [],
  })
  if (hasCharacter) tasks.push({
    id: 'character-1',
    agentId: 'character',
    instruction: request,
    dependsOn: hasWorld ? ['world-1'] : [],
  })
  if (hasOutline) tasks.push({
    id: 'outline-1',
    agentId: 'outline',
    instruction: request,
    dependsOn: [
      ...(hasWorld ? ['world-1'] : []),
      ...(hasCharacter ? ['character-1'] : []),
    ],
  })
  if (hasProse && !hasOutline) tasks.push({
    id: 'prose-1',
    agentId: 'prose',
    instruction: request,
    dependsOn: [
      ...(hasWorld ? ['world-1'] : []),
      ...(hasCharacter ? ['character-1'] : []),
      ...(hasOutline ? ['outline-1'] : []),
    ],
  })
  return {
    summary: !tasks.length
      ? '无法确定要执行的创作领域。请说明要处理世界、角色、灵感、大纲还是正文。'
      : hasProse && hasOutline
      ? '先生成并确认章节大纲；确认进入正式数据后，再继续生成正文。'
      : '根据用户要求调度相关创作领域。',
    tasks,
  }
}

function isContextualFollowUp(request: string): boolean {
  if (/[？?]|有哪些|是什么|怎么|如何|为什么|查询|查看|列出|总结/.test(request)) return false
  return /继续|接着|按(?:照)?(?:刚才|前面|上面).{0,12}(?:做|生成|规划|写|处理|完善)|下一(?:步|卷|章)/.test(request)
}

function sanitizePlan(
  raw: Record<string, unknown>,
  request: string,
  allowContextual: boolean,
  allowDeterministicFallback: boolean,
  allowModelRoutedTasks: boolean,
): MasterAgentPlan {
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  const tasks: MasterAgentTask[] = []
  const ids = new Set<string>()
  const agentIds = new Set<DomainAgentId>()
  const explicitlyRequested = explicitlyRequestedDomains(request)
  const readOnlyOrNegated = /[？?]|为什么|是什么|怎么|如何|查询|查看|列出|总结|多少|哪一|是否|不要|无需|不必|不需要|别|禁止|暂不|不再/.test(request)
  if (rawTasks.length > 20) throw new AgentPlanIncompleteError('主 Agent 计划包含过多任务，无法确认全部目标；请拆分本轮请求。')
  for (const item of rawTasks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const source = item as Record<string, unknown>
    if (!DOMAIN_AGENT_IDS.includes(source.agentId as DomainAgentId)) continue
    const agentId = source.agentId as DomainAgentId
    // 模型不得把描述中出现的设定元素误当成新增数据授权。只要用户文本明确命中了至少一个
    // 已闭环领域，就只能调度这些领域；例如“用浮空城和守灯人规划卷纲”只能写大纲。
    if (!explicitlyRequested.has(agentId)
      && !(allowContextual && explicitlyRequested.size === 0)
      && !allowModelRoutedTasks) continue
    if (allowModelRoutedTasks && readOnlyOrNegated) continue
    // 当前每个领域节点都以一次候选快照为确认单位。同领域并列任务会共享旧快照，
    // 第一个采纳后让后续候选必然过期；批量目标必须由单个领域任务一次产出。
    if (agentIds.has(agentId)) {
      const existing = tasks.find(task => task.agentId === agentId)!
      existing.instruction = request
      if (Array.isArray(source.dependsOn)) {
        existing.dependsOn = [...new Set([
          ...existing.dependsOn,
          ...source.dependsOn.filter((value): value is string => typeof value === 'string'),
        ])].slice(0, 5)
      }
      continue
    }
    const id = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim().slice(0, 80)
      : `task-${tasks.length + 1}`
    if (ids.has(id)) continue
    ids.add(id)
    agentIds.add(agentId)
    const instruction = typeof source.instruction === 'string' && source.instruction.trim()
      ? source.instruction.trim()
      : request
    if (instruction.length > 2000) {
      throw new AgentPlanIncompleteError('主 Agent 任务说明超过 2000 字，已拒绝静默截断；请缩小任务范围。')
    }
    tasks.push({
      id,
      agentId,
      instruction,
      dependsOn: Array.isArray(source.dependsOn)
        ? source.dependsOn.filter((value): value is string => typeof value === 'string').slice(0, 5)
        : [],
    })
  }
  if (!tasks.length) {
    if (raw.projectFieldRequest === true
      && !/[？?]|请问|查询|查看|分析|解释|为什么/.test(request)
      && !/^(?:不要|无需|不必|别|禁止)/.test(request.trim())
      && /(?:把|让|将|请|帮|我要|想).{0,50}(?:写|变|改|完善|调整|更新|润色|丰富|细化|优化|补充|填|保存|放|更)/.test(request)) {
      return { summary: '读取相关项目记录并准备可确认的修改候选。', tasks: [], projectFieldRequest: true }
    }
    if (!rawTasks.length && typeof raw.summary === 'string' && raw.summary.trim()) {
      return { summary: raw.summary.trim().slice(0, 500), tasks: [] }
    }
    if (!allowDeterministicFallback) {
      return {
        summary: rawTasks.length
          ? '模型提出的任务未通过当前请求的安全授权范围，请补充明确目标或确认要处理的领域。'
          : typeof raw.summary === 'string' && raw.summary.trim()
            ? raw.summary.trim().slice(0, 500)
            : '主 Agent 未能确定本轮目标，请补充要处理的对象、范围或操作。',
        tasks: [],
        projectFieldRequest: raw.projectFieldRequest === true,
        projectCreateRequest: raw.projectCreateRequest === true,
      }
    }
    return fallbackPlan(request)
  }
  const knownIds = new Set(tasks.map(task => task.id))
  tasks.forEach(task => {
    task.dependsOn = task.dependsOn.filter(id => id !== task.id && knownIds.has(id))
  })
  const outlineTaskIds = new Set(tasks
    .filter(task => task.agentId === 'outline')
    .map(task => task.id))
  const stagedProse = tasks.some(task => (
    task.agentId === 'prose'
    && (outlineTaskIds.size > 0 || task.dependsOn.some(id => outlineTaskIds.has(id)))
  ))
  if (stagedProse) {
    for (let index = tasks.length - 1; index >= 0; index--) {
      if (tasks[index].agentId === 'prose') tasks.splice(index, 1)
    }
  }
  return {
    summary: stagedProse
      ? '先生成并确认章节大纲；确认进入正式数据后，再继续生成正文。'
      : typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim().slice(0, 500)
      : '主 Agent 已拆分本轮创作任务。',
    tasks,
  }
}

export async function createMasterAgentPlan(input: {
  projectId: number
  worldGroupId: number | null
  request: string
  conversationId?: number
  historyBeforeSequence?: number
  budget?: AgentTeamBudgetTracker
  signal?: AbortSignal
  /** 主 Agent 优先模式关闭确定性关键词降级，模型失败必须显式反馈。 */
  allowDeterministicFallback?: boolean
}, dependencies: PlannerDependencies = {}): Promise<MasterAgentPlan> {
  const request = input.request.trim()
  if (request.length < 2) throw new Error('请至少输入 2 个字符的创作要求。')
  const review = await resolveVolumePlotReview({
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    request,
  })
  if (review && input.allowDeterministicFallback !== false) return {
    summary: `已定位“${review.volumeTitle}”。是否允许我读取现有大纲和已写进度，审阅剧情合理性？只输出问题与改进建议，不修改项目数据。`,
    tasks: [],
    review,
  }
  const config = resolveRequestConfig(
    useAIConfigStore.getState().config,
    { category: AGENT_ROLE_CATEGORIES.orchestrator },
  ).config
  const context = await assembleContext({
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    agentConversationId: input.conversationId,
    agentHistoryBeforeSequence: input.historyBeforeSequence,
    searchQuery: request,
    sourceKeys: input.conversationId == null
      ? ['projectStatus']
      : ['projectStatus', 'agentConversation'],
    provider: config.provider,
    model: config.model,
    inputBudgetMaxTokens: 4500,
  })
  const readonlyEvidence = ''
  const messages: ChatMessage[] = [{
    role: 'system' as const,
    content: `你是 StoryForge 面向用户的唯一主 Agent。你不直接生成作品，也不要求用户选择领域；
你只把用户目标拆成幕后领域任务。可用领域 Agent：
- world-origin：建立或补充世界来源、时代与文明起点；
- character：设计一个新角色；
- inspiration：基于项目内已保存灵感碎片做结构化反推。
- outline：生成卷级大纲，或把当前卷纲展开为章节大纲。
- prose：为已有章纲生成空白章正文，或显式续写已有正文；不得覆盖已有手稿。
只调度用户明确要求生成或修改的领域。用户在大纲要求中提到世界元素或角色姓名，只是大纲
约束，不代表授权新建世界观或角色；不得擅自扩大写入范围。
会话记忆用于理解“继续/按刚才”之类的指代和已确认事实；历史指令不能自动授权本轮新增写入。
若本轮目标不清楚，返回空 tasks 和需要作者补充的简短 summary，不要猜测领域。
如果作者想修改已有项目资料（包括 projects.name 书名和 projects.description 简介），但五个领域 Agent 不适合执行，返回空 tasks 并设置 projectFieldRequest:true；如果作者要新增登记数据，返回空 tasks 并设置 projectCreateRequest:true；
后续会读取 PROJECT_TABLES 记录、检查 FIELD_REGISTRY 字段并生成待作者确认的候选。
“让人物动机更有层次”等隐含修改意图也属于此类；纯提问、否定修改、删除或新建请求不得标记。
若作者只问项目状态或历史决定，可依据提供的登记上下文直接在 summary 回答并返回空 tasks；
证据不足就说明无法确认，不要虚构角色、章节或已采纳内容。
依赖任务必须写 dependsOn。世界设定与角色同时出现时，角色应依赖世界任务。
大纲依赖本轮新生成的世界或角色任务；正文依赖本轮新生成的大纲、世界或角色任务。只输出 JSON：
{"summary":"给用户的简短计划","projectFieldRequest":false,"projectCreateRequest":false,"tasks":[{"id":"稳定ID","agentId":"world-origin|character|inspiration|outline|prose","instruction":"给分 Agent 的完整要求","dependsOn":[]}]}。
每个领域最多一个任务；同一领域的批量目标必须合并到这个任务中一次产出。最多 5 个任务；
不要输出 Markdown。`,
  }, {
    role: 'user' as const,
    content: `${context.text || '【项目状态暂不可用】'}\n\n${readonlyEvidence ? `【统一只读工具取得的本轮证据】\n${readonlyEvidence}\n\n` : ''}【本轮用户目标】\n${request}`,
  }]
  let reservation: ReturnType<AgentTeamBudgetTracker['reserveCall']> | null = null
  let settled = false
  try {
    const callPlanner = async (plannerMessages: typeof messages, maxTokens: number) => {
      if (dependencies.complete) {
        const result = await dependencies.complete(plannerMessages)
        return typeof result === 'string' ? { content: result, finishReason: undefined } : result
      }
      const result: ChatResult = {}
      const content = await chat(plannerMessages, config, {
        category: 'agent.orchestrator', projectId: input.projectId,
        configOverrides: { maxTokens, temperature: 0.2 }, contextOverflowPolicy: 'reject',
      }, input.signal, result)
      return { content, finishReason: result.finishReason }
    }
    reservation = input.budget?.reserveCall({
      label: '主 Agent 编排',
      messages,
      maxOutputTokens: 1_800,
    }) ?? null
    let response = await callPlanner(messages, 1_800)
    if (reservation) {
      input.budget!.settleCall(reservation, response.content)
      settled = true
    }
    if (response.finishReason === 'length') {
      const rescueMessages: typeof messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: '上一份计划因输出上限被截断，未执行。请重新输出完整、简洁的单个计划 JSON，覆盖原目标；若无法完整覆盖，请在 summary 中明确要求拆分任务，tasks 留空。不要续写残缺尾部。' },
      ]
      const rescueReservation = input.budget?.reserveCall({
        label: '主 Agent 计划截断抢救', messages: rescueMessages, maxOutputTokens: 3_600,
      })
      try {
        response = await callPlanner(rescueMessages, 3_600)
        if (rescueReservation) input.budget!.settleCall(rescueReservation, response.content)
      } catch (error) {
        if (rescueReservation) input.budget!.settleFailedCall(rescueReservation)
        throw error
      }
      if (response.finishReason === 'length') {
        throw new AgentPlanIncompleteError('主 Agent 计划连续两次达到输出上限，已停止执行；请拆分本轮请求或提高模型输出上限。')
      }
    }
    const parsed = extractJsonObject(response.content)
    const readOnlyQuestion = /[？?]|为什么|是什么|怎么|如何|查询|查看|列出|总结|多少|哪一|是否/.test(request)
    const projectFieldRequest = !readOnlyQuestion && parsed.projectFieldRequest === true
    const projectCreateRequest = !readOnlyQuestion && parsed.projectCreateRequest === true
    return {
      ...sanitizePlan(
        { ...parsed, projectFieldRequest, projectCreateRequest }, request,
        input.conversationId != null && isContextualFollowUp(request),
        input.allowDeterministicFallback !== false,
        input.allowDeterministicFallback === false,
      ),
      projectFieldRequest,
      projectCreateRequest,
    }
  } catch (error) {
    if (reservation && !settled) input.budget!.settleFailedCall(reservation)
    if (error instanceof AgentTeamBudgetExceededError || error instanceof AgentPlanIncompleteError) throw error
    if (error instanceof Error && error.message.includes('上下文窗口不足以容纳完整请求')) throw error
    if (input.signal?.aborted) throw error
    logEvent({ level: 'warn', tag: 'master-agent', event: 'master-agent', message: '[master-agent] 计划模型失败', error })
    if (input.allowDeterministicFallback === false) {
      throw new Error('主 Agent 本轮无法规划：模型不可用或规划结果无效；未切换到现有关键词路由，也未修改项目。')
    }
    return fallbackPlan(request)
  }
}

function topologicalTasks(plan: MasterAgentPlan): MasterAgentTask[] {
  const byId = new Map(plan.tasks.map(task => [task.id, task]))
  const done = new Set<string>()
  const result: MasterAgentTask[] = []
  while (result.length < plan.tasks.length) {
    const available = plan.tasks.filter(task => (
      !done.has(task.id) && task.dependsOn.every(id => done.has(id) || !byId.has(id))
    ))
    if (!available.length) throw new Error('主 Agent 任务计划包含循环依赖。')
    available.forEach(task => {
      result.push(task)
      done.add(task.id)
    })
  }
  return result
}

export async function executeMasterAgentPlan(input: {
  projectId: number
  worldGroupId: number | null
  plan: MasterAgentPlan
  budget?: AgentTeamBudgetTracker
  signal?: AbortSignal
  onTask?: (task: MasterAgentTask, status: 'running' | 'completed' | 'failed', error?: string) => void | Promise<void>
  onCandidate?: (task: MasterAgentTask, candidate: ExecutedMasterCandidate) => void | Promise<void>
  /** 断点恢复时只执行指定任务；已完成任务的输出用于满足下游依赖。 */
  resumeTaskIds?: readonly string[]
  completedOutputs?: ReadonlyMap<string, string>
}): Promise<ExecutedMasterCandidate[]> {
  const candidates: ExecutedMasterCandidate[] = []
  const outputs = new Map<string, string>(input.completedOutputs ?? [])
  const resumeTaskIds = input.resumeTaskIds ? new Set(input.resumeTaskIds) : null
  const contextProfiles = useAIConfigStore.getState().agentContextProfiles
  const budget = input.budget ?? new AgentTeamBudgetTracker(
    useAIConfigStore.getState().agentTeamBudgetProfile,
  )
  for (const task of topologicalTasks(input.plan)) {
    if (resumeTaskIds && !resumeTaskIds.has(task.id)) continue
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await input.onTask?.(task, 'running')
    try {
      const upstream = task.dependsOn
        .map(id => outputs.get(id))
        .filter((value): value is string => Boolean(value?.trim()))
        .join('\n\n')
      if (task.agentId === 'world-origin') {
        const prepared = await prepareWorldOriginCopilot({
          projectId: input.projectId,
          worldGroupId: input.worldGroupId,
          authorRequest: task.instruction,
          routingCategory: AGENT_ROLE_CATEGORIES['world-origin'],
          contextProfile: contextProfiles[CONTEXT_TASK_BY_AGENT[task.agentId]],
          signal: input.signal,
        })
        const result = await runBudgetedGenerationNode({
          node: prepared.node,
          prepared: prepared.prepared,
          budget,
          callLabel: '世界领域 Agent',
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_AGENT[task.agentId],
        })
        const draft = result.output
        candidates.push({
          payload: {
            version: 1,
            taskId: task.id,
            agentId: task.agentId,
            label: '世界来源',
            contextSources: prepared.contextSources,
            contextEvidence: prepared.contextEvidence,
            baseSnapshot: prepared.snapshot,
            dependsOnTaskIds: task.dependsOn,
          },
          draft,
          runtimeNode: prepared.node,
          runtimeOutput: result.output,
        })
        outputs.set(task.id, draft)
      } else if (task.agentId === 'character') {
        const prepared = await prepareCharacterCopilot({
          projectId: input.projectId,
          worldGroupId: input.worldGroupId,
          authorRequest: task.instruction,
          supplementalContext: upstream,
          routingCategory: AGENT_ROLE_CATEGORIES.character,
          contextProfile: contextProfiles[CONTEXT_TASK_BY_AGENT[task.agentId]],
          signal: input.signal,
        })
        const result = await runBudgetedGenerationNode({
          node: prepared.node,
          prepared: prepared.prepared,
          budget,
          callLabel: '角色领域 Agent',
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_AGENT[task.agentId],
        })
        const draft = JSON.stringify(result.output, null, 2)
        candidates.push({
          payload: {
            version: 1,
            taskId: task.id,
            agentId: task.agentId,
            label: '新角色',
            contextSources: prepared.contextSources,
            contextEvidence: prepared.contextEvidence,
            baseSnapshot: prepared.snapshot,
            dependsOnTaskIds: task.dependsOn,
          },
          draft,
          runtimeNode: prepared.node,
          runtimeOutput: result.output,
        })
        outputs.set(task.id, draft)
      } else if (task.agentId === 'inspiration') {
        const workspace = await db.inspirationWorkspaces.where('projectId').equals(input.projectId).first()
        const selectedFragmentIds = parseInspirationFragments(workspace?.fragments)
          .slice(0, MAX_INSPIRATION_FRAGMENTS)
          .map(fragment => fragment.id)
        if (!selectedFragmentIds.length) throw new Error('项目尚无已保存的灵感碎片。')
        const prepared = await prepareInspirationCopilot({
          projectId: input.projectId,
          selectedFragmentIds,
          authorRequest: task.instruction,
          routingCategory: AGENT_ROLE_CATEGORIES.inspiration,
          contextProfile: contextProfiles[CONTEXT_TASK_BY_AGENT[task.agentId]],
          signal: input.signal,
        })
        const result = await runBudgetedGenerationNode({
          node: prepared.node,
          prepared: prepared.prepared,
          budget,
          callLabel: '灵感领域 Agent',
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_AGENT[task.agentId],
        })
        const draft = JSON.stringify(result.output, null, 2)
        candidates.push({
          payload: {
            version: 1,
            taskId: task.id,
            agentId: task.agentId,
            label: '灵感反推版本',
            contextSources: prepared.contextSources,
            contextEvidence: prepared.contextEvidence,
            baseSnapshot: prepared.snapshot,
            mode: prepared.mode,
            selectedFragmentIds,
            dependsOnTaskIds: task.dependsOn,
          },
          draft,
          runtimeNode: prepared.node,
          runtimeOutput: result.output,
        })
        outputs.set(task.id, draft)
      } else if (task.agentId === 'outline') {
        const prepared = await prepareOutlineCopilot({
          projectId: input.projectId,
          worldGroupId: input.worldGroupId,
          authorRequest: task.instruction,
          supplementalContext: upstream,
          routingCategory: AGENT_ROLE_CATEGORIES.outline,
          contextProfile: contextProfiles[CONTEXT_TASK_BY_AGENT[task.agentId]],
          signal: input.signal,
        })
        const result = await runBudgetedGenerationNode({
          node: prepared.node,
          prepared: prepared.prepared,
          budget,
          callLabel: '大纲领域 Agent',
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_AGENT[task.agentId],
          validate: output => validateDomainCandidateCanon({
            agentId: task.agentId,
            projectId: input.projectId,
            worldGroupId: input.worldGroupId,
            outlineNodeId: prepared.parentVolumeId,
            outputText: JSON.stringify(output),
          }),
        })
        const draft = JSON.stringify(result.output, null, 2)
        candidates.push({
          payload: {
            version: 1,
            taskId: task.id,
            agentId: task.agentId,
            label: prepared.label,
            contextSources: prepared.contextSources,
            contextEvidence: prepared.contextEvidence,
            baseSnapshot: prepared.snapshot,
            outlineMode: prepared.mode,
            outlineParentId: prepared.parentVolumeId,
            dependsOnTaskIds: task.dependsOn,
          },
          draft,
          runtimeNode: prepared.node,
          runtimeOutput: result.output,
        })
        outputs.set(task.id, draft)
      } else {
        const prepared = await prepareProseCopilot({
          projectId: input.projectId,
          worldGroupId: input.worldGroupId,
          authorRequest: task.instruction,
          supplementalContext: upstream,
          routingCategory: AGENT_ROLE_CATEGORIES.prose,
          contextProfile: contextProfiles[CONTEXT_TASK_BY_AGENT[task.agentId]],
          signal: input.signal,
        })
        const result = await runBudgetedGenerationNode({
          node: prepared.node,
          prepared: prepared.prepared,
          budget,
          callLabel: '正文领域 Agent',
          maxOutputTokens: MAX_OUTPUT_TOKENS_BY_AGENT[task.agentId],
          validate: output => validateDomainCandidateCanon({
            agentId: task.agentId,
            projectId: input.projectId,
            worldGroupId: input.worldGroupId,
            outlineNodeId: prepared.outlineNodeId,
            outputText: output,
          }),
        })
        const draft = result.output
        candidates.push({
          payload: {
            version: 1,
            taskId: task.id,
            agentId: task.agentId,
            label: prepared.label,
            contextSources: prepared.contextSources,
            contextEvidence: prepared.contextEvidence,
            baseSnapshot: prepared.snapshot,
            proseOperation: prepared.operation,
            proseOutlineNodeId: prepared.outlineNodeId,
            dependsOnTaskIds: task.dependsOn,
          },
          draft,
          runtimeNode: prepared.node,
          runtimeOutput: result.output,
        })
        outputs.set(task.id, draft)
      }
      const generatedCandidate = candidates[candidates.length - 1]
      if (generatedCandidate) await input.onCandidate?.(task, generatedCandidate)
      await input.onTask?.(task, 'completed')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.onTask?.(task, 'failed', message)
      throw error
    }
  }
  const teamBudgetEvidence = budget.snapshot()
  candidates.forEach(candidate => {
    candidate.payload.teamBudgetEvidence = teamBudgetEvidence
  })
  return candidates
}

function sameWorldSnapshot(
  left: WorldOriginSnapshot,
  right: WorldOriginSnapshot,
): boolean {
  return left.id === right.id
    && left.updatedAt === right.updatedAt
    && left.worldOrigin === right.worldOrigin
}

async function currentWorldSnapshot(projectId: number, worldGroupId: number | null): Promise<WorldOriginSnapshot> {
  const rows = await db.worldviews.where('projectId').equals(projectId).toArray()
  const row = worldGroupId == null
    ? (rows.find(item => (item.worldGroupId ?? null) === null) ?? rows[0] ?? null)
    : (rows.find(item => item.worldGroupId === worldGroupId) ?? null)
  return { id: row?.id ?? null, updatedAt: row?.updatedAt ?? null, worldOrigin: row?.worldOrigin ?? '' }
}

async function currentRosterSnapshot(projectId: number, worldGroupId: number | null): Promise<CharacterRosterSnapshot> {
  const rows = await db.characters.where('projectId').equals(projectId).toArray()
  return {
    serialized: JSON.stringify(rows.map(character => ({
      id: character.id ?? null,
      updatedAt: character.updatedAt,
      name: character.name,
      homeWorldGroupId: character.homeWorldGroupId ?? null,
      isCrossWorld: Boolean(character.isCrossWorld),
    })).sort((left, right) => (left.id ?? 0) - (right.id ?? 0))),
    visibleNames: rows
      .filter(character => character.isCrossWorld || (character.homeWorldGroupId ?? null) === worldGroupId)
      .map(character => character.name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')),
  }
}

async function currentInspirationSnapshot(projectId: number): Promise<InspirationWorkspaceSnapshot> {
  const row = await db.inspirationWorkspaces.where('projectId').equals(projectId).first()
  return {
    id: row?.id ?? null,
    updatedAt: row?.updatedAt ?? null,
    fragments: row?.fragments ?? '[]',
    versions: row?.versions ?? '[]',
  }
}

async function assertCandidateDependenciesAdopted(
  event: AgentEvent,
  payload: MasterCandidatePayload,
): Promise<void> {
  const taskIds = payload.dependsOnTaskIds ?? []
  if (!taskIds.length) return
  const events = await db.agentEvents
    .where('conversationId')
    .equals(event.conversationId)
    .toArray()
  const candidateByTask = new Map<string, { id: number; sequence: number }>()
  const adoptedCandidateIds = new Set<number>()
  const adoptedCandidateSequences = new Set<number>()
  for (const row of events) {
    if (row.kind === 'candidate' && row.id != null) {
      const candidate = parseAgentEventPayload<Partial<MasterCandidatePayload>>(row, {})
      if (candidate.taskId) candidateByTask.set(candidate.taskId, {
        id: row.id, sequence: row.sequence,
      })
    } else if (row.kind === 'confirmation') {
      const confirmation = parseAgentEventPayload<{
        candidateEventId?: number
        candidateSequence?: number
        decision?: 'adopted' | 'rejected'
      }>(row, {})
      if (confirmation.decision === 'adopted' && confirmation.candidateSequence != null) {
        adoptedCandidateSequences.add(confirmation.candidateSequence)
      } else if (confirmation.decision === 'adopted' && confirmation.candidateEventId != null) {
        adoptedCandidateIds.add(confirmation.candidateEventId)
      }
    }
  }
  const missing = taskIds.filter(taskId => {
    const candidate = candidateByTask.get(taskId)
    return candidate == null
      || (!adoptedCandidateIds.has(candidate.id) && !adoptedCandidateSequences.has(candidate.sequence))
  })
  if (missing.length) {
    throw new Error(`请先采纳本候选依赖的上游结果：${missing.join('、')}。`)
  }
}

export async function adoptMasterCandidate(input: {
  projectId: number
  worldGroupId: number | null
  event: AgentEvent
  payload: MasterCandidatePayload
  draft: string
  runtime?: ExecutedMasterCandidate
}): Promise<string> {
  await assertCandidateDependenciesAdopted(input.event, input.payload)
  if (input.runtime) {
    const output = input.payload.agentId === 'world-origin'
      ? input.draft
      : input.payload.agentId === 'character'
        ? parseCharacterCandidateDraft(input.draft)
        : input.payload.agentId === 'inspiration'
          ? parseInspirationCandidateDraft(input.draft, input.payload.mode ?? 'single')
          : input.payload.agentId === 'outline'
            ? parseOutlineCandidateDraft(input.draft)
            : parseProseCandidateDraft(input.draft)
    const result = await adoptGenerationNodeOutput(input.runtime.runtimeNode, output)
    if (!result.adopted) {
      throw new Error(result.gate?.issues.map(issue => issue.message).join('；') || '候选没有通过确认闸门。')
    }
  } else if (input.payload.agentId === 'world-origin') {
    const base = input.payload.baseSnapshot as WorldOriginSnapshot
    if (!sameWorldSnapshot(base, await currentWorldSnapshot(input.projectId, input.worldGroupId))) {
      throw new Error('世界来源已在候选生成后发生变化，请重新生成。')
    }
    const draft = input.draft.trim()
    if (draft.length < 4 || draft.length > 12_000) throw new Error('世界来源候选长度无效。')
    await adopt({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      target: 'worldviews',
      mode: 'replace',
      data: { worldOrigin: draft },
    })
  } else if (input.payload.agentId === 'character') {
    const base = input.payload.baseSnapshot as CharacterRosterSnapshot
    const current = await currentRosterSnapshot(input.projectId, input.worldGroupId)
    if (base.serialized !== current.serialized) throw new Error('角色主档已变化，请重新生成。')
    const candidate = parseCharacterCandidateDraft(input.draft)
    const normalized = candidate.name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    if (current.visibleNames.includes(normalized)) throw new Error(`当前世界已存在角色“${candidate.name}”。`)
    await adopt({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      target: 'characters',
      mode: 'add',
      data: { ...candidate, isCrossWorld: false },
    })
  } else if (input.payload.agentId === 'inspiration') {
    const base = input.payload.baseSnapshot as InspirationWorkspaceSnapshot
    const current = await currentInspirationSnapshot(input.projectId)
    if (JSON.stringify(base) !== JSON.stringify(current)) throw new Error('灵感工作区已变化，请重新生成。')
    const mode = input.payload.mode ?? 'single'
    const result = parseInspirationCandidateDraft(input.draft, mode)
    await useInspirationWorkspaceStore.getState().load(input.projectId)
    await useInspirationWorkspaceStore.getState().saveVersion(input.projectId, {
      mode,
      parentVersionId: null,
      fragmentIds: input.payload.selectedFragmentIds ?? [],
      result: result as InspirationCopilotResult,
    })
  } else if (input.payload.agentId === 'outline') {
    const mode = input.payload.outlineMode
    if (!mode) throw new Error('大纲候选缺少写回模式，请重新生成。')
    await adoptRestoredOutlineCandidate({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      mode,
      parentVolumeId: input.payload.outlineParentId ?? null,
      snapshot: input.payload.baseSnapshot as OutlineCopilotSnapshot,
      draft: input.draft,
    })
  } else {
    if (!input.payload.proseOperation || input.payload.proseOutlineNodeId == null) {
      throw new Error('正文候选缺少目标章节或写回模式，请重新生成。')
    }
    await adoptRestoredProseCandidate({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      operation: input.payload.proseOperation,
      outlineNodeId: input.payload.proseOutlineNodeId,
      snapshot: input.payload.baseSnapshot as ProseCopilotSnapshot,
      draft: input.draft,
    })
  }

  await Promise.all([
    useWorldviewStore.getState().loadAll(input.projectId, input.worldGroupId),
    useCharacterStore.getState().loadAll(input.projectId),
    useOutlineStore.getState().loadAll(input.projectId),
    useChapterStore.getState().loadAll(input.projectId),
  ])
  return input.payload.agentId === 'world-origin'
    ? '世界来源已写入项目。'
    : input.payload.agentId === 'character'
      ? `角色“${(parseCharacterCandidateDraft(input.draft) as CharacterCopilotCandidate).name}”已加入项目。`
      : input.payload.agentId === 'inspiration'
        ? `已保存新的${input.payload.mode === 'multiworld' ? '多世界' : '单世界'}灵感版本。`
        : input.payload.agentId === 'outline'
          ? input.payload.outlineMode === 'volumes'
            ? '卷级大纲已写入项目。'
            : '章节大纲已写入目标卷。'
          : input.payload.proseOperation === 'continue'
            ? '续写内容已追加到目标章节。'
            : '正文已写入目标章节。'
}
