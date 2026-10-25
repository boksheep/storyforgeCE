import { chat, resolveRequestConfig } from '../ai/client'
import { sha256Text } from '../ai/chapter-memory/text-normalization'
import { AGENT_ROLE_CATEGORIES } from '../ai/task-routing'
import { adopt } from '../registry/adopt'
import { ADOPTION_BY_TARGET } from '../registry/adoption-schema'
import { assembleContext } from '../registry/assemble-context'
import { FIELD_BY_TARGET } from '../registry/field-registry'
import { REGISTRY_BY_NAME } from '../registry/project-tables'
import type { ChatMessage } from '../types'
import { assertNotePosition, NOTE_COLORS } from '../types/note'
import { log } from '../logging/logger'
import { useAIConfigStore } from '../../stores/ai-config'
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
import { runReadOnlyAgent } from './runner'
import { AgentTeamBudgetTracker } from './team-budget'
import { AGENT_TOOL_BY_NAME } from './tool-registry'
import { parseAgentProtocolAction } from './protocol'
import type { AgentContextEvidence } from './context-policy'
import type { AgentTeamBudgetEvidence } from './team-budget'

/**
 * 主 Agent 可使用通用 adopt() 更新的字段（作者可编辑的叙述性文本）。
 *
 * 纳入条件（三者同时满足）：
 *   1. 目标表在 PROJECT_TABLES 登记为项目作者数据；
 *   2. 通用字段在 FIELD_REGISTRY 登记为 string/longtext；notes 的颜色、位置、缩小状态
 *      另有严格校验，供作者直接指定便签外观；
 *   3. 字段不承担生命周期语义：不是集合身份键、外键、替换范围键或自动盖章字段。
 *
 * 明确排除（继续走各自领域入口，主 Agent 不得经通用字段候选修改）：
 *   - 正文：chapters.content / wordCount / summary / continuityHandoff / planReconciliation；
 *   - 身份与结构：characters.name、codexEntries.name/categoryId、outlineNodes.title/type、
 *     storyTimelineEvents.chapterId/chapterTitle、*Relations/*Ledger 的外键字段；
 *   - 状态机与枚举：chapters.status、foreshadows.status/type、storylineProgress.status、
 *     cultivationProgress.transition/status；
 *   - 内部/派生缓存：retrievalChunks、narrativeSummaryNodes、aiUsageLog、snapshots、
 *     分析分块与导入二进制；这些数据由领域流水线重建，不接受自然语言直接改写；
 *   - 创建与删除：新增集合行、级联删除、世界迁移仍由大纲/伏笔/词条等领域入口负责。
 *
 * 复审边界：2027-01-01，扩表时先补反例与往返测试。
 */
export const PROJECT_FIELD_EDIT_POLICY = {
  projects: ['name', 'description'],
  notes: ['content', 'color', 'position', 'collapsed'],
  storyCores: ['theme', 'centralConflict', 'plotPattern', 'logline', 'concept', 'mainPlot', 'subPlots'],
  worldviews: [
    'geography', 'history', 'society', 'culture', 'rules', 'worldOrigin',
    'powerHierarchy', 'worldStructure', 'worldDimensions', 'continentLayout',
    'regionDimensions', 'mountainsRivers', 'climateByRegion', 'naturalResourceOverview',
    'historyLine', 'worldEvents', 'races', 'factionLayout', 'politicsEconomyCulture',
    'politicsOverview', 'economyOverview', 'cultureOverview', 'internalConflicts', 'itemDesign',
  ],
  creativeRules: ['writingStyle', 'atmosphere', 'specialRequirements'],
  characters: [
    'shortDescription', 'appearance', 'personality', 'background', 'motivation',
    'abilities', 'relationships', 'arc', 'identity', 'profile', 'values',
    'strengths', 'weaknesses', 'fears', 'goals', 'innerConflict', 'keyEvents',
    'speechStyle', 'habits', 'storyRole', 'ending', 'powerLevel', 'signatureItem',
    'location', 'firstAppearance', 'activeChapterRange',
  ],
  outlineNodes: ['summary'],
  codexEntries: ['summary', 'description'],
  detailedOutlines: ['openingHook', 'endingCliffhanger', 'sceneLocation', 'lastUsedSummary'],
  foreshadows: ['description', 'notes'],
  storyArcs: ['description'],
  importantLocations: ['description', 'significance'],
} as const

