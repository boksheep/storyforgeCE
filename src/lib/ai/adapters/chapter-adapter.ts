import type { ChatMessage } from '../../types'
import { usePromptStore } from '../../../stores/prompt'
import { renderPrompt } from '../prompt-engine'
import {
  CONTINUITY_CORE_END,
  CONTINUITY_CORE_START,
} from '../chapter-memory/continuity-envelope'
import { appendSimplifiedChineseOutputConstraint } from './prompt-guards'

export interface RunOptions {
  parameterValues?: Record<string, unknown>
  overrides?: { systemPrompt?: string; userPromptTemplate?: string }
  continuity?: {
    handoff?: string
    planReconciliation?: string
    previousTail?: string
    recentSummaries?: string
  }
  continuityBudgetTokens?: number
  /** 仅用于冻结旧生产基线，正常创作不得设置。 */
  skipContinuityEnvelope?: boolean
}

const QUARANTINED_GENERATION_MARKERS = ['未来计划', '尚未发生', '异世界档案']

/**
 * Planning-only and foreign-world sentences can remain available to planning
 * tools, but prose generation must not see them as competing current canon.
 */
export function sanitizeProseGenerationContext(text: string): string {
  if (!text) return text
  const chunks = text.match(/[^。！？\n]*[。！？\n]?/gu) ?? [text]
  return chunks
    .filter(chunk => !QUARANTINED_GENERATION_MARKERS.some(marker => chunk.includes(marker)))
    .join('')
    .trim()
}

function trimPart(text: string, maxChars: number, keepTail = false): string {
  if (!text || text.length <= maxChars) return text
  return keepTail
    ? `…（前部压缩）\n${text.slice(-maxChars)}`
    : `${text.slice(0, maxChars)}\n…（后部压缩）`
}

function buildContinuityEnvelope(args: {
  task: string
  continuity?: RunOptions['continuity']
  currentDraftTail?: string
  budgetTokens?: number
}): string {
  const budget = Math.max(1200, args.budgetTokens ?? 3200)
  const approxChars = Math.floor(budget * 0.62)
  const taskChars = Math.max(180, Math.floor(approxChars * 0.15))
  const memoryCount = Number(!!args.continuity?.handoff) + Number(!!args.continuity?.planReconciliation)
  const memoryPoolChars = Math.max(240, Math.floor(approxChars * 0.25))
  const memoryPartChars = memoryCount > 0 ? Math.floor(memoryPoolChars / memoryCount) : 0
  const tailPoolChars = Math.max(400, Math.floor(approxChars * 0.4))
  const hasPreviousTail = !!args.continuity?.previousTail
  const hasCurrentDraftTail = !!args.currentDraftTail
  const tailCount = Number(hasPreviousTail) + Number(hasCurrentDraftTail)
  const tailChars = tailCount > 0 ? Math.floor(tailPoolChars / tailCount) : 0
  const summaryChars = Math.max(180, approxChars - taskChars - memoryPoolChars - tailPoolChars)
  const parts = [
    CONTINUITY_CORE_START,
    `【本章任务与章纲】\n${trimPart(args.task, taskChars)}`,
  ]
  if (args.continuity?.handoff) {
    parts.push(`【直接前驱 handoff】\n${trimPart(args.continuity.handoff, memoryPartChars)}`)
  }
  if (args.continuity?.planReconciliation) {
    parts.push(`【前章实际进展与计划冲突】\n${trimPart(args.continuity.planReconciliation, memoryPartChars)}`)
  }
  if (args.continuity?.previousTail) {
    parts.push(`【直接前驱真实 tail】\n${trimPart(args.continuity.previousTail, tailChars, true)}`)
  }
  if (args.currentDraftTail) {
    parts.push(`【当前正文续写锚点】\n${trimPart(args.currentDraftTail, tailChars, true)}`)
  }
  if (args.continuity?.recentSummaries) {
    parts.push(`【当前世界最近 verified summaries】\n${trimPart(args.continuity.recentSummaries, summaryChars)}`)
  }
  parts.push(
    '硬约束执行协议：先在内部逐项核对保护块中的事实、动作、禁令与人物限制；必须在正文前 40% 用明确可观察的行动逐项落实，不得只暗示、遗漏或改成相反行为。',
    '篇幅纪律：优先完成本章任务终点与全部硬约束，再补充氛围和细节；不得在关键动作完成前耗尽篇幅。',
    '以上内容是最低连续性约束；不得用未来章或其他世界资料覆盖。',
    CONTINUITY_CORE_END,
  )
  return parts.join('\n\n')
}

