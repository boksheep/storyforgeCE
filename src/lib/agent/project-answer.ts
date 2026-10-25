import { chat, resolveRequestConfig } from '../ai/client'
import { AGENT_ROLE_CATEGORIES } from '../ai/task-routing'
import { assembleContext } from '../registry/assemble-context'
import type { ChatMessage } from '../types'
import { useAIConfigStore } from '../../stores/ai-config'
import { runReadOnlyAgent } from './runner'
import { AgentTeamBudgetTracker } from './team-budget'
import { buildAgentProtocolSystemPrompt } from './protocol'

/** 抽样为零时只允许说明证据不足，不允许据字数臆断质量。 */
export function proseSampleValidation(answer: string, transcript: readonly ChatMessage[], request = ''): string | null {
  const outputs = transcript.flatMap(message => {
    if (message.role !== 'user' || !message.content.startsWith('【只读工具结果】')) return []
    try {
      return JSON.parse(message.content.split('\n')[1]) as Array<{
        name?: string; ok?: boolean; content?: string; arguments?: { query?: string; outlineNodeId?: number }
      }>
    } catch {
      return []
    }
  })
  const volumeReference = request.match(/序[篇卷]|楔子|第[一二三四五六七八九十百\d]+[卷篇]/)?.[0]
    ?? request.match(/(?:^|[，,、\s])([^，,、\s？?]{2,20}[篇卷])(?=的|里|中|写|怎|好)/)?.[1]
  let sampleScopeId: number | undefined
  if (volumeReference) {
    const resolvedIndex = outputs.findIndex(output => output.name === 'resolve_outline_reference'
      && output.ok === true && output.arguments?.query?.includes(volumeReference))
    if (resolvedIndex < 0) return `请先用 resolve_outline_reference 定位“${volumeReference}”对应的真实大纲节点。`
    const resolved = outputs[resolvedIndex]
    if (resolved.content?.includes('前两项评分相同')) return '大纲引用有歧义，请先让作者确认具体卷篇。'
    const id = Number(resolved.content?.match(/最可能命中：#(\d+)/)?.[1])
    if (!id) {
      if (resolved.content?.includes('没有节点匹配') && /(?:未找到|没有|无法定位).{0,20}(?:卷|篇|节点|序篇)/.test(answer)) return null
      return '尚未定位到可用于正文抽样的大纲节点，请说明查证结果。'
    }
    const scopedIndex = outputs.findIndex((output, index) => index > resolvedIndex
      && output.name === 'sample_project_prose' && output.ok === true
      && output.arguments?.outlineNodeId === id)
    if (scopedIndex < 0) return `请以 outlineNodeId=${id} 调用 sample_project_prose，只评价“${volumeReference}”的正文。`
    sampleScopeId = id
  }
  const samples = outputs.filter(output => output.name === 'sample_project_prose' && output.ok === true
    && (sampleScopeId == null || output.arguments?.outlineNodeId === sampleScopeId))
  if (samples.some(output => output.content?.includes('可评价样本') && !output.content.includes('样本 0'))) return null
  if (samples.some(output => output.content?.includes('样本 0'))
    && /(?:没有|尚无|为空|无可用|不足).{0,18}(?:正文|样本|证据)|(?:无法|不能|不足以).{0,18}评价/.test(answer)) return null
  return '文章评价缺少正文抽样证据。请调用 sample_project_prose；若样本为 0，只能说明当前正文不足以评价。'
}

/** 文章质量问题需要正文证据；进度和字数问题仍可用项目概况回答。 */
export function isProseQualityQuestion(request: string): boolean {
  return /(?:文章|小说|正文|文笔|文风|情节|剧情|节奏|叙事|对白|对话|人物塑造).{0,18}(?:怎么样|如何|好不好|质量|评价|评估|点评|分析|写得|写的)/.test(request)
    || /(?:写得|写的).{0,8}(?:怎么样|如何|好不好)/.test(request)
}

export function isMapEvidenceQuestion(request: string): boolean {
  return /地图|原图|地图标注|地理位置|方位|路线|怎么走|相邻|相距/.test(request)
}

export function mapEvidenceValidation(answer: string, transcript: readonly ChatMessage[], request: string): string | null {
  if (!isMapEvidenceQuestion(request)) return null
  const outputs = transcript.flatMap(message => {
    if (message.role !== 'user' || !message.content.startsWith('【只读工具结果】')) return []
    try { return JSON.parse(message.content.split('\n')[1]) as Array<{ name?: string; ok?: boolean; content?: string }> }
    catch { return [] }
  })
  const read = outputs.find(output => output.name === 'read_map_facts' && output.ok === true)
  if (!read) return '地图相关问题请先调用 read_map_facts 核对当前世界已确认事实。'
  if (/(?:我|已|从).{0,10}(?:看图|查看原图|观察图片)/.test(answer)) {
    return '普通问答未读取原图，不得声称已经看过图片；如需查漏请引导作者到地图页显式启动视觉分析。'
  }
  if (read.content?.includes('还有未展示条目') && /(?:已核查|已检查|涵盖).{0,8}(?:全部|所有)|全面核查/.test(answer)) {
    return '地图摘要没有覆盖全部条目，请说明已读范围或继续分页读取。'
  }
  return null
}

/** 确认问句式："这样行不行""对吗""妥不妥"——作者在求判断，不是在下修改指令。 */
const CONFIRM_QUESTION = /(?:行不行|好不好|对不对|可不可以|能不能|妥不妥|中不中|行吗|好吗|对吗)/
/** 反问/征询："要不要…""该不该…""需不需要…"。 */
const CONSULT_QUESTION = /(?:要不要|该不该|需不需要|是否需要|值不值得|有没有必要)/

export function isProjectReadOnlyQuestion(request: string): boolean {
  if (/(?:创建|生成|新增|修改|重做|续写|扩写|写入|采纳|删除|覆盖)/.test(request)) return false
  if (/(?:刚才|之前|前面|上轮|先前)/.test(request)
    && !/(?:项目|角色|人物|世界|设定|大纲|卷|章|正文|剧情|伏笔|物品|时间线)/.test(request)) return false
  if (CONFIRM_QUESTION.test(request) || CONSULT_QUESTION.test(request)) return true
  return /[？?]|哪些|多少|是什么|怎么样|如何|为什么|查询|查看|展示|读取|检索|盘点|列出|列举|总结|概括|审计|审阅|分析|检查|评估|对比|梳理/.test(request)
}

/** 主入口通用只读问答：记忆经登记源装配，项目事实仅经 Tool Registry 获取。 */
export async function answerProjectQuestion(input: {
  projectId: number
  worldGroupId: number | null
  request: string
  conversationId: number
  historyBeforeSequence: number
  budget: AgentTeamBudgetTracker
  signal?: AbortSignal
}, dependencies: {
  complete?: (messages: ChatMessage[]) => Promise<string>
} = {}): Promise<string> {
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
    inputBudgetMaxTokens: 3500,
  })
  const result = await runReadOnlyAgent({
    goal: [memory.text, `【本轮用户问题】\n${input.request}`].filter(Boolean).join('\n\n'),
    systemPrompt: `${buildAgentProtocolSystemPrompt()}\n评价文章质量、文笔、情节或节奏时，必须调用 sample_project_prose 读取正文；作者点名卷/篇时先用 resolve_outline_reference 定位节点，再传 outlineNodeId 抽样；点名某章时传 chapterId。根据实际样本给出具体优点、问题、改进建议和样本范围；样本 0 时说明无法评价，不用字数进度代替质量评价。\n地图相关问答先调用 read_map_facts；普通问答只能读取作者已确认的结构化地图事实，不能声称已看原图，原图查漏需作者在地图页显式发送给视觉模型。`,
    context: {
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      provider: config.provider,
      model: config.model,
    },
    limits: { maxSteps: 6, maxToolCalls: 7, maxTotalTokens: 70_000 },
    signal: input.signal,
    validateFinal: async (answer, transcript) => (
      isProseQualityQuestion(input.request)
        ? proseSampleValidation(answer, transcript, input.request)
        : mapEvidenceValidation(answer, transcript, input.request)
    ),
    model: {
      complete: async messages => {
        const reservation = input.budget.reserveCall({
          label: '主 Agent 项目只读问答',
          messages,
          maxOutputTokens: 2_000,
        })
        try {
          const content = dependencies.complete
            ? await dependencies.complete(messages)
            : await chat(messages, config, {
                category: 'agent.orchestrator.read',
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
  if (result.status !== 'completed' || !result.events.some(event => event.type === 'tool' && event.ok)
    || (isProseQualityQuestion(input.request)
      && proseSampleValidation(result.answer, result.transcript, input.request))) {
    throw new Error('只读查询未能取得足够的项目证据，请缩小问题范围后重试。')
  }
  return result.answer
}