export type ProjectFieldTarget = keyof typeof PROJECT_FIELD_EDIT_POLICY

export interface ProjectFieldCandidatePayload {
  version: 1
  agentId: 'project-field'
  taskId: string
  label: string
  contextSources: string[]
  contextEvidence?: AgentContextEvidence
  teamBudgetEvidence?: AgentTeamBudgetEvidence
  baseSnapshot: {
    projectId: number
    worldGroupId: number | null
    target: ProjectFieldTarget
    recordId: number | null
    rowHash: string
  }
  dependsOnTaskIds?: string[]
}

export interface PreparedProjectFieldCandidate {
  payload: ProjectFieldCandidatePayload
  draft: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 显式修改动词（作者直接说"改/补充/完善"）。
 */
const EXPLICIT_FIELD_VERB = /修改|调整|更新|设置|补充|完善|改为|改成|填入|写入|保存到|放进|移动|移到|拖到|收起|展开|缩小|放大|换色|改色|优化|细化|润色|扩写|扩充|丰满|重写|推翻|重构|打磨/

/**
 * 作者要求"写出某段叙述内容"：帮我写项目的简介 / 给作品补一段背景 / 生成主角的描述。
 * 命中"写类动词 + 简介/描述/主题/设定等名词"即视为字段写入诉求。
 */
const AUTHORING_REQUEST = /(?:写|拟|起草|整理|生成|创作|补|撰写|出)/
const AUTHORING_NOUN = /便签|笔记|简介|摘要|描述|背景|主题|设定|规则|梗概|概要|小传|档案|人设|动机|目标|冲突|弧光|成长|结局|结局安排|方向|走向/

/**
 * 比较级改进诉求："更复杂一点""再立体些""更有层次"——作者没说动词，要的是重写。
 * 仅用于**单点字段级**改写。跨域统筹语气（"和世界设定保持一致""呼应主线"）
 * 属于大纲/角色领域的重新规划，必须留给 createMasterAgentPlan，不能在此截胡。
 */
const COMPARATIVE_IMPROVEMENT = /(?:更|再|较为?|比较)\s*(?:复杂|立体|丰满|丰富|充实|深刻|深入|细致|细腻|具体|生动|鲜明|有层次|有张力|有冲突|有矛盾|有戏|有看点|饱满|真实|自然|顺畅|清楚|清晰|合理|严谨|紧凑|精炼|简洁|干净)/
/** 跨域统筹/呼应语气：交给领域 Agent，不做字段级截断。 */
const CROSS_DOMAIN_ORCHESTRATION = /保持一致|相呼应|呼应|统一定调|整体协调|配合主线|配合设定|和.{0,12}(?:一致|呼应|配合|协调)|自洽|统一风格|连贯|贯穿/

/**
 * "太X"评价式诉求：太空了/太浅了/太弱了/太长了……句末"了"或直接收尾都算。
 * 不用 \b：CJK 之后没有词边界，加 \b 会让"太空了"这类结尾形式匹配失败。
 */
const TAIPREFIX_COMPLAINT = /太(?:空泛|空洞|简单|复杂|单薄|浅薄|薄弱|平淡|沉闷|拖沓|松散|混乱|矛盾|套路|脸谱|纸片|工具人|啰嗦|冗长|短|长|慢|快|赶|急|干|水|糙|粗糙|弱|薄|平|闷|乱|空|浅|假|生硬|突兀|牵强|直白|浅白)(?:了|啦|呢)?/

/**
 * 评价性抱怨与省略主语的模糊诉求——作者嘴上说的是"不够好"，要的是重写这段内容。
 * 这些说法不含任何显式动词，只能靠"质量评价词 + 对象缺失"来识别。
 * 单独出现时不构成改写授权（也可能是提问），因此整句判定交给调用方：
 * 只要命中这里就进入字段候选链路，由候选规划（读记录 + 澄清）决定具体目标，
 * 而不是直接掉进领域生成或边界拒绝。
 */
const VAGUE_QUALITY_COMPLAINT = /不够好|不太好|不怎么样|差点意思|不够味|没味|立不住|撑不住|站不住|没(?:有)?张力|没(?:有)?冲突|没(?:有)?矛盾|有问题|不对劲|不太对|不太行|不行|不好|差点|重写|润色|加料|丰富|丰满|充实|细化|深化|打磨|弄好|改好|写好|再想想|换个写法|重新来|再改改|再改|调整一下|改一下|优化一下|太空泛|太空洞|太单薄|太浅|太弱|太薄|太干|太水|太烂|太糙|太粗糙|太平|太闷|太慢|太快|太赶|太急|节奏太|太工具人|太脸谱|太纸片|太套路|太老套|重复|啰嗦|拖沓|松散|混乱|矛盾|矛盾/

/** 明确的提问句式：即使命中评价词也应回答而不是写入。 */
const QUESTION_INTENT = /^(?:怎么|如何|为什么|请问|可否|能否|是不是|能不能|可不可以|行不行|好不好|对不对)/
/** 句末问号整句都是提问（"这样行不行？""简介写得好不好？"）。 */
const ENDS_WITH_QUESTION = /[？?]\s*$/

/**
 * 指代不清但意图是改进的极短诉求（依赖上一轮副驾追问的上下文）。
 * "继续吗？""这样对吗？"这类确认提问不算——必须排除"X不X"选择问。
 */
const FOLLOW_UP_INTENT = /^(?:继续|接着|按(?:照)?(?:刚才|前面|上面|这)|就这|这段|那段|再)/
/**
 * 确认问句式："这样行不行""写得好吗""妥不妥"——作者在求判断，不是在下修改指令。
 * 与 project-answer 的同名正则保持同一份语义：先确认意图，再判写入。
 */
const CONFIRM_QUESTION = /(?:行不行|好不好|对不对|可不可以|能不能|妥不妥|中不中|行吗|好吗|对吗|要不要|该不该|需不需要|是否需要|值不值得|有没有必要)/

/**
 * 否定前缀（句首）或句中"不要/无需…"修饰到动词：作者明确拒绝了写入。
 * 合成单一正则（不能用 || 拼接 RegExp：正则对象恒为真值，TS 会判 always-truthy）。
 */
const NEGATED_WRITE = /^(?:不要|无需|不必|不用|别|禁止|暂不|先不|不需要|甭|先别|别再)|(?:不要|无需|不必|不用|不需要|别|禁止|暂不|先不|甭|先别|别再)[^，。；,;!?？\n]{0,10}(?:修改|调整|更新|设置|移动|移到|拖到|收起|展开|缩小|放大|换色|改色|补充|完善|写入|填入|保存|润色|优化|细化|扩写|重写|丰富|打磨|新增|创建|生成|写|拟|起草)/
/** 正文对象的修改不能落入项目字段通用写回，必须交给正文领域候选。 */
const PROSE_EDIT_REQUEST = /(?:第\s*[零〇一二两三四五六七八九十百\d]+\s*章|正文|错别字|病句|标点|段落|结尾)[^，。；,;!?？\n]{0,32}(?:润色|修改|改写|重写|修正|纠正|删除|补写|完善|突兀|不顺|不自然|太(?:突然|突兀|生硬))|(?:润色|修改|改写|重写|修正|纠正|删除|补写|完善|继续写|接着写|续写)[^，。；,;!?？\n]{0,32}(?:第\s*[零〇一二两三四五六七八九十百\d]+\s*章|正文|错别字|病句|标点|段落|结尾)/

function hasPositiveWriteClause(text: string): boolean {
  if (!NEGATED_WRITE.test(text)) return true
  // “不用修改简介，但请润色项目描述”中前半句是否定对象，后半句仍是肯定授权。
  return /(?:但|不过|只是|同时|另外|请)[^，。；,;!?？\n]{0,40}(?:修改|调整|更新|设置|补充|完善|写入|填入|保存|润色|优化|细化|扩写|重写|丰富|打磨|新增|创建|生成|写|拟|起草)/.test(text)
}

export function isProjectFieldEditRequest(request: string): boolean {
  const text = request.trim()
  if (!text) return false
  if (!hasPositiveWriteClause(text)) return false
  if (PROSE_EDIT_REQUEST.test(text) && !/(?:便签|笔记)/.test(text)) return false
  if (/删除|清空|覆盖正文|续写|创建|新增|新角色|生成.{0,12}(?:一个角色|一名角色)/.test(text)) return false
  // 提问永远优先于写入判定：作者在问"如何修改项目简介？"时不能改他的数据。
  // 必须排在 EXPLICIT_FIELD_VERB 之前，否则句中的"修改"会抢先命中。
  if (QUESTION_INTENT.test(text) || ENDS_WITH_QUESTION.test(text) || CONFIRM_QUESTION.test(text)) return false
  // 跨域统筹诉求留给领域 Agent（主 Agent 编排），不做字段级截断。
  if (CROSS_DOMAIN_ORCHESTRATION.test(text)) return false
  if (EXPLICIT_FIELD_VERB.test(text)) return true
  if (AUTHORING_REQUEST.test(text) && AUTHORING_NOUN.test(text)) return true
  if (FOLLOW_UP_INTENT.test(text) && text.length <= 40) return true
  if (COMPARATIVE_IMPROVEMENT.test(text)) return true
  if (TAIPREFIX_COMPLAINT.test(text)) return true
  return VAGUE_QUALITY_COMPLAINT.test(text)
    && !/[？?]|请问|是什么|有哪些|多少/.test(text)
}

export function parseProjectFieldDraft(
  text: string,
  target: ProjectFieldTarget,
): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('字段候选必须是 JSON 对象。') }
  if (!isObject(parsed) || !Object.keys(parsed).length) throw new Error('字段候选不能为空。')
  const allowed = new Set<string>(PROJECT_FIELD_EDIT_POLICY[target])
  const registryFields = new Set((FIELD_BY_TARGET.get(target) ?? []).map(field => field.field))
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key) || !registryFields.has(key)) throw new Error(`字段 ${target}.${key} 未获主 Agent 通用修改授权。`)
    if (target === 'notes' && key === 'position') { assertNotePosition(value); continue }
    if (target === 'notes' && key === 'collapsed') {
      if (typeof value !== 'boolean') throw new Error('便签 collapsed 必须是布尔值。')
      continue
    }
    if (target === 'notes' && key === 'color') {
      if (typeof value !== 'string' || !(value in NOTE_COLORS)) throw new Error('便签颜色无效。')
      continue
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 12_000) {
      throw new Error(`字段 ${key} 必须是 1-12000 字的非空文本。`)
    }
  }
  return parsed
}