function injectContinuityEnvelope(
  messages: ChatMessage[],
  mode: 'inherit' | 'required' | 'off' | undefined,
  envelope: string,
): ChatMessage[] {
  if (mode === 'off') return messages
  return messages.map((message, index) => (
    index === messages.length - 1 && message.role === 'user'
      ? { ...message, content: `${message.content}\n\n${envelope}` }
      : message
  ))
}

export function buildChapterContentPrompt(
  chapterTitle: string,
  chapterSummary: string,
  worldContext: string,
  characterContext: string,
  previousChapterEnding: string,
  worldRulesContext?: string,
  userHint?: string,
  options?: RunOptions,
): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.content')
  const safeWorldContext = options?.skipContinuityEnvelope
    ? worldContext
    : sanitizeProseGenerationContext(worldContext)
  const { messages } = renderPrompt(tpl, {
    chapterTitle,
    chapterSummary,
    worldContext: safeWorldContext || '（暂无）',
    characters: characterContext || '（暂无角色设定）',
    previousChapterEnding: options?.continuity ? '（见文末连续性保护块）' : (previousChapterEnding || '（这是第一章）'),
    worldRulesContext: worldRulesContext || '',
    userHint,
  }, options)
  const envelope = buildContinuityEnvelope({
    task: `${chapterTitle}\n${chapterSummary}`,
    continuity: options?.continuity,
    budgetTokens: options?.continuityBudgetTokens,
  })
  const guarded = appendSimplifiedChineseOutputConstraint(messages)
  return options?.skipContinuityEnvelope
    ? guarded
    : injectContinuityEnvelope(guarded, tpl.continuityMode, envelope)
}

export function buildContinuePrompt(
  existingContent: string,
  chapterSummary: string,
  worldContext: string,
  userHint?: string,
  options?: RunOptions,
): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.continue')
  const safeWorldContext = options?.skipContinuityEnvelope
    ? worldContext
    : sanitizeProseGenerationContext(worldContext)
  const { messages } = renderPrompt(tpl, {
    chapterSummary,
    worldContext: safeWorldContext || '（暂无）',
    existingContent: existingContent.slice(-3000),
    userHint,
  }, options)
  const envelope = buildContinuityEnvelope({
    task: chapterSummary,
    continuity: options?.continuity,
    currentDraftTail: existingContent.slice(-1600),
    budgetTokens: options?.continuityBudgetTokens,
  })
  const guarded = appendSimplifiedChineseOutputConstraint(messages)
  return options?.skipContinuityEnvelope
    ? guarded
    : injectContinuityEnvelope(guarded, tpl.continuityMode, envelope)
}

function editSourceText(targetText: string, fullChapterText?: string): string {
  if (!fullChapterText || fullChapterText === targetText) return targetText
  return `【本次处理片段】\n${targetText}\n\n【本章全文（仅作上下文，禁止改写未选中的部分）】\n${fullChapterText}`
}

function ensureEditInstruction(messages: ChatMessage[], instruction: string): ChatMessage[] {
  // 自定义模板可能省略 instruction/userHint；会话级协商要求不能因此静默丢失。
  // 只检查 user 消息，避免 system 模板恰好复述变量说明而误判已注入。
  if (messages.some(message => message.role === 'user' && message.content.includes(instruction))) return messages
  return [...messages, { role: 'user', content: `【本次编辑要求】\n${instruction}` }]
}

export function buildPolishPrompt(text: string, instruction: string, options?: RunOptions, fullChapterText?: string): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.polish')
  const editInstruction = `${instruction}\n只返回【本次处理片段】的润色结果，不要返回本章全文。`
  const { messages } = renderPrompt(tpl, { text: editSourceText(text, fullChapterText), instruction: editInstruction }, options)
  return ensureEditInstruction(messages, editInstruction)
}

export function buildExpandPrompt(text: string, hint?: string, options?: RunOptions, fullChapterText?: string): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.expand')
  const editInstruction = `${hint || ''}\n只返回【本次处理片段】的扩写结果，不要返回本章全文。`
  const { messages } = renderPrompt(tpl, { text: editSourceText(text, fullChapterText), userHint: editInstruction }, options)
  return ensureEditInstruction(messages, editInstruction)
}

export function buildDeAIPrompt(text: string, options?: RunOptions): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.de-ai')
  const { messages } = renderPrompt(tpl, { text }, options)
  return messages
}