async function currentRow(input: {
  projectId: number
  worldGroupId: number | null
  target: ProjectFieldTarget
  recordId: number | null
}): Promise<Record<string, unknown> | null> {
  const spec = REGISTRY_BY_NAME.get(input.target)
  if (!spec) throw new Error('目标表未在 PROJECT_TABLES 登记。')
  if (ADOPTION_BY_TARGET.has(input.target)) {
    if (input.recordId == null) throw new Error('集合修改缺少记录 ID。')
    const row = await spec.table.get(input.recordId) as Record<string, unknown> | undefined
    if (!row || (input.target === 'projects'
      ? row.id !== input.projectId : row.projectId !== input.projectId)) {
      throw new Error('目标记录不存在或不属于当前项目。')
    }
    return row
  }
  if (input.recordId != null) throw new Error('单例目标不得指定记录 ID。')
  const rows = await spec.table.where('projectId').equals(input.projectId).toArray() as Record<string, unknown>[]
  return spec.worldScoped
    ? rows.find(row => (row[spec.worldGroupField ?? 'worldGroupId'] ?? null) === input.worldGroupId) ?? null
    : rows[0] ?? null
}

function policyPrompt(): string {
  return Object.entries(PROJECT_FIELD_EDIT_POLICY).map(([target, fields]) =>
    `- ${target}: ${fields.join(', ')}`).join('\n')
}

export async function prepareProjectFieldCandidate(input: {
  projectId: number
  worldGroupId: number | null
  request: string
  conversationId: number
  historyBeforeSequence: number
  budget: AgentTeamBudgetTracker
  signal?: AbortSignal
}, dependencies: {
  complete?: (messages: ChatMessage[]) => Promise<string>
} = {}): Promise<PreparedProjectFieldCandidate | { clarification: string }> {
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
    '【本轮作者修改要求】',
    input.request,
    '【主 Agent 可直接更新的 FIELD_REGISTRY 字段】',
    policyPrompt(),
    '先用 list_project_tables/read_project_table 查清目标记录，再给 final.answer 一个严格 JSON 字符串：',
    '{"target":"表名","recordId":正整数或null,"expectedUpdatedAt":整数或null,"patch":{"已授权字段":"新文本"}}。便签 notes 还可更新 color（颜色枚举）、collapsed（布尔值）、position（{x,y} 整数，y 非负）。',
    '单例 worldviews/storyCores/creativeRules 的 recordId 必须为 null；projects 的 recordId 是当前项目 ID；已有集合记录必须提供 ID。',
    '便签 position 的 x 原点是正文纸张左边，负数位于左侧空白；y 从正文创作区顶部向下，单位为像素。作者未给出可确定坐标时不要猜。',
    '“项目书名/作品名”写入 projects.name；“项目简介/作品简介”写入 projects.description；“角色简介”写入指定角色的 characters.shortDescription。仅有“简介”而不能唯一确定对象时先问作者具体目标。',
    'expectedUpdatedAt 必须来自读取结果，禁止猜测。不能安全定位目标或要求超出字段清单时，返回 {"clarification":"需要作者补充的具体问题或此操作所需的专门入口"}。',
    '不得把一个复杂修改要求悄悄缩成仅更新某个字段；只有候选能完整表达本轮要求时才提出 patch。',
    '只提出候选，绝不调用写入工具；本轮用户指令才是修改授权，历史仅帮助理解指代。',
  ].filter(Boolean).join('\n\n')
  const result = await runReadOnlyAgent({
    goal,
    context: {
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      provider: config.provider,
      model: config.model,
    },
    limits: { maxSteps: 10, maxToolCalls: 14, maxTotalTokens: 140_000 },
    signal: input.signal,
    model: {
      complete: async messages => {
        const reservation = input.budget.reserveCall({
          label: '主 Agent 项目字段候选',
          messages,
          maxOutputTokens: 2400,
        })
        try {
          const content = dependencies.complete
            ? await dependencies.complete(messages)
            : await chat(messages, config, {
                category: 'agent.orchestrator.project-field',
                projectId: input.projectId,
                configOverrides: { maxTokens: 2400, temperature: 0.2 },
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
  if (result.status !== 'completed') throw new Error('项目字段规划未完成，请缩小修改范围后重试。')
  let raw: unknown
  try { raw = JSON.parse(result.answer) } catch { throw new Error('项目字段计划不是有效 JSON。') }
  if (!isObject(raw)) throw new Error('项目字段计划必须是对象。')
  if (typeof raw.clarification === 'string' && Object.keys(raw).length === 1) {
    return { clarification: raw.clarification.slice(0, 500) }
  }
  if (!result.events.some(event => event.type === 'tool' && event.ok
    && event.name === 'read_project_table')) {
    throw new Error('字段候选缺少项目记录读取证据。')
  }
  if (typeof raw.target !== 'string'
    || !Object.prototype.hasOwnProperty.call(PROJECT_FIELD_EDIT_POLICY, raw.target)) {
    throw new Error('目标表不在主 Agent 通用字段修改范围。')
  }
  const target = raw.target as ProjectFieldTarget
  const readTarget = result.transcript.some(message => {
    if (message.role !== 'assistant') return false
    try {
      const action = parseAgentProtocolAction(message.content)
      return action.type === 'tool' && action.calls.some(call => (
        call.name === 'read_project_table' && call.arguments.tableName === target
      ))
    } catch { return false }
  })
  if (!readTarget) throw new Error('字段候选没有读取对应目标表。')
  const recordId = raw.recordId == null ? null : Number(raw.recordId)
  if (recordId != null && (!Number.isInteger(recordId) || recordId < 1)) {
    throw new Error('字段候选记录 ID 无效。')
  }
  const patch = parseProjectFieldDraft(JSON.stringify(raw.patch), target)
  const row = await currentRow({ ...input, target, recordId })
  const expectedUpdatedAt = raw.expectedUpdatedAt
  if (expectedUpdatedAt !== (row?.updatedAt ?? null)) {
    throw new Error('目标记录在读取后已变化或版本不明，请重新规划。')
  }
  return {
    payload: {
      version: 1,
      agentId: 'project-field',
      taskId: 'project-field-1',
      label: `${target}${recordId == null ? '' : ` #${recordId}`} 字段修改`,
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
        recordId,
        rowHash: await sha256Text(JSON.stringify(row)),
      },
    },
    draft: JSON.stringify(patch, null, 2),
  }
}

export async function adoptProjectFieldCandidate(input: {
  projectId: number
  worldGroupId: number | null
  payload: ProjectFieldCandidatePayload
  draft: string
}): Promise<string> {
  const snapshot = input.payload.baseSnapshot
  if (snapshot.projectId !== input.projectId || snapshot.worldGroupId !== input.worldGroupId
    || !Object.prototype.hasOwnProperty.call(PROJECT_FIELD_EDIT_POLICY, snapshot.target)) {
    throw new Error('字段候选不属于当前项目或世界，请重新生成。')
  }
  const patch = parseProjectFieldDraft(input.draft, snapshot.target)
  const row = await currentRow({ ...snapshot, projectId: input.projectId, worldGroupId: input.worldGroupId })
  if (await sha256Text(JSON.stringify(row)) !== snapshot.rowHash) {
    throw new Error('目标记录已在候选生成后变化，请重新生成。')
  }
  const result = await adopt({
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    target: snapshot.target,
    ...(snapshot.recordId != null ? { recordId: snapshot.recordId } : {}),
    mode: 'replace',
    data: patch,
    historyLabel: `主 Agent 修改 ${snapshot.target}${snapshot.recordId == null ? '' : ` #${snapshot.recordId}`}`,
    historySource: 'master-copilot/project-field',
  })
  if (result.written.length !== 1 || result.unknown.length || result.typeErrors.length
    || result.fkErrors.length || result.skipped.length) {
    throw new Error('字段候选未完整采纳；请检查字段类型和目标记录。')
  }
  if (snapshot.target === 'storyCores' || snapshot.target === 'worldviews') {
    await useWorldviewStore.getState().loadAll(input.projectId, input.worldGroupId)
  } else if (snapshot.target === 'projects') {
    await useProjectStore.getState().loadProject(input.projectId)
  } else if (snapshot.target === 'creativeRules') {
    await useCreativeRulesStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'characters') {
    await useCharacterStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'outlineNodes') {
    await useOutlineStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'codexEntries') {
    await useCodexStore.getState().loadExisting(input.projectId)
  } else if (snapshot.target === 'detailedOutlines') {
    await useDetailedOutlineStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'foreshadows') {
    await useForeshadowStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'storyArcs') {
    await useStoryArcStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'importantLocations') {
    await useLocationStore.getState().loadAll(input.projectId)
  } else if (snapshot.target === 'notes') {
    await useNoteStore.getState().loadAll(input.projectId)
    log.info('NoteStore', 'note.agent.updated', '主 Agent 已更新便签', {
      projectId: input.projectId, noteId: snapshot.recordId,
      fields: Object.keys(patch).join(','),
    })
  } else if (snapshot.target === 'storyTimelineEvents') {
    await useStoryTimelineStore.getState().loadAll(input.projectId)
  }
  return `已更新 ${snapshot.target}${snapshot.recordId == null ? '' : ` #${snapshot.recordId}`} 的 ${Object.keys(patch).join('、')}。`
}
